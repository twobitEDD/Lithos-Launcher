import { readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { ergoDb, type Network, type ProcState } from '@shared/types'
import {
  CHAIN_SEED_DOWNLOAD_PATH,
  CHAIN_SEED_PATH,
  CHAIN_SEED_PORT,
  chainSeedAllowed,
  fullHistoryVerdict,
  historyCheckHeights,
  isPrivateIpv4,
  parseHistoryConf,
  plainIpv4,
  type ChainManifest,
  type ChainSeedAdvert
} from '../shared/chainCopy.ts'
import { chainDb } from './ergo'
import { physicalLanIfaces } from './lanDiscover'
import { layout } from './layout'
import type { NodeController } from './nodeController'
import { chainBytes, makeSnapshot, removeLeftovers, SNAPSHOT_PREFIX, writeSnapshotTar } from './chainSnapshot.ts'
import { settings, updateSettings } from './settings'
import { errorMessage } from './util'

const REBIND_MS = 60_000
const ADVERT_MS = 5 * 60_000
/** A seed pauses its node at most this often, whoever asks. */
const PAUSE_COOLDOWN_MS = 10 * 60_000

function blankAdvert(note: string | null): ChainSeedAdvert {
  return {
    v: 1,
    app: 'lithos-launcher',
    available: false,
    network: null,
    nodeVersion: null,
    db: null,
    stateType: null,
    fullHeight: null,
    headersHeight: null,
    fullHistory: false,
    historyNote: note,
    chainBytes: null,
    busy: false
  }
}

export interface SeedState {
  serving: boolean
  fullHistory: boolean
  note: string | null
  sendingTo: string | null
}

/**
 * Lets other launchers on this LAN copy this computer's chain. Listens only on LAN adapters and
 * answers only private addresses. A copy pauses this launcher's own node for the seconds it takes
 * to hardlink the chain, then restarts it; a node this launcher adopted is never stopped.
 */
export class ChainSeedService {
  private servers = new Map<string, Server>()
  private advert: ChainSeedAdvert = blankAdvert('node not running')
  private sendingTo: string | null = null
  private lastPause = 0
  private bytesCache: { network: Network; at: number; bytes: number } | null = null
  private timers: NodeJS.Timeout[] = []
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void
  ) {}

  get enabled(): boolean {
    return chainSeedAllowed(settings().lanChainSeed)
  }

  state(): SeedState {
    return {
      serving: this.enabled && this.servers.size > 0,
      fullHistory: this.advert.fullHistory,
      note: this.advert.available ? this.advert.historyNote : this.advert.historyNote ?? 'node not running',
      sendingTo: this.sendingTo
    }
  }

  attach(): void {
    for (const network of ['mainnet', 'testnet'] as const) {
      void removeLeftovers(dirname(layout.nodeDataDir(this.root, network)), [SNAPSHOT_PREFIX])
    }
    this.node.on('ready', () => void this.refreshAdvert())
    this.node.proc.on('state', (state: ProcState) => {
      if (state.status !== 'running' && !this.sendingTo) {
        this.advert = blankAdvert('node not running')
        this.onChange()
      }
    })
    this.timers.push(setInterval(() => this.rebind(), REBIND_MS))
    this.timers.push(setInterval(() => void this.refreshAdvert(), ADVERT_MS))
    this.rebind()
  }

  async setEnabled(on: boolean): Promise<void> {
    await updateSettings((next) => {
      next.lanChainSeed = on
    })
    this.rebind()
    if (on) void this.refreshAdvert()
    this.onChange()
  }

  /** One server per LAN address, so nothing listens on loopback, Docker, or VPN adapters. */
  private rebind(): void {
    const want = new Set(this.enabled ? physicalLanIfaces().map((iface) => iface.address) : [])
    for (const [address, server] of this.servers) {
      if (!want.has(address)) {
        server.close()
        this.servers.delete(address)
      }
    }
    for (const address of want) {
      if (this.servers.has(address)) continue
      const server = createServer((req, res) => void this.handle(req, res))
      server.headersTimeout = 10_000
      server.requestTimeout = 30_000
      server.maxConnections = 8
      server.once('error', (err) => {
        this.servers.delete(address)
        this.log(`Chain seed could not listen on ${address}:${CHAIN_SEED_PORT}: ${errorMessage(err)}`)
        this.onChange()
      })
      server.listen(CHAIN_SEED_PORT, address)
      this.servers.set(address, server)
    }
    this.onChange()
  }

  private async refreshAdvert(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.buildAdvert()
      .then((advert) => {
        if (!this.sendingTo) this.advert = advert
      })
      .catch((err: unknown) => {
        this.advert = blankAdvert(`could not check the node: ${errorMessage(err)}`)
      })
      .finally(() => {
        this.refreshing = null
        this.onChange()
      })
    return this.refreshing
  }

  /** Asks the node itself whether it holds early full blocks; config alone is not trusted. */
  private async buildAdvert(): Promise<ChainSeedAdvert> {
    const conn = this.node.connection()
    if (!conn) return blankAdvert('node not running')
    const network = conn.network
    const info = await conn.api.info()
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const fullHeight = num(info.fullHeight)
    const nodeVersion = typeof info.appVersion === 'string' ? info.appVersion : null
    const stateType = typeof info.stateType === 'string' ? info.stateType : null
    const confText = await readFile(layout.ergoConf(this.root, network), 'utf8').catch(() => '')
    const checks: { height: number; hasBlock: boolean }[] = []
    for (const height of historyCheckHeights(fullHeight)) {
      checks.push({ height, hasBlock: await conn.api.hasFullBlockAt(height).catch(() => false) })
    }
    const verdict = fullHistoryVerdict({ conf: parseHistoryConf(confText), stateType, checks })
    const dataDir = layout.nodeDataDir(this.root, network)
    const db = (await chainDb(dataDir)) ?? (nodeVersion ? ergoDb(nodeVersion) : null)
    const owned = this.node.owned
    return {
      v: 1,
      app: 'lithos-launcher',
      available: owned,
      network,
      nodeVersion,
      db,
      stateType,
      fullHeight,
      headersHeight: num(info.headersHeight),
      fullHistory: verdict.full,
      historyNote: owned ? verdict.note : 'this launcher did not start that node, so it will not stop it for a copy',
      chainBytes: verdict.full ? await this.cachedBytes(network, dataDir) : null,
      busy: this.sendingTo !== null
    }
  }

  private async cachedBytes(network: Network, dataDir: string): Promise<number> {
    const cached = this.bytesCache
    if (cached && cached.network === network && Date.now() - cached.at < 30 * 60_000) return cached.bytes
    const bytes = await chainBytes(dataDir)
    this.bytesCache = { network, at: Date.now(), bytes }
    return bytes
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = plainIpv4(req.socket.remoteAddress)
    if (!remote || !isPrivateIpv4(remote) || !this.enabled) {
      res.writeHead(403).end()
      return
    }
    const path = (req.url ?? '').split('?')[0]
    try {
      if (req.method === 'GET' && path === CHAIN_SEED_PATH) {
        const body = JSON.stringify({ ...this.advert, busy: this.sendingTo !== null })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body)
        return
      }
      if (req.method === 'POST' && path === CHAIN_SEED_DOWNLOAD_PATH) {
        await this.serveCopy(remote, res)
        return
      }
      res.writeHead(404).end()
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end(errorMessage(err))
      else res.destroy()
    }
  }

  private refuse(res: ServerResponse, code: number, text: string, headers: Record<string, string> = {}): void {
    res.writeHead(code, { 'Content-Type': 'text/plain', ...headers }).end(text)
  }

  private async serveCopy(remote: string, res: ServerResponse): Promise<void> {
    if (this.sendingTo) return this.refuse(res, 503, `Busy sending the chain to ${this.sendingTo}`)
    const wait = this.lastPause + PAUSE_COOLDOWN_MS - Date.now()
    if (wait > 0) {
      return this.refuse(res, 429, 'This node was paused for a copy a few minutes ago. Try again later.', {
        'Retry-After': String(Math.ceil(wait / 1000))
      })
    }
    const network = this.node.runningNetwork
    if (!network || !this.node.owned) {
      return this.refuse(res, 409, 'This launcher did not start the running node, so it will not stop it for a copy')
    }
    if (!this.advert.fullHistory || this.advert.network !== network) {
      return this.refuse(res, 409, `This node cannot seed full history (${this.advert.historyNote ?? 'not checked yet'})`)
    }
    this.sendingTo = remote
    this.onChange()
    const dataDir = layout.nodeDataDir(this.root, network)
    const snapDir = join(dirname(dataDir), `${SNAPSHOT_PREFIX}${Date.now()}`)
    const aborted = new AbortController()
    res.once('close', () => aborted.abort())
    try {
      const heights = { full: this.node.info?.fullHeight ?? this.advert.fullHeight ?? 0, headers: this.node.info?.headersHeight ?? null }
      this.log(`Pausing the node for a moment to snapshot the chain for ${remote}`)
      this.lastPause = Date.now()
      await this.node.stop()
      let files
      try {
        files = await makeSnapshot(dataDir, snapDir)
      } finally {
        void this.node.start(network).catch((err: unknown) => this.log(`Restarting the node after the snapshot failed: ${errorMessage(err)}`))
      }
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      this.log(`Snapshot ready (${files.length} files, ${(totalBytes / 2 ** 30).toFixed(1)} GB). The node is starting again.`)
      const manifest: ChainManifest = {
        v: 1,
        network,
        nodeVersion: this.advert.nodeVersion,
        db: this.advert.db,
        fullHeight: heights.full,
        headersHeight: heights.headers,
        totalBytes,
        files
      }
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'X-Lithos-Total-Bytes': String(totalBytes) })
      const sink = async (chunk: Buffer): Promise<void> => {
        if (aborted.signal.aborted || res.destroyed) throw new Error('The other computer stopped the transfer')
        if (res.write(chunk)) return
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
        })
      }
      await writeSnapshotTar(snapDir, manifest, sink, aborted.signal)
      res.end()
      this.log(`Sent the chain to ${remote}`)
    } catch (err) {
      this.log(`Chain copy to ${remote} stopped: ${errorMessage(err)}`)
      if (!res.headersSent) this.refuse(res, 500, errorMessage(err))
      else res.destroy()
    } finally {
      await rm(snapDir, { recursive: true, force: true }).catch(() => undefined)
      this.sendingTo = null
      this.onChange()
    }
  }
}
