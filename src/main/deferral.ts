import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decideDefer,
  findLanStratums,
  ignoreLauncher,
  ipv4ToInt,
  miningFallbacks,
  type DeferDecision,
  type RemoteLauncher
} from '../shared/lanDefer.ts'
import { formatPoolFile } from '../shared/soatMiner.ts'
import { settings, updateSettings } from './settings'
import { readClientSettings } from './clientConf'
import { CLIENT_DEFAULT_PORTS } from './layout'
import { ownIpv4Addresses, physicalLanIfaces, probeStratum } from './lanDiscover.ts'
import { isListeningLocal } from './soatSystem.ts'
import { writeFileAtomic } from './util'

const PROBE_MS = 300
/** LAN stratums to mine through are looked up again this often while none is known, and less often after. */
const FALLBACK_SCAN_MS = 10 * 60_000
const FALLBACK_RESCAN_MS = 30 * 60_000

/** Mining through a LAN launcher while this computer's stack has no work. Absent means on. */
export function mineThroughLanAllowed(): boolean {
  return settings().mineThroughLan !== false
}

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
  /** Every LAN stratum seen in the last lookup, ignored launchers included. */
  private lanStratums: RemoteLauncher[] = []
  /** The first line last written to miner-pool.txt. */
  private poolPrimary: string | null = null
  private fallbackTimer: NodeJS.Timeout | null = null

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
      this.scheduleFallbackScan()
    })
  }

  /** LAN launchers the miner may mine through while this computer's own stack has no work. */
  fallbacks(): RemoteLauncher[] {
    return miningFallbacks(this.lanStratums, ownIpv4Addresses(), mineThroughLanAllowed())
  }

  async setMineThroughLan(on: boolean): Promise<void> {
    await updateSettings((s) => {
      if (on) delete s.mineThroughLan
      else s.mineThroughLan = false
    })
    if (this.poolPrimary) await this.writePool(this.poolPrimary, this.generation)
  }

  private scheduleFallbackScan(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    const ms = this.lanStratums.length ? FALLBACK_RESCAN_MS : FALLBACK_SCAN_MS
    this.fallbackTimer = setTimeout(() => {
      void this.rescanFallbacks().finally(() => this.scheduleFallbackScan())
    }, ms)
    this.fallbackTimer.unref?.()
  }

  /** Looks up LAN stratums again for the miner only; the node deferral decision stays as it is. */
  private async rescanFallbacks(): Promise<void> {
    if (this.inflight || !mineThroughLanAllowed()) return
    const gen = this.generation
    const found = await this.scanStratums().catch(() => null)
    if (!found || gen !== this.generation) return
    this.lanStratums = found
    if (this.poolPrimary) await this.writePool(this.poolPrimary, gen)
  }

  private scanStratums(): Promise<RemoteLauncher[]> {
    return findLanStratums({
      ifaces: physicalLanIfaces(),
      own: ownIpv4Addresses(),
      port: this.port,
      probe: (host, port) => probeStratum(host, port, PROBE_MS)
    })
  }

  private async ready(): Promise<void> {
    if (this.inflight) await this.inflight
  }

  /** The peer to defer to once the startup lookup has finished, or null to run locally. */
  async settled(): Promise<RemoteLauncher | null> {
    await this.ready()
    return this.current()
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
    // Read from the socket table: a test connection would show up in the client as a connected rig.
    const localStratumOpen = await isListeningLocal(this.port)
    if (gen !== this.generation) return
    let decision: DeferDecision
    try {
      // Scanned even when this computer serves stratum: its client may have no job yet.
      const remotes = await this.scanStratums()
      if (gen === this.generation) this.lanStratums = remotes
      decision = decideDefer({
        localStratumOpen,
        remotes,
        own: ownIpv4Addresses(),
        ignored: new Set(settings().ignoredLaunchers ?? [])
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

  /**
   * `host:port` for the local miner, then (when it is this computer's own stratum) the LAN launchers
   * it may mine through until its own client has a job. The SOAT service picks among them.
   */
  private async writePool(pool: string, gen: number): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true })
      if (gen !== this.generation) return
      this.poolPrimary = pool
      const local = pool.startsWith('127.') || pool.startsWith('localhost:')
      await writeFileAtomic(join(this.root, 'miner-pool.txt'), formatPoolFile(pool, local ? this.fallbacks() : []))
    } catch {
      // The UI still shows the address when the file cannot be written.
    }
  }
}
