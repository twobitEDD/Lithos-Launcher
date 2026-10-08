import {
  ERGO_DB_LABEL,
  ergoDb,
  type Network,
  type NetworkState,
  type ProcId,
  type ReleaseList,
  type TaskId,
  type TaskProgress
} from '@shared/types'
import {
  chainDb,
  defaultErgo,
  detectErgo,
  ergoUpdate,
  installedErgo,
  installErgo,
  listErgoReleases,
  removeOtherErgo,
  type ErgoRelease
} from './ergo'
import { HELLO_HASH, readNodeSettings, writeNodeConf } from './ergoConf'
import { detectJre, installJre } from './java'
import { layout } from './layout'
import {
  clientUpdate,
  detectClient,
  installClient,
  installedClients,
  listClientReleases,
  removeOtherClients,
  type ClientRelease
} from './lithosClient'
import { pinnedVersion, updateSettings } from './settings'
import { errorMessage } from './util'
import type { Vault } from './vault'

/** GitHub allows 60 unauthenticated API calls an hour, so release lists are reused for a while. */
const RELEASES_TTL_MS = 30 * 60_000

/** Installs whatever is missing for a network. State is read from disk, never cached. */
export class Installer {
  private busy = false
  private readonly releaseCache = new Map<string, { at: number; list: Promise<unknown> }>()

  constructor(
    private readonly root: string,
    private readonly vault: Vault,
    private readonly emit: (p: TaskProgress) => void
  ) {}

  /** An install or version switch is running. */
  get installing(): boolean {
    return this.busy
  }

  private nodeDir = (network: Network): string => layout.nodeDir(this.root, network)
  private clientDir = (network: Network): string => layout.clientDir(this.root, network)

  async state(network: Network): Promise<NetworkState> {
    const [java, ergo, client, nodeSettings] = await Promise.all([
      detectJre(this.root),
      detectErgo(this.nodeDir(network), pinnedVersion(network, 'node')),
      detectClient(this.clientDir(network), pinnedVersion(network, 'client')),
      readNodeSettings(this.root, network)
    ])
    return {
      network,
      folder: layout.netDir(this.root, network),
      java: { installed: java !== null, version: java },
      node: { installed: ergo !== null, version: ergo?.version ?? null, apiPort: nodeSettings.apiPort },
      client: { installed: client !== null, version: client?.version ?? null }
    }
  }

  async install(network: Network): Promise<NetworkState> {
    await this.exclusive(async () => {
      if (!(await detectJre(this.root))) {
        await this.run('java', () => installJre(this.root, this.emit))
      }
      const nodeDir = this.nodeDir(network)
      if (!(await detectErgo(nodeDir))) {
        await this.run('node', async () => {
          this.emit({ task: 'node', phase: 'resolving' })
          // An imported chain decides the database; otherwise Ergo's stable line.
          const dataDb = await chainDb(layout.nodeDataDir(this.root, network))
          const release = defaultErgo(await this.ergoReleases(false), dataDb)
          if (!release) {
            throw new Error(`No Ergo node release for ${dataDb ? ERGO_DB_LABEL[dataDb] : 'this network'} was found`)
          }
          await installErgo(nodeDir, release, this.emit)
          await this.unpin(network, 'node')
        })
      }
      await writeNodeConf(this.root, network, this.vault.getNodeKey(network)?.hash ?? HELLO_HASH)
      const clientDir = this.clientDir(network)
      if (!(await detectClient(clientDir))) {
        await this.run('client', async () => {
          this.emit({ task: 'client', phase: 'resolving' })
          const release = (await this.clientReleases(network, false))[0]
          if (!release) throw new Error(`No Lithos Client release was found for ${network}`)
          await installClient(clientDir, release, this.emit)
          await this.unpin(network, 'client')
        })
      }
    })
    return this.state(network)
  }

  async releases(network: Network, id: ProcId, recheck: boolean): Promise<ReleaseList> {
    const state = await this.state(network)
    const active = state[id].version
    if (id === 'node') {
      const [list, dataDb] = await Promise.all([
        this.ergoReleases(recheck),
        chainDb(layout.nodeDataDir(this.root, network))
      ])
      return {
        id,
        network,
        releases: list.map((r) => ({ version: r.version, publishedAt: r.publishedAt, size: r.size, db: ergoDb(r.version) })),
        active,
        update: active ? ergoUpdate(list, active) : null,
        dataDb
      }
    }
    const list = await this.clientReleases(network, recheck)
    return {
      id,
      network,
      releases: list.map((r) => ({ version: r.version, publishedAt: r.publishedAt, size: r.size, db: null })),
      active,
      update: active ? clientUpdate(list, active) : null,
      dataDb: null
    }
  }

  /** Downloads `version` if it isn't installed yet, and makes it the one the launcher runs. */
  async fetchVersion(network: Network, id: ProcId, version: string): Promise<void> {
    await this.exclusive(async () => {
      if (id === 'node') {
        const dataDb = await chainDb(layout.nodeDataDir(this.root, network))
        const db = ergoDb(version)
        if (dataDb && db && db !== dataDb) {
          throw new Error(
            `This node's chain data is stored in ${ERGO_DB_LABEL[dataDb]}, and Ergo ${version} uses ` +
              `${ERGO_DB_LABEL[db]}, so it can't read it. Pick a ${ERGO_DB_LABEL[dataDb]} version instead.`
          )
        }
        const nodeDir = this.nodeDir(network)
        if (!(await installedErgo(nodeDir)).some((i) => i.version === version)) {
          const release = (await this.ergoReleases(false)).find((r) => r.version === version)
          if (!release) throw new Error(`Ergo ${version} can't be installed by the launcher`)
          await this.run('node', () => installErgo(nodeDir, release, this.emit))
        }
      } else {
        const clientDir = this.clientDir(network)
        if (!(await installedClients(clientDir)).some((c) => c.version === version)) {
          const release = (await this.clientReleases(network, false)).find((r) => r.version === version)
          if (!release) throw new Error(`Lithos Client ${version} is not a ${network} release`)
          await this.run('client', () => installClient(clientDir, release, this.emit))
        }
      }
      await updateSettings((s) => {
        s.versions = { ...s.versions, [network]: { ...s.versions?.[network], [id]: version } }
      })
    })
  }

  /** Removes the node or client versions the launcher no longer runs. Files still in use are left. */
  async prune(network: Network, id: ProcId): Promise<void> {
    const active = (await this.state(network))[id].version
    if (!active) return
    if (id === 'node') await removeOtherErgo(this.nodeDir(network), active)
    else await removeOtherClients(this.clientDir(network), active)
  }

  private async unpin(network: Network, id: ProcId): Promise<void> {
    if (!pinnedVersion(network, id)) return
    await updateSettings((s) => {
      delete s.versions?.[network]?.[id]
    })
  }

  private ergoReleases(recheck: boolean): Promise<ErgoRelease[]> {
    return this.cached('node', recheck, listErgoReleases)
  }

  private clientReleases(network: Network, recheck: boolean): Promise<ClientRelease[]> {
    return this.cached(`client:${network}`, recheck, () => listClientReleases(network))
  }

  private cached<T>(key: string, recheck: boolean, load: () => Promise<T>): Promise<T> {
    const hit = this.releaseCache.get(key)
    if (hit && !recheck && Date.now() - hit.at < RELEASES_TTL_MS) return hit.list as Promise<T>
    const list = load()
    this.releaseCache.set(key, { at: Date.now(), list })
    // A failed lookup isn't kept, so the next one asks GitHub again.
    list.catch(() => {
      if (this.releaseCache.get(key)?.list === list) this.releaseCache.delete(key)
    })
    return list
  }

  private async exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error('An install is already in progress')
    this.busy = true
    try {
      await fn()
    } finally {
      this.busy = false
    }
  }

  private async run(task: TaskId, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      this.emit({ task, phase: 'error', message: errorMessage(err) })
      throw err
    }
  }
}
