import { mkdir, readdir, rm } from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { DEFAULT_NODE_P2P_PORT, ergoDb, type Network } from '@shared/types'
import {
  CANCELLABLE_PHASES,
  CHAIN_COPY_MIN_GAP,
  CHAIN_SEED_DOWNLOAD_PATH,
  CHAIN_SEED_PATH,
  CHAIN_SEED_PORT,
  chainCopyAllowed,
  copyActive,
  decideChainCopy,
  parseAdvert,
  seedSkipReason,
  unreachableSeeds,
  type ChainCopyStatus,
  type ChainManifest,
  type ChainSeedAdvert,
  type CopyContext,
  type PortProbe,
  type SeedUnreachable
} from '../shared/chainCopy.ts'
import type { ChainSeedService } from './chainSeedService'
import { ASIDE_PREFIX, DOWNLOAD_PREFIX, freeBytes, receiveSnapshot, removeLeftovers, replaceChain } from './chainSnapshot.ts'
import type { ClientController } from './clientController'
import { readNodeSettings } from './ergoConf'
import { ownIpv4Addresses, physicalLanIfaces } from './lanDiscover'
import { discoverLanPeers } from './lanPeerDiscover'
import { probePeerPort, probePortDetail } from './lanPeerProbe'
import { layout } from './layout'
import { NodeApi } from './nodeApi'
import type { NodeController } from './nodeController'
import { settings, updateSettings } from './settings'
import { errorMessage, sleep } from './util'

const FIRST_SCAN_MS = 45_000
const SCAN_MS = 10 * 60_000
const SEED_ANSWER_MS = 15 * 60_000
const CONFIRM_MS = 5 * 60_000
/** A seed that failed or was cancelled is not tried again automatically for this long. */
const AVOID_MS = 6 * 60 * 60_000
/** Long enough that a slow LAN host still answers; a firewall drop runs out the full time. */
const UNREACHABLE_PROBE_MS = 2000

class CopyCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

/**
 * Watches for a LAN launcher that holds the full chain and is far ahead of this node, and copies
 * its chain over instead of syncing for days. The old chain stays until the node runs on the new
 * one; on any failure it goes back. The wallet folder is never moved, copied, or sent.
 */
export class ChainCopyCoordinator {
  private status: ChainCopyStatus
  private avoid = new Map<string, number>()
  private abort: AbortController | null = null
  /** The coordinator's own node start, which the start guard lets through. */
  private ownStart = false
  private scanning: Promise<void> | null = null
  private lastEmit = 0

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly client: ClientController,
    private readonly seed: ChainSeedService,
    private readonly emit: (status: ChainCopyStatus) => void,
    private readonly log: (line: string) => void
  ) {
    this.status = {
      copyEnabled: chainCopyAllowed(settings().lanChainCopy),
      seedEnabled: seed.enabled,
      phase: 'idle',
      from: null,
      bytesDone: 0,
      bytesTotal: null,
      etaSeconds: null,
      message: null,
      seeds: [],
      unreachable: [],
      scanning: false,
      seed: seed.state()
    }
  }

  current(): ChainCopyStatus {
    return { ...this.status, seedEnabled: this.seed.enabled, seed: this.seed.state() }
  }

  /** True while a copy owns the node; Start and auto-start wait. */
  blocksNodeStart(): boolean {
    return copyActive(this.status.phase) && !this.ownStart
  }

  attach(): void {
    for (const network of ['mainnet', 'testnet'] as const) {
      const parent = dirname(layout.nodeDataDir(this.root, network))
      void removeLeftovers(parent, [DOWNLOAD_PREFIX])
      void readdir(parent)
        .then((names) => {
          for (const name of names.filter((n) => n.startsWith(ASIDE_PREFIX))) {
            this.log(`An older chain from an earlier LAN copy is still in ${join(parent, name)}. Delete it once the node runs well.`)
          }
        })
        .catch(() => undefined)
    }
    this.node.on('ready', () => {
      setTimeout(() => void this.scan(), FIRST_SCAN_MS)
    })
    setInterval(() => {
      if (this.node.proc.state.status === 'running') void this.scan()
    }, SCAN_MS)
    this.publish({})
  }

  /** Called by the seed service when this computer's seed state changes. */
  seedChanged(): void {
    this.publish({})
  }

  async setCopyEnabled(on: boolean): Promise<ChainCopyStatus> {
    await updateSettings((next) => {
      next.lanChainCopy = on
    })
    this.publish({ copyEnabled: on })
    if (on && this.node.proc.state.status === 'running') void this.scan()
    return this.current()
  }

  async setSeedEnabled(on: boolean): Promise<ChainCopyStatus> {
    await this.seed.setEnabled(on)
    this.publish({ seedEnabled: on })
    return this.current()
  }

  async rescan(): Promise<ChainCopyStatus> {
    await this.scan()
    return this.current()
  }

  cancel(): ChainCopyStatus {
    if (CANCELLABLE_PHASES.includes(this.status.phase)) this.abort?.abort()
    return this.current()
  }

  private context(network: Network | null, freeBytesHere: number | null): CopyContext {
    const now = Date.now()
    for (const [host, until] of this.avoid) if (until < now) this.avoid.delete(host)
    const info = this.node.info
    return {
      copyEnabled: chainCopyAllowed(settings().lanChainCopy),
      nodeOwned: this.node.owned,
      network,
      localFullHeight: info?.fullHeight ?? null,
      localDb: info?.appVersion ? ergoDb(info.appVersion) : null,
      freeBytes: freeBytesHere,
      own: ownIpv4Addresses(),
      avoid: new Set(this.avoid.keys()),
      busy: copyActive(this.status.phase),
      clientRunning: this.client.proc.alive
    }
  }

  private scan(): Promise<void> {
    if (this.scanning) return this.scanning
    this.scanning = this.runScan()
      .catch((err: unknown) => this.log(`LAN chain seed lookup failed: ${errorMessage(err)}`))
      .finally(() => {
        this.scanning = null
        this.publish({ scanning: false })
      })
    return this.scanning
  }

  private async runScan(): Promise<void> {
    if (copyActive(this.status.phase)) return
    this.publish({ scanning: true })
    const own = ownIpv4Addresses()
    const open = await discoverLanPeers({
      ifaces: physicalLanIfaces(),
      own,
      port: CHAIN_SEED_PORT,
      probe: (host, port) => probePeerPort(host, port, 300)
    })
    const found: { host: string; advert: ChainSeedAdvert }[] = []
    for (const { host } of open) {
      const advert = await fetchAdvert(host)
      if (advert) found.push({ host, advert })
    }
    const network = this.node.runningNetwork
    const unreachable = await this.findUnreachable(network, own, new Set(found.map((seed) => seed.host))).catch(() => [])
    const free = network ? await freeBytes(dirname(layout.nodeDataDir(this.root, network))) : null
    const ctx = this.context(network, free)
    this.publish({
      seeds: found.map(({ host, advert }) => ({ host, advert, skip: seedSkipReason(host, advert, ctx) })),
      unreachable
    })
    const decision = decideChainCopy(found, ctx)
    // A node whose height has not been read yet might be synced; never replace it on a guess.
    if (decision.action !== 'copy' || !network || !this.node.info || this.node.runningNetwork !== network) return
    this.log(
      `${decision.host} has the full chain at height ${decision.advert.fullHeight?.toLocaleString('en-US')}, ` +
        `${CHAIN_COPY_MIN_GAP.toLocaleString('en-US')}+ blocks ahead of this node. Copying it instead of syncing.`
    )
    void this.copy(network, decision.host, decision.advert)
  }

  /**
   * LAN hosts running an Ergo node (peer port open) that did not offer a chain, probed again on the
   * seed port with a longer timeout so a firewall drop and "nothing listening" can be told apart.
   */
  private async findUnreachable(
    network: Network | null,
    own: ReadonlySet<string>,
    seedHosts: ReadonlySet<string>
  ): Promise<SeedUnreachable[]> {
    const net = network ?? settings().nodeNetwork ?? 'mainnet'
    const p2pPort = await readNodeSettings(this.root, net).then(
      (s) => s.p2pPort,
      () => DEFAULT_NODE_P2P_PORT[net]
    )
    const ergo = await discoverLanPeers({
      ifaces: physicalLanIfaces(),
      own,
      port: p2pPort,
      probe: (host, port) => probePeerPort(host, port, 300)
    })
    const hosts = ergo.map((peer) => peer.host)
    const probes = new Map<string, PortProbe>()
    await Promise.all(
      hosts
        .filter((host) => !seedHosts.has(host))
        .map(async (host) => probes.set(host, await probePortDetail(host, CHAIN_SEED_PORT, UNREACHABLE_PROBE_MS)))
    )
    return unreachableSeeds(hosts, seedHosts, probes, own)
  }

  private async copy(network: Network, host: string, advert: ChainSeedAdvert): Promise<void> {
    const dataDir = layout.nodeDataDir(this.root, network)
    const parent = dirname(dataDir)
    const stamp = Date.now()
    const newDir = join(parent, `${DOWNLOAD_PREFIX}${stamp}`)
    const asideDir = join(parent, `${ASIDE_PREFIX}${stamp}`)
    const abort = new AbortController()
    this.abort = abort
    let manifest: ChainManifest | null = null
    this.publish({ phase: 'stopping', from: host, bytesDone: 0, bytesTotal: advert.chainBytes, etaSeconds: null, message: null })
    try {
      await this.node.stop()
      if (abort.signal.aborted) throw new CopyCancelled()
      await mkdir(newDir, { recursive: true })
      this.publish({ phase: 'waiting-seed' })
      const res = await postDownload(host, abort.signal)
      const started = Date.now()
      this.publish({ phase: 'downloading' })
      manifest = await receiveSnapshot(res, newDir, (done, m) => {
        const elapsed = (Date.now() - started) / 1000
        const rate = elapsed > 5 ? done / elapsed : 0
        this.publish(
          {
            phase: 'downloading',
            bytesDone: done,
            bytesTotal: m.totalBytes,
            etaSeconds: rate > 0 ? (m.totalBytes - done) / rate : null
          },
          true
        )
      }).catch((err: unknown) => {
        throw abort.signal.aborted ? new CopyCancelled() : err
      })
      this.publish({ phase: 'verifying' })
      if (manifest.network !== network) throw new Error(`The seed sent a ${manifest.network} chain`)
    } catch (err) {
      await rm(newDir, { recursive: true, force: true }).catch(() => undefined)
      const cancelled = err instanceof CopyCancelled || abort.signal.aborted
      this.avoid.set(host, Date.now() + AVOID_MS)
      const message = cancelled
        ? 'Blockchain copy cancelled. The node continues its normal sync.'
        : `Blockchain copy from ${host} failed: ${errorMessage(err)}. The node continues its normal sync.`
      this.log(message)
      await this.startOwn(network)
      this.finish(cancelled ? 'cancelled' : 'failed', message)
      return
    }

    const target = manifest.fullHeight
    this.publish({ phase: 'swapping' })
    const result = await replaceChain({
      dataDir,
      newDir,
      asideDir,
      startNode: async () => {
        this.publish({ phase: 'starting' })
        await this.startOwn(network, true)
      },
      stopNode: async () => {
        this.publish({ phase: 'restoring' })
        await this.node.stop()
      },
      confirm: () => this.confirmHeight(network, target),
      log: this.log
    })
    await rm(newDir, { recursive: true, force: true }).catch(() => undefined)
    if (result.ok) {
      const message = `Copied the blockchain from ${host}. The node continues from height ${target.toLocaleString('en-US')}.`
      this.log(message)
      this.finish('done', message)
      return
    }
    this.avoid.set(host, Date.now() + AVOID_MS)
    const message = result.restored
      ? `The copied chain did not start (${result.error}). The old chain is back and the node continues its normal sync.`
      : `The copied chain did not start (${result.error}), and the old chain could not be put back automatically. It is in ${asideDir}.`
    this.log(message)
    this.finish('failed', message)
  }

  private async startOwn(network: Network, rethrow = false): Promise<void> {
    this.ownStart = true
    try {
      await this.node.start(network)
    } catch (err) {
      this.log(`Starting the node failed: ${errorMessage(err)}`)
      if (rethrow) throw err
    } finally {
      this.ownStart = false
    }
  }

  /** The node must report a full height close to the seed's, soon after it starts. */
  private async confirmHeight(network: Network, target: number): Promise<void> {
    const { apiPort } = await readNodeSettings(this.root, network)
    const api = new NodeApi(apiPort)
    const deadline = Date.now() + CONFIRM_MS
    let last: number | null = null
    while (Date.now() < deadline) {
      if (this.node.proc.state.status !== 'running') throw new Error('the node stopped')
      const info = await api.info().catch(() => null)
      last = typeof info?.fullHeight === 'number' ? info.fullHeight : last
      if (last !== null && last >= target - 10) return
      await sleep(3000)
    }
    throw new Error(`the node reports full height ${last ?? 'unknown'}, expected about ${target}`)
  }

  private finish(phase: 'done' | 'failed' | 'cancelled', message: string): void {
    this.abort = null
    this.publish({ phase, message, etaSeconds: null })
  }

  private publish(patch: Partial<ChainCopyStatus>, throttle = false): void {
    this.status = { ...this.status, ...patch }
    const now = Date.now()
    if (throttle && now - this.lastEmit < 500) return
    this.lastEmit = now
    this.emit(this.current())
  }
}

async function fetchAdvert(host: string): Promise<ChainSeedAdvert | null> {
  try {
    const res = await fetch(`http://${host}:${CHAIN_SEED_PORT}${CHAIN_SEED_PATH}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return parseAdvert(await res.json())
  } catch {
    return null
  }
}

/** POSTs for a copy. The seed answers once its snapshot is made, which takes as long as its node needs to stop. */
function postDownload(host: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: CHAIN_SEED_PORT, path: CHAIN_SEED_DOWNLOAD_PATH, method: 'POST', signal }, (res) => {
      if (res.statusCode === 200) {
        resolve(res)
        return
      }
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        if (text.length < 500) text += chunk
      })
      res.on('end', () => reject(new Error(text.trim() || `the seed answered HTTP ${res.statusCode}`)))
      res.on('error', reject)
    })
    req.setTimeout(SEED_ANSWER_MS, () => req.destroy(new Error('the seed stopped answering')))
    req.on('error', reject)
    req.end()
  })
}
