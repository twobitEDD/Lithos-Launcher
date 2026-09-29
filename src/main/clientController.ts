import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { syncView } from '@shared/sync'
import type { ClientStats, Network } from '@shared/types'
import { CLIENT_ENV, MANAGED_CLIENT_KEYS, readClientSettings, writeClientConf } from './clientConf'
import { diagnose } from './diagnose'
import { interrupt } from './interrupt'
import { detectJre } from './java'
import { heapPlan, javaEnv, layout } from './layout'
import { detectClient, findKeystore } from './lithosClient'
import { customOverrides } from './managedBlock'
import type { NodeController } from './nodeController'
import { ManagedProcess } from './process'
import { pinnedVersion } from './settings'
import { lanAddresses } from './system'
import { errorMessage, isPortListening, sleep } from './util'
import type { Vault } from './vault'
import type { WalletManager } from './wallet'

const HTTP_WAIT_MS = 3 * 60_000
const SHUTDOWN_TIMEOUT_MS = 60_000
const STATS_POLL_MS = 10_000

/** Thrown inside a start flow that a later start/stop superseded. */
class Cancelled extends Error {}

/** Runs the Lithos Client against the launcher's node and wallet. */
export class ClientController {
  readonly proc = new ManagedProcess('client')
  private network: Network | null = null
  /** Bumped by start() and stop() so an in-flight start notices it was superseded. */
  private generation = 0
  private expectExit = false
  private statsToken = 0
  private lastStats: ClientStats | null = null

  constructor(
    private readonly root: string,
    private readonly vault: Vault,
    private readonly node: NodeController,
    private readonly wallet: WalletManager,
    /** Development only: allow starting before the node is synced. */
    private readonly skipSyncGate: boolean,
    private readonly emitStats: (stats: ClientStats | null) => void
  ) {
    this.proc.on('exit', (code: number | null) => this.onExit(code))
  }

  get stats(): ClientStats | null {
    return this.lastStats
  }

  get runningNetwork(): Network | null {
    return this.proc.alive ? this.network : null
  }

  get httpPort(): number | null {
    return this.proc.alive ? (this.proc.state.ports?.http ?? null) : null
  }

  async start(network: Network): Promise<void> {
    const status = this.proc.state.status
    if (this.proc.alive || status === 'starting' || status === 'stopping') {
      throw new Error('The Lithos Client is already running')
    }
    const gen = ++this.generation
    this.network = network
    this.proc.setState({ network, status: 'starting', detail: 'Checking requirements', exitCode: null, ports: null })

    try {
      if (!(await detectJre(this.root))) throw new Error('Java is not installed yet')
      const client = await detectClient(layout.clientDir(this.root, network), pinnedVersion(network, 'client'))
      if (!client) throw new Error('The Lithos Client is not installed yet')
      const conn = this.node.connection()
      if (!conn || conn.network !== network) throw new Error(`Start the ${network} node first`)
      const info = this.node.info
      if (!this.skipSyncGate && (!info || syncView(info).stage !== 'synced')) {
        throw new Error('Wait until the node is fully synced and indexed')
      }
      // Verified against the node itself (not cached state) right before launch.
      await this.wallet.unlockForClient(network)
      const password = this.vault.getWalletPassword(network)
      if (!password) throw new Error('Unlock the wallet first')
      const keystore = await findKeystore(layout.keystoreDir(this.root, network))
      if (!keystore) throw new Error('No wallet keystore was found for this node')

      const settings = await readClientSettings(this.root, network)
      if (!settings.diff) throw new Error('Choose your mining difficulty first')
      const ports = { http: settings.httpPort, stratum: settings.stratumPort }
      if (await isPortListening(ports.http)) {
        throw new Error(`Port ${ports.http} (Lithos panel) is already in use. Is another Lithos Client running?`)
      }
      if (await isPortListening(ports.stratum)) {
        throw new Error(`Port ${ports.stratum} (stratum) is already in use. Is another Lithos Client running?`)
      }

      // The client's own API key is hashed by the node, like the node's key. Play's secret is random.
      let lithosKey = this.vault.getLithosKey(network)
      if (!lithosKey) {
        const key = randomBytes(32).toString('base64url')
        lithosKey = { key, hash: await conn.api.blake2b(key) }
        await this.vault.setLithosKey(network, lithosKey)
      }
      let playSecret = this.vault.getPlaySecret(network)
      if (!playSecret) {
        playSecret = randomBytes(48).toString('base64url')
        await this.vault.setPlaySecret(network, playSecret)
      }

      const lan = lanAddresses()
      await writeClientConf(this.root, {
        network,
        appHome: client.home,
        keystore,
        lithosApiKeyHash: lithosKey.hash,
        settings,
        nodeApiPort: conn.api.port,
        lanHosts: [...lan, hostname()]
      })
      const overrides = await customOverrides(layout.clientConf(this.root, network), MANAGED_CLIENT_KEYS).catch(() => [])
      if (overrides.length) {
        this.proc.log(
          `Warning: lithos.conf overrides settings the launcher manages (${overrides.join(', ')}). ` +
            'The client may not work as expected, and Settings may not show what it actually uses.'
        )
      }
      this.check(gen)

      const { clientMb } = heapPlan()
      this.proc.setRedactions([conn.apiKey, password, playSecret, lithosKey.key])
      this.proc.log(`Starting Lithos Client ${client.version} on ${network} (max heap ${clientMb} MB)`)
      this.proc.spawn({
        command: layout.javaBin(this.root),
        args: [
          `-Xmx${clientMb}m`,
          '-Dfile.encoding=UTF-8',
          `-Dconfig.file=${layout.clientConf(this.root, network)}`,
          // The launcher tracks the process itself, so no RUNNING_PID file to go stale after a crash.
          '-Dplay.server.pidfile.path=/dev/null',
          '-jar',
          client.launcherJar
        ],
        cwd: layout.clientDir(this.root, network),
        // Secrets reach the client only through its environment, never through a file.
        env: {
          ...javaEnv(this.root),
          [CLIENT_ENV.nodeKey]: conn.apiKey,
          [CLIENT_ENV.nodePass]: password,
          [CLIENT_ENV.playSecret]: playSecret
        }
      })
      this.proc.setState({ detail: 'Waiting for the Lithos Client to come up', ports: { ...ports } })

      const up = await this.waitForHttp(ports.http, gen)
      this.proc.setState({ status: 'running', detail: up ? null : 'Started, but the panel is not answering yet' })
      this.proc.log(`Lithos Client is running. Panel: http://127.0.0.1:${ports.http}  Stratum port: ${ports.stratum}`)
      if (settings.lanPanel && lan.length) {
        this.proc.log(`The panel is open to your network: ${lan.map((a) => `http://${a}:${ports.http}`).join('  ')}`)
      }
      this.proc.log(
        settings.autoCommit
          ? `Difficulty ${settings.diff}, auto-commit on`
          : `Difficulty ${settings.diff}, auto-commit off (not registered on chain, so no payouts yet)`
      )
      this.startStats(ports.http)
    } catch (err) {
      if (err instanceof Cancelled || gen !== this.generation) {
        if (this.proc.alive && this.proc.state.status !== 'stopping') {
          this.proc.setState({ status: 'stopping', detail: 'Shutting down safely' })
          await this.shutdownProcess()
        }
        return
      }
      let message = errorMessage(err)
      if (message.startsWith('The Lithos Client exited during startup')) {
        message = diagnose('client', this.proc.snapshot().lines) ?? message
      }
      this.proc.log(message)
      if (this.proc.alive) await this.shutdownProcess()
      const crashed = this.proc.state.status === 'crashed'
      this.proc.setState({ status: crashed ? 'crashed' : 'stopped', pid: null, ports: null, detail: message })
      throw err
    }
  }

  /**
   * Replaces the Lithos API key with `chosen`, or a fresh random one, hashed by the node. A running
   * client restarts to use it.
   */
  async replaceKey(network: Network, chosen: string | null): Promise<void> {
    const conn = this.node.connection()
    if (!conn || conn.network !== network) throw new Error(`Start the ${network} node first`)
    const key = chosen ?? randomBytes(32).toString('base64url')
    await this.vault.setLithosKey(network, { key, hash: await conn.api.blake2b(key) })
    this.proc.log('Replaced the Lithos API key')
    if (this.runningNetwork === network) await this.restart(network)
  }

  /** Stops and starts again so changed settings take effect. */
  async restart(network: Network): Promise<void> {
    await this.stop()
    await this.start(network)
  }

  async stop(): Promise<void> {
    this.generation++ // cancels an in-progress start
    this.stopStats()
    if (!this.proc.alive) {
      if (this.proc.state.status !== 'crashed') this.proc.setState({ status: 'stopped', detail: null, ports: null })
      return
    }
    this.proc.setState({ status: 'stopping', detail: 'Shutting down safely' })
    await this.shutdownProcess()
  }

  private check(gen: number): void {
    if (gen !== this.generation) throw new Cancelled()
  }

  /**
   * True once the Play server answers (any status). False if it hasn't within the
   * wait; the client is left running, since a slow first start isn't a failure.
   */
  private async waitForHttp(port: number, gen: number): Promise<boolean> {
    const deadline = Date.now() + HTTP_WAIT_MS
    while (Date.now() < deadline) {
      this.check(gen)
      if (!this.proc.alive) throw new Error('The Lithos Client exited during startup. See the Client log for details.')
      try {
        await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(2000) })
        return true
      } catch {
        // not listening yet
      }
      await sleep(1000)
    }
    return false
  }

  /** Ctrl+C (Windows) or SIGTERM (Linux) so the JVM runs its shutdown hooks; hard kill only after a timeout. */
  private async shutdownProcess(): Promise<void> {
    const pid = this.proc.state.pid
    if (!this.proc.alive || pid === null) return
    this.expectExit = true
    const sent = await interrupt(pid)
    if (sent) {
      this.proc.log(process.platform === 'win32' ? 'Sent Ctrl+C to the Lithos Client' : 'Sent SIGTERM to the Lithos Client')
      if (await this.proc.waitForExit(SHUTDOWN_TIMEOUT_MS)) return
    }
    this.proc.log('The Lithos Client did not stop in time; forcing it to close')
    this.proc.kill('SIGKILL')
    await this.proc.waitForExit(10_000)
  }

  /** Polls the client's open stats endpoints (no API key needed) while it runs. */
  private startStats(port: number): void {
    const token = ++this.statsToken
    const get = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null
      } catch {
        return null
      }
    }
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : null)
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)
    const tick = async (): Promise<void> => {
      const [overview, workers] = await Promise.all([get('/stats'), get('/stats/mining/workers')])
      if (token !== this.statsToken) return
      const stratum = ((overview?.local as Record<string, unknown> | undefined)?.stratum ?? {}) as Record<string, unknown>
      const diff = (stratum.difficulty ?? {}) as Record<string, unknown>
      if (overview || workers) {
        this.lastStats = {
          stratumStatus: str(stratum.status),
          rigs: num(stratum.connectedConnections) ?? 0,
          hashesPerSecond: num(workers?.hashesPerSecond),
          superShares: num(workers?.superShares) ?? 0,
          superSharesPerHour: num(workers?.superSharesPerHour),
          committed: str(diff.committed),
          pending: str(diff.pending),
          pendingFromHeight: num(diff.pendingFromHeight),
          forcedConfig: diff.forcedConfig === true
        }
        this.emitStats(this.lastStats)
      }
      if (token === this.statsToken) setTimeout(tick, STATS_POLL_MS)
    }
    void tick()
  }

  private stopStats(): void {
    this.statsToken++
    if (this.lastStats) {
      this.lastStats = null
      this.emitStats(null)
    }
  }

  private onExit(code: number | null): void {
    this.stopStats()
    if (this.expectExit) {
      this.expectExit = false
      this.proc.log(`Lithos Client stopped${code === null ? '' : ` (exit code ${code})`}`)
      if (this.proc.state.status === 'stopping') {
        this.proc.setState({ status: 'stopped', pid: null, exitCode: code, detail: null, ports: null })
      } else {
        this.proc.setState({ pid: null, exitCode: code, ports: null })
      }
      return
    }
    this.proc.log(`Lithos Client exited unexpectedly (exit code ${code ?? 'unknown'})`)
    this.proc.setState({
      status: 'crashed',
      pid: null,
      exitCode: code,
      ports: null,
      detail:
        diagnose('client', this.proc.snapshot().lines) ??
        `The Lithos Client exited unexpectedly (code ${code ?? 'unknown'}). See the Client log.`
    })
  }
}
