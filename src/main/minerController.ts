import { access } from 'node:fs/promises'
import type { Network } from '@shared/types'
import {
  INITIAL_MINER_STATE,
  legacyRunning,
  type LegacySoat,
  type MinerState,
  type SoatRequest,
  type SoatServiceInfo
} from '@shared/soatMiner'
import type { WorkWith } from '@shared/workWith'
import {
  readServiceConfig,
  readStatusFile,
  requestControl,
  soatPaths,
  writeServiceConfig,
  type SoatPaths
} from './soatControl'
import { settings } from './settings'
import { ensureService } from './soatServiceManager'
import { detectLegacy, stopLegacy } from './soatServiceUnit'

/** The auto-start choice saved in launcher.json before the service existed. Absent means on. */
export function minerAutoStart(): boolean {
  return settings().soatMiner?.autoStart !== false
}

/** The windows refresh the service's status this often. */
const STATUS_POLL_MS = 2000
/** Looking for the old stack and repairing a service that is not answering happens less often. */
const SERVICE_CHECK_MS = 15_000
const SERVICE_START_WAIT_MS = 8000

export interface MinerControllerOptions {
  /** The node network, passed on to the service (Lithos Launcher only). */
  network?: () => Network
  /** The auto-start choice from before the service existed (launcher.json), used once. */
  initialAutoStart?: () => boolean
  /** Saves the auto-start choice in launcher.json too (Lithos Launcher only). */
  saveAutoStart?: (on: boolean) => Promise<unknown>
}

/**
 * A window's view of the background SOAT service. It never starts soat-miner itself: it installs and
 * starts the service, shows its status, and sends it Start/Stop. Closing the window leaves mining
 * running. Lithos Launcher's card and the SOAT Miner window each have one of these.
 */
export class MinerController {
  private readonly paths: SoatPaths
  private s: MinerState = { ...INITIAL_MINER_STATE }
  private service: SoatServiceInfo = { mode: 'none', installed: false, reachable: false, legacy: null, error: null }
  private pollTimer: NodeJS.Timeout | null = null
  private lastServiceCheck = 0
  private checking: Promise<void> | null = null
  private closed = false
  private sentNetwork: Network | null = null

  constructor(
    private readonly root: string,
    private readonly emit: (state: MinerState) => void,
    private readonly note: (line: string) => void,
    private readonly opts: MinerControllerOptions = {}
  ) {
    this.paths = soatPaths(root)
  }

  get state(): MinerState {
    return { ...this.s, service: this.service }
  }

  /** The miner belongs to the service, so a window closing or quitting never waits on it. */
  get alive(): boolean {
    return false
  }

  async begin(): Promise<void> {
    await this.seedConfig().catch(() => undefined)
    await this.checkService(true)
    await this.poll()
  }

  async start(): Promise<MinerState> {
    await this.requireNoLegacy()
    return this.send({ cmd: 'start' }, true)
  }

  async stop(): Promise<MinerState> {
    if (!this.service.reachable) {
      await this.poll()
      if (!this.service.reachable) return this.state
    }
    return this.send({ cmd: 'stop' }, false)
  }

  async setAutoStart(on: boolean): Promise<MinerState> {
    await this.opts.saveAutoStart?.(on)
    if (!this.service.reachable) {
      // Applies when the service next starts.
      const config = await readServiceConfig(this.paths.config)
      await writeServiceConfig(this.paths.config, { ...config, autoStart: on, userStopped: on ? false : config.userStopped })
      this.s = { ...this.s, autoStart: on }
      if (on && !legacyRunning(this.service.legacy)) return this.send({ cmd: 'setAutoStart', on }, true)
      this.publish()
      return this.state
    }
    return this.send({ cmd: 'setAutoStart', on }, false)
  }

  /** The "Work with" picker. Saved by the service; while it is not answering, in its settings file for its next start. */
  async setWorkWith(workWith: WorkWith): Promise<MinerState> {
    if (!this.service.reachable) {
      const config = await readServiceConfig(this.paths.config)
      await writeServiceConfig(this.paths.config, { ...config, workWith })
      this.s = { ...this.s, workWith }
      this.publish()
      return this.state
    }
    try {
      return await this.send({ cmd: 'setWorkWith', workWith }, false)
    } catch (err) {
      if (err instanceof Error && err.message === 'Unknown request') {
        const config = await readServiceConfig(this.paths.config)
        await writeServiceConfig(this.paths.config, { ...config, workWith })
        throw new Error(
          'Saved. The SOAT service running now is older than this launcher and uses the choice once it restarts ' +
            '(at the next login, or with: systemctl --user restart lithos-soat.service).'
        )
      }
      throw err
    }
  }

  /**
   * "Switch to Lithos service": stops and disables the old soat-*.service units and closes
   * soat-launcher.py, then enables the Lithos service. Only on the user's click.
   */
  async switchToService(): Promise<MinerState> {
    const legacy = await detectLegacy()
    if (legacy) {
      this.note('SOAT: switching from the old SOAT setup to the Lithos service')
      await stopLegacy(legacy, (line) => this.note(`SOAT: ${line}`))
    }
    this.service = { ...this.service, legacy: await detectLegacy(), error: null }
    if (legacyRunning(this.service.legacy)) throw new Error('The old SOAT setup is still running; try again in a few seconds.')
    await this.install(true)
    await this.waitForService()
    return this.state
  }

  shutdown(): Promise<void> {
    this.closed = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    return Promise.resolve()
  }

  private async seedConfig(): Promise<void> {
    const exists = await access(this.paths.config).then(
      () => true,
      () => false
    )
    if (exists) return
    await writeServiceConfig(this.paths.config, {
      autoStart: this.opts.initialAutoStart?.() ?? true,
      userStopped: false,
      network: this.opts.network?.() ?? 'mainnet'
    })
  }

  private async requireNoLegacy(): Promise<void> {
    if (!legacyRunning(this.service.legacy)) this.service = { ...this.service, legacy: await detectLegacy() }
    if (legacyRunning(this.service.legacy)) {
      throw new Error('The old SOAT service is running. Press "Switch to Lithos service" first, so two miners never share the GPU.')
    }
  }

  private async send(req: SoatRequest, startService: boolean): Promise<MinerState> {
    try {
      this.apply(await requestControl(this.paths.socket, req))
    } catch (err) {
      if (!startService) throw err
      await this.install(true)
      await this.waitForService()
      this.apply(await requestControl(this.paths.socket, req))
    }
    return this.state
  }

  private async install(start: boolean): Promise<void> {
    try {
      const r = await ensureService(this.root, start)
      this.service = { ...this.service, mode: r.mode, installed: r.installed, error: null }
    } catch (err) {
      this.service = { ...this.service, error: err instanceof Error ? err.message : String(err) }
      this.publish()
      throw err
    }
  }

  private async waitForService(): Promise<void> {
    const until = Date.now() + SERVICE_START_WAIT_MS
    while (Date.now() < until) {
      try {
        this.apply(await requestControl(this.paths.socket, { cmd: 'status' }, 1000))
        return
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    throw new Error('The SOAT service did not start. See journalctl --user -u lithos-soat.service.')
  }

  /** Finds the old stack; installs (and, with no old stack, starts) the service when it is not answering. */
  private checkService(force = false): Promise<void> {
    if (!force && Date.now() - this.lastServiceCheck < SERVICE_CHECK_MS) return Promise.resolve()
    if (this.checking) return this.checking
    this.lastServiceCheck = Date.now()
    this.checking = (async () => {
      const legacy: LegacySoat | null = await detectLegacy().catch(() => null)
      this.service = { ...this.service, legacy }
      if (this.service.reachable) return
      // With the old stack present (running or enabled), the unit is written but not started: the
      // user switches over with the button, so the two never run together.
      await this.install(legacy === null).catch((err: unknown) => {
        this.note(`SOAT service: ${err instanceof Error ? err.message : String(err)}`)
      })
    })().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async poll(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    try {
      const network = this.opts.network?.()
      const configure = network !== undefined && network !== this.sentNetwork
      const state = await requestControl(this.paths.socket, configure ? { cmd: 'configure', network } : { cmd: 'status' }, 1500)
      if (configure) this.sentNetwork = network
      this.apply(state)
    } catch {
      this.service = { ...this.service, reachable: false }
      const last = await readStatusFile(this.paths.status)
      // The status file is the last thing the service wrote; nothing is running now.
      if (last) this.s = { ...last, status: 'stopped', pid: null, detail: 'The SOAT service is not running.' }
      this.publish()
    }
    await this.checkService()
    if (!this.closed) this.pollTimer = setTimeout(() => void this.poll(), STATUS_POLL_MS)
  }

  private apply(state: MinerState): void {
    this.service = { ...this.service, reachable: true, installed: true }
    this.s = state
    this.publish()
  }

  private publish(): void {
    if (!this.closed) this.emit(this.state)
  }
}
