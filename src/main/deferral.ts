import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ignoreLauncher, ipv4ToInt, searchLan, type DeferDecision, type RemoteLauncher } from '../shared/lanDefer.ts'
import { settings, updateSettings } from './settings'
import { readClientSettings } from './clientConf'
import { CLIENT_DEFAULT_PORTS } from './layout'
import { ownIpv4Addresses, physicalLanIfaces, probeStratum } from './lanDiscover.ts'
import { isPortListening, writeFileAtomic } from './util'

const PROBE_MS = 300

/**
 * On startup, see if another Lithos launcher is already serving stratum on this LAN.
 * Deferring never stops a node or client. If this machine is already listening, it stays the launcher.
 */
export class LauncherDeferral {
  private remote: RemoteLauncher | null = null
  /** The user chose to start a node on this computer even though a peer was found. */
  private overrideLocal = false
  private inflight: Promise<void> | null = null
  private generation = 0
  private port = CLIENT_DEFAULT_PORTS.stratum

  constructor(
    private readonly root: string,
    private readonly emit: (remote: RemoteLauncher | null) => void,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  /** Current peer, or null when this computer should run its own launcher. */
  current(): RemoteLauncher | null {
    return this.overrideLocal ? null : this.remote
  }

  begin(): void {
    this.inflight = this.refresh().finally(() => {
      this.inflight = null
    })
  }

  private async ready(): Promise<void> {
    if (this.inflight) await this.inflight
  }

  /** Blocks node and client start while another launcher should be used. Never stops a running one. */
  async assertCanStartLocal(): Promise<void> {
    await this.ready()
    const remote = this.current()
    if (!remote) return
    throw new Error(
      `Another Lithos launcher is already running at stratum+tcp://${remote.host}:${remote.port}. ` +
        'This computer is using that one instead of starting a node here.'
    )
  }

  /**
   * Stop deferring to the other machine for this session, and remember its address.
   * Does not try to shut that machine down.
   */
  async useLocal(): Promise<string[]> {
    const host = this.remote?.host
    this.overrideLocal = true
    this.generation++
    this.remote = null
    this.emit(null)
    const ignored = new Set(settings().ignoredLaunchers ?? [])
    if (host && ipv4ToInt(host) !== null) {
      for (const saved of ignoreLauncher({ host, port: this.port }, [...ignored])) ignored.add(saved)
      try {
        await updateSettings((s) => {
          s.ignoredLaunchers = [...ignored]
        })
      } catch {
        // The session flag still lets Start proceed.
      }
    }
    void this.writePool(`127.0.0.1:${this.port}`, this.generation)
    return [...ignored]
  }

  /**
   * Defer to other launchers again. Does not stop a node, client, or miner on this computer.
   */
  async useRemoteAgain(): Promise<string[]> {
    this.overrideLocal = false
    try {
      await updateSettings((s) => {
        delete s.ignoredLaunchers
      })
    } catch {
      // A failed write still clears the session flag; the next lookup can defer again.
    }
    await this.refresh()
    return settings().ignoredLaunchers ?? []
  }

  private async refresh(): Promise<void> {
    const gen = ++this.generation
    this.port = await this.stratumPort()
    if (gen !== this.generation) return
    const localStratumOpen = await isPortListening(this.port)
    if (gen !== this.generation) return
    let decision: DeferDecision
    try {
      decision = await searchLan({
        ifaces: physicalLanIfaces(),
        own: ownIpv4Addresses(),
        port: this.port,
        localStratumOpen,
        ignored: new Set(settings().ignoredLaunchers ?? []),
        probe: (host, port) => probeStratum(host, port, PROBE_MS)
      })
    } catch {
      // A failed lookup must not stop this computer from being the only launcher.
      decision = { action: 'local', reason: 'no-peer' }
    }
    if (this.overrideLocal || gen !== this.generation) return
    if (decision.action === 'defer') {
      this.remote = { host: decision.host, port: decision.port }
      await this.writePool(`${decision.host}:${decision.port}`, gen)
      if (this.overrideLocal || gen !== this.generation) return
      this.log(
        `Another Lithos launcher is at stratum+tcp://${decision.host}:${decision.port}. ` +
          'Not starting a node or stratum on this computer.'
      )
      this.emit(this.remote)
      return
    }
    this.remote = null
    await this.writePool(`127.0.0.1:${this.port}`, gen)
    if (this.overrideLocal || gen !== this.generation) return
    this.log(
      decision.reason === 'this-machine-already-serving'
        ? 'Stratum is already open on this computer. Leaving the running node and client as they are.'
        : 'No other Lithos launcher on this network. This computer can start its own.'
    )
    this.emit(null)
  }

  private async stratumPort(): Promise<number> {
    try {
      const settings = await readClientSettings(this.root, 'mainnet')
      if (Number.isInteger(settings.stratumPort)) return settings.stratumPort
    } catch {
      // missing config: the client's default port
    }
    return CLIENT_DEFAULT_PORTS.stratum
  }

  /** One line, `host:port`, for the local miner. The running miner keeps its old target until it restarts. */
  private async writePool(pool: string, gen: number): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true })
      if (gen !== this.generation) return
      await writeFileAtomic(join(this.root, 'miner-pool.txt'), `${pool}\n`)
    } catch {
      // The UI still shows the address when the file cannot be written.
    }
  }
}
