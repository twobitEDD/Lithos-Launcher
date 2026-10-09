import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { NodeStartupTracker, SLOW_POLL_WINDOW_MS } from '@shared/nodeStartup'
import { buildNodeSyncDetails } from '@shared/syncDetails'
import { ERGO_DB_LABEL, ergoDb, type LogChunk, type Network, type NodeInfo, type NodeSyncDetails } from '@shared/types'
import { chainDb, detectErgo } from './ergo'
import { diagnose } from './diagnose'
import { HELLO_HASH, HELLO_KEY, MANAGED_NODE_KEYS, readNodeSettings, writeNodeConf } from './ergoConf'
import { interrupt } from './interrupt'
import { detectJre } from './java'
import { ownIpv4Addresses, physicalLanIfaces } from './lanDiscover'
import { heapPlan, javaEnv, layout } from './layout'
import { customOverrides } from './managedBlock'
import { resolveNodeStart } from './nodeStart'
import { NodeApi } from './nodeApi'
import { NODE_STOP_TIMEOUT_MS, STOPPING_DETAIL, stopNodeGracefully } from './nodeStop'
import { ManagedProcess } from './process'
import { pinnedVersion } from './settings'
import { errorMessage, isPortListening, sleep } from './util'
import type { Vault } from './vault'

const API_STARTUP_TIMEOUT_MS = 5 * 60_000
const SHUTDOWN_TIMEOUT_MS = NODE_STOP_TIMEOUT_MS
const POLL_MS = 5000
/**
 * While the node logs "Readers are not initialized yet", every API call adds more of those lines
 * and nothing useful comes back, so the poll slows down and asks only /info.
 */
const POLL_STARTUP_MS = 10_000
/** A node busy with its first header download can be slow to answer; the start-up check stays quick. */
const POLL_INFO_TIMEOUT_MS = 8000
/** Failed polls in a row before the card says the API is not responding. */
const POLL_FAILS_BEFORE_WARNING = 3

/** How the running node's API has been answering the poll. Shown in diagnostics. */
export interface NodeApiHealth {
  port: number | null
  polling: boolean
  lastOkAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  failuresInARow: number
}

/** Thrown inside a start flow that a later start/stop superseded. */
class Cancelled extends Error {}

export interface NodeConnection {
  api: NodeApi
  apiKey: string
  network: Network
}

/** Runs the Ergo node. Emits 'ready' (network) once it is running and its API key is confirmed. */
export class NodeController extends EventEmitter {
  readonly proc = new ManagedProcess('node')
  private network: Network | null = null
  /** REST API port of the running node (from settings, set at start). */
  private apiPort: number | null = null
  /** The API key the running node accepts. */
  private apiKey: string | null = null
  /** Bumped by start() and stop() so an in-flight start notices it was superseded. */
  private generation = 0
  private expectExit = false
  private pollToken = 0
  private lastInfo: NodeInfo | null = null
  /** Start-up progress (state recovery, extra indexer) from the node's own log. */
  private readonly startup = new NodeStartupTracker()
  private apiHealth: NodeApiHealth = {
    port: null,
    polling: false,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
    failuresInARow: 0
  }
  /** The card detail this controller set for a silent API, so recovery only clears its own text. */
  private apiDetail: string | null = null
  private detailBeforeApi: string | null = null

  constructor(
    private readonly root: string,
    private readonly vault: Vault,
    private readonly emitInfo: (info: NodeInfo | null) => void,
    /** When another launcher on the LAN should be used, this rejects before anything is spawned. */
    private readonly beforeStart?: () => Promise<void>
  ) {
    super()
    this.proc.on('exit', (code: number | null) => this.onExit(code))
    this.proc.on('logs', (chunk: LogChunk) => this.startup.feed(chunk.lines, Date.now()))
  }

  get runningNetwork(): Network | null {
    return this.proc.alive ? this.network : null
  }

  /** The node runs as this launcher's own child process. False for an adopted node. */
  get owned(): boolean {
    return this.proc.alive && this.proc.state.status === 'running' && this.proc.state.pid !== null
  }

  /** API access to the running node, or null unless it is fully up. */
  connection(): NodeConnection | null {
    if (this.proc.state.status !== 'running' || !this.network || !this.apiKey || this.apiPort === null) return null
    return { api: new NodeApi(this.apiPort), apiKey: this.apiKey, network: this.network }
  }

  get info(): NodeInfo | null {
    return this.lastInfo
  }

  get health(): NodeApiHealth {
    return { ...this.apiHealth }
  }

  async start(network: Network): Promise<void> {
    const status = this.proc.state.status
    if (this.proc.alive || status === 'starting' || status === 'running' || status === 'stopping') {
      throw new Error('The node is already running')
    }
    if (this.beforeStart) await this.beforeStart()
    const gen = ++this.generation
    this.network = network
    this.apiPort = null
    this.proc.setState({ network, status: 'starting', detail: 'Checking install', exitCode: null, stray: false })

    try {
      if (!(await detectJre(this.root))) throw new Error('Java is not installed yet')
      const ergo = await detectErgo(layout.nodeDir(this.root, network), pinnedVersion(network, 'node'))
      if (!ergo) throw new Error('The Ergo node is not installed yet')
      await this.checkDatabase(network, ergo.version)
      const { apiPort: port } = await readNodeSettings(this.root, network)
      this.apiPort = port
      const portOpen = await isPortListening(port)
      this.check(gen)
      const known = this.vault.getNodeKey(network)
      const keys = [...new Set([known?.key, HELLO_KEY].filter((key): key is string => Boolean(key)))]
      const decision = await resolveNodeStart({
        portOpen,
        keys: portOpen ? keys : [],
        accepts: (key) => new NodeApi(port).accepts(key).catch(() => false)
      })
      if (decision.action === 'adopt') {
        this.adoptRunning(network, decision.apiKey, port, gen)
        if (known && decision.apiKey === known.key) {
          this.proc.setState({ stray: true })
          this.proc.log('A node this launcher started earlier is still running in the background.')
        }
        return
      }
      if (decision.action === 'busy') {
        throw new Error(`Port ${port} is already in use. Another Ergo node may be running.`)
      }
      this.check(gen)

      const stored = this.vault.getNodeKey(network)
      await writeNodeConf(this.root, network, stored?.hash ?? HELLO_HASH)
      await this.warnAboutOverrides(network)
      this.apiKey = stored?.key ?? HELLO_KEY
      await this.launch(network, ergo.version, ergo.jar, port, gen)
      if (!stored) await this.rekey(network, ergo.version, ergo.jar, port, gen)

      this.proc.setState({ status: 'running', detail: null, ports: { api: port } })
      this.proc.log('Node is running')
      this.startPolling(port)
      this.emit('ready', network)
    } catch (err) {
      if (err instanceof Cancelled || gen !== this.generation) {
        // stop() ran mid-start. If it found nothing to stop yet, clean up here.
        if (this.proc.alive && this.proc.state.status !== 'stopping') {
          this.proc.setState({ status: 'stopping', detail: STOPPING_DETAIL })
          await this.shutdownProcess()
        }
        return
      }
      let message = errorMessage(err)
      if (message.startsWith('The node exited during startup')) {
        message = diagnose('node', this.proc.snapshot().lines) ?? message
      }
      this.proc.log(message)
      if (this.proc.alive) await this.shutdownProcess()
      const crashed = this.proc.state.status === 'crashed'
      this.proc.setState({ status: crashed ? 'crashed' : 'stopped', pid: null, detail: message })
      throw err
    }
  }

  /**
   * Replaces the node's API key with `chosen`, or a fresh random one: the running node hashes it, and
   * restarts once so only the new key works. Anything holding the old key (the Lithos Client) must
   * be stopped first.
   */
  async replaceKey(network: Network, chosen: string | null): Promise<void> {
    const conn = this.connection()
    if (!conn || conn.network !== network) throw new Error(`Start the ${network} node first`)
    const key = chosen ?? randomBytes(32).toString('base64url')
    const hash = await conn.api.blake2b(key)
    await this.vault.setNodeKey(network, { key, hash })
    this.proc.log('Replacing the API key. The node restarts once.')
    await this.stop()
    await this.start(network)
    const port = (await readNodeSettings(this.root, network)).apiPort
    if (!(await new NodeApi(port).accepts(key))) throw new Error('The node did not accept its new API key')
    this.proc.log('The node is using its new API key')
  }

  /**
   * A 6.0.x node can't read chain data a 6.1.x node wrote, or the other way round (LevelDB vs
   * RocksDB). This happens after importing a chain from a node on the other line.
   */
  private async checkDatabase(network: Network, version: string): Promise<void> {
    const data = await chainDb(layout.nodeDataDir(this.root, network))
    const jar = ergoDb(version)
    if (!data || !jar || data === jar) return
    throw new Error(
      `This node's chain data is stored in ${ERGO_DB_LABEL[data]}, but Ergo ${version} uses ${ERGO_DB_LABEL[jar]} ` +
        `and can't read it. Open Versions and pick a ${ERGO_DB_LABEL[data]} version of the node.`
    )
  }

  /** Logs settings added below the launcher's block that override ones the launcher relies on. */
  private async warnAboutOverrides(network: Network): Promise<void> {
    const overrides = await customOverrides(layout.ergoConf(this.root, network), MANAGED_NODE_KEYS).catch(() => [])
    if (overrides.length) {
      this.proc.log(
        `Warning: ergo.conf overrides settings the launcher relies on (${overrides.join(', ')}). ` +
          'The node or Lithos Client may not work as expected.'
      )
    }
  }

  /**
   * The API port is already open and accepted a key this launcher knows.
   * Use that node. Do not spawn another, and do not shut the existing one down.
   */
  private adoptRunning(network: Network, apiKey: string, port: number, gen: number): void {
    this.check(gen)
    this.apiKey = apiKey
    this.apiPort = port
    this.proc.setState({
      status: 'running',
      network,
      pid: null,
      exitCode: null,
      stray: false,
      detail: 'Using the node already running on this computer'
    })
    this.proc.log('Using the node already running on this computer. Not starting a second one.')
    this.startPolling(port)
    this.emit('ready', network)
  }

  /** Cleanly stops a node an earlier launcher session left running, using the stored API key. */
  async stopStray(network: Network): Promise<void> {
    const known = this.vault.getNodeKey(network)
    if (!known) throw new Error('No API key is stored for that node')
    const port = (await readNodeSettings(this.root, network)).apiPort
    this.proc.setState({ detail: 'Stopping the node left running earlier' })
    await new NodeApi(port).shutdown(known.key)
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    while (await isPortListening(port)) {
      if (Date.now() > deadline) throw new Error('The old node did not stop in time')
      await sleep(1000)
    }
    this.proc.setState({ stray: false, detail: 'The old node stopped. You can start the node now.' })
  }

  async stop(): Promise<void> {
    this.generation++ // cancels an in-progress start
    this.stopPolling()
    if (!this.proc.alive) {
      if (this.proc.state.status !== 'crashed') this.proc.setState({ status: 'stopped', detail: null })
      return
    }
    this.proc.setState({ status: 'stopping', detail: STOPPING_DETAIL })
    await this.shutdownProcess()
  }

  /**
   * Stops the node on `network` so a different keystore can be loaded.
   * An adopted node has no child process here; it is still shut down through the API,
   * because leaving it up keeps the previous wallet in memory.
   */
  async stopForWalletSwitch(network: Network): Promise<void> {
    if (this.proc.alive && this.network === network) {
      await this.stop()
      return
    }
    const port = this.apiPort ?? (await readNodeSettings(this.root, network)).apiPort
    const status = this.proc.state.status
    const inUse =
      (this.network === network || this.network === null) &&
      (status === 'running' || status === 'starting' || (await isPortListening(port)))
    if (!inUse) {
      await this.stop()
      return
    }
    const key = this.apiKey ?? this.vault.getNodeKey(network)?.key ?? null
    if (!key) throw new Error('The node is running, but this launcher cannot stop it to load the other wallet.')
    this.generation++
    this.stopPolling()
    this.proc.setState({ status: 'stopping', network, detail: STOPPING_DETAIL })
    this.proc.log('Stopping the node to load a different wallet')
    await new NodeApi(port).shutdown(key)
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    while (await isPortListening(port)) {
      if (Date.now() > deadline) throw new Error('The node did not stop in time')
      await sleep(1000)
    }
    this.network = network
    this.apiKey = key
    this.proc.setState({ status: 'stopped', pid: null, exitCode: null, detail: null, stray: false })
  }

  private check(gen: number): void {
    if (gen !== this.generation) throw new Cancelled()
  }

  private async launch(network: Network, version: string, jar: string, port: number, gen: number): Promise<void> {
    const { nodeMb } = heapPlan()
    this.proc.log(`Starting Ergo node ${version} on ${network} (max heap ${nodeMb} MB)`)
    this.startup.reset()
    this.proc.spawn({
      command: layout.javaBin(this.root),
      args: [`-Xmx${nodeMb}m`, '-Dfile.encoding=UTF-8', '-jar', jar, `--${network}`, '-c', layout.ergoConf(this.root, network)],
      cwd: layout.nodeDir(this.root, network),
      env: javaEnv(this.root)
    })
    this.proc.setState({ detail: 'Waiting for the node API' })

    const api = new NodeApi(port)
    const deadline = Date.now() + API_STARTUP_TIMEOUT_MS
    for (;;) {
      this.check(gen)
      if (!this.proc.alive) throw new Error('The node exited during startup. See the Node log for details.')
      try {
        await api.info()
        return
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('The node API did not respond within 5 minutes')
      await sleep(1000)
    }
  }

  /**
   * First start only: the node booted with the well-known "hello" key. Have it
   * hash a fresh random key, store that key, write its hash to ergo.conf and
   * restart once so the default key stops working.
   */
  private async rekey(network: Network, version: string, jar: string, port: number, gen: number): Promise<void> {
    this.proc.setState({ detail: 'Securing the API key (one-time restart)' })
    this.proc.log('First start: replacing the default API key with a private one. The node restarts once.')
    const api = new NodeApi(port)

    // Make sure the endpoint really computes blake2b256 before trusting it with the real key.
    if ((await api.blake2b(HELLO_KEY)) !== HELLO_HASH) throw new Error('The node hash check failed')
    const key = randomBytes(32).toString('base64url')
    const hash = await api.blake2b(key)
    await this.vault.setNodeKey(network, { key, hash })
    await writeNodeConf(this.root, network, hash)

    this.check(gen)
    await this.shutdownProcess()
    this.check(gen)
    this.apiKey = key
    await this.launch(network, version, jar, port, gen)
    if (!(await api.accepts(key))) throw new Error('The node did not accept its new API key')
  }

  /** Clean shutdown through the API; signals only as a fallback, a hard kill only after a timeout. */
  private async shutdownProcess(): Promise<void> {
    if (!this.proc.alive || !this.network) return
    this.expectExit = true
    const key = this.apiKey
    const port = this.apiPort
    await stopNodeGracefully({
      requestApi: key && port !== null ? () => new NodeApi(port).shutdown(key) : null,
      interrupt: async () => {
        const pid = this.proc.state.pid
        return pid !== null && this.proc.alive && (await interrupt(pid))
      },
      waitForExit: (ms) => this.proc.waitForExit(ms),
      kill: () => this.proc.kill('SIGKILL'),
      log: (line) => this.proc.log(line)
    })
  }

  private onExit(code: number | null): void {
    this.stopPolling()
    if (this.expectExit) {
      this.expectExit = false
      this.proc.log(`Node stopped${code === null ? '' : ` (exit code ${code})`}`)
      if (this.proc.state.status === 'stopping') {
        this.proc.setState({ status: 'stopped', pid: null, exitCode: code, detail: null })
      } else {
        this.proc.setState({ pid: null, exitCode: code })
      }
      return
    }
    this.proc.log(`Node exited unexpectedly (exit code ${code ?? 'unknown'})`)
    this.proc.setState({
      status: 'crashed',
      pid: null,
      exitCode: code,
      detail: diagnose('node', this.proc.snapshot().lines) ?? `The node exited unexpectedly (code ${code ?? 'unknown'})`
    })
  }

  private startPolling(port: number): void {
    const token = ++this.pollToken
    const api = new NodeApi(port)
    this.apiHealth = { port, polling: true, lastOkAt: null, lastError: null, lastErrorAt: null, failuresInARow: 0 }
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
    let slow = false
    const tick = async (): Promise<void> => {
      slow =
        (this.lastInfo === null || this.lastInfo.fullHeight === null) &&
        (this.startup.readersPending(Date.now(), SLOW_POLL_WINDOW_MS) || this.lastInfo?.startup?.restore != null)
      try {
        const [info, indexedHeight] = await Promise.all([
          api.info(POLL_INFO_TIMEOUT_MS),
          slow ? Promise.resolve(this.lastInfo?.indexedHeight ?? null) : api.indexedHeight()
        ])
        if (token !== this.pollToken) return
        const headersHeight = num(info.headersHeight)
        const fullHeight = num(info.fullHeight)
        const maxPeerHeight = num(info.maxPeerHeight)
        const syncDetails = await this.readSyncDetails(api, { headersHeight, fullHeight, maxPeerHeight }, slow)
        if (token !== this.pollToken) return
        this.lastInfo = {
          appVersion: typeof info.appVersion === 'string' ? info.appVersion : null,
          fullHeight,
          headersHeight,
          maxPeerHeight,
          peersCount: num(info.peersCount) ?? 0,
          indexedHeight,
          syncDetails,
          answeredAt: Date.now(),
          apiError: null,
          startup: this.startup.snapshot(Date.now(), { headersHeight, fullHeight })
        }
        this.apiHealth = { ...this.apiHealth, lastOkAt: Date.now(), failuresInARow: 0 }
        this.clearApiDetail()
        this.emitInfo(this.lastInfo)
      } catch (err) {
        // Node busy; try again next tick. After a few misses in a row, say so instead of showing old numbers as live.
        if (token !== this.pollToken) return
        const message = errorMessage(err)
        const failures = this.apiHealth.failuresInARow + 1
        this.apiHealth = { ...this.apiHealth, lastError: message, lastErrorAt: Date.now(), failuresInARow: failures }
        if (failures === POLL_FAILS_BEFORE_WARNING) {
          this.proc.log(`The node API on 127.0.0.1:${port} has not answered ${failures} times in a row: ${message}`)
        }
        if (failures >= POLL_FAILS_BEFORE_WARNING) {
          this.setApiDetail(`The node API on 127.0.0.1:${port} is not responding (${message})`)
          if (this.lastInfo) {
            this.lastInfo = { ...this.lastInfo, apiError: message }
            this.emitInfo(this.lastInfo)
          }
        }
      }
      if (token === this.pollToken) setTimeout(tick, slow ? POLL_STARTUP_MS : POLL_MS)
    }
    void tick()
  }

  private setApiDetail(text: string): void {
    if (this.proc.state.status !== 'running') return
    if (this.apiDetail === null) this.detailBeforeApi = this.proc.state.detail
    else if (this.proc.state.detail !== this.apiDetail) return
    this.apiDetail = text
    this.proc.setState({ detail: text })
  }

  private clearApiDetail(): void {
    if (this.apiDetail === null) return
    if (this.proc.state.detail === this.apiDetail) this.proc.setState({ detail: this.detailBeforeApi })
    this.apiDetail = null
    this.detailBeforeApi = null
  }

  /**
   * Peer list and block-body traffic for the sync-details panel.
   * A failed peer call still leaves headers and full height in place.
   */
  private async readSyncDetails(
    api: NodeApi,
    heights: { headersHeight: number | null; fullHeight: number | null; maxPeerHeight: number | null },
    skipPeers = false
  ): Promise<NodeSyncDetails> {
    const blank = { syncInfo: null as unknown, connected: null as unknown, track: null as unknown }
    if (!this.apiKey || skipPeers) {
      return buildNodeSyncDetails({
        ...heights,
        ...blank,
        ifaces: physicalLanIfaces(),
        own: ownIpv4Addresses()
      })
    }
    const [syncInfo, connected, track] = await Promise.allSettled([
      api.peerSyncInfo(this.apiKey),
      api.connectedPeers(this.apiKey),
      api.peerTrackInfo(this.apiKey)
    ])
    return buildNodeSyncDetails({
      ...heights,
      syncInfo: syncInfo.status === 'fulfilled' ? syncInfo.value : null,
      connected: connected.status === 'fulfilled' ? connected.value : null,
      track: track.status === 'fulfilled' ? track.value : null,
      ifaces: physicalLanIfaces(),
      own: ownIpv4Addresses()
    })
  }

  private stopPolling(): void {
    this.pollToken++
    this.apiHealth = { ...this.apiHealth, polling: false }
    this.apiDetail = null
    this.detailBeforeApi = null
    if (this.lastInfo) {
      this.lastInfo = null
      this.emitInfo(null)
    }
  }
}
