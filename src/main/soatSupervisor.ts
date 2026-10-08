import {
  INITIAL_MINER_STATE,
  isLoopback,
  isNoJobError,
  minerArgs,
  minerLineText,
  noWorkRetryMs,
  parseMinerSample,
  restartDelayMs,
  sameTarget,
  sampleText,
  type MinerBackend,
  type MinerState,
  type StratumTarget,
  type StratumWork
} from '../shared/soatMiner.ts'

/** soat-launcher.py polled every 4 s. */
export const POLL_MS = 4000
/** No stats line for this long means the miner is wedged; it prints one every 5 s while hashing. */
export const STALL_MS = 3 * 60_000
/** A run that hashed for this long resets the backoff. */
export const HEALTHY_RUN_MS = 60_000
/**
 * While the panel says the stratum has no job, the miner is still tried this often, in case the
 * panel's report is wrong or this client version reports differently.
 */
export const NO_WORK_PROBE_MS = 3 * 60_000
export const NO_WORK_DETAIL =
  'Waiting for the Lithos Client to send work. Its stratum is up but has no mining job yet; the Ergo node ' +
  'hands out work once it is synced and has applied a new block (up to a few minutes after it starts).'
const STOP_TIMEOUT_MS = 10_000
const TAIL_LINES = 12
const LAST_LINE_MAX = 220

export interface MinerLaunch {
  command: string
  args: string[]
  cwd: string
}

export interface MinerChild {
  readonly pid: number | null
  kill(signal?: NodeJS.Signals): void
}

export interface ResolvedMiner {
  binary: string
  cwd: string
  backend: MinerBackend
  gpu: string
  vramMb: number | null
  source: 'launcher' | 'existing'
  version: string | null
}

export interface MinerTarget {
  target: StratumTarget
  /** Another launcher's stratum on the LAN. */
  remote: boolean
}

export interface SupervisorDeps {
  worker: string
  /** Where to mine now: this computer's client, or the launcher it defers to. Null if neither is known. */
  target(): Promise<MinerTarget | null>
  /** Whether this machine has `port` in LISTEN state. Must not connect: a connection counts as a rig. */
  isListening(port: number): Promise<boolean>
  /** Whether this computer's Lithos Client has a job for `target`, from its panel. Absent means unknown. */
  stratumWork?(target: StratumTarget): Promise<StratumWork>
  /** PIDs of SOAT miners on this computer that this supervisor did not start. */
  otherMiners(): Promise<number[]>
  resolve(): Promise<ResolvedMiner | null>
  /** Downloads the miner when none is found. */
  install?(onProgress: (received: number, total: number) => void): Promise<void>
  spawn(launch: MinerLaunch, onLine: (line: string) => void, onExit: (code: number | null) => void): MinerChild
  emit(state: MinerState): void
  log?(line: string): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/**
 * Keeps one SOAT miner hashing into the Lithos stratum, the way soat-launcher.py and the
 * soat-reconnect-*.sh loops did: waits for the stratum to listen, restarts on exit with a backoff,
 * restarts when it stops reporting hashrate, and reconnects when the stratum target moves.
 */
export class MinerSupervisor {
  private s: MinerState
  private wanted = false
  private child: MinerChild | null = null
  private runTarget: StratumTarget | null = null
  private runStartedAt = 0
  private hashedThisRun = false
  private lastError: string | null = null
  private failures = 0
  private retryAt: number | null = null
  private stratumWasDown = false
  /** First time in this stretch the client was seen with no work, or null while it has work. */
  private noWorkSince: number | null = null
  private noWorkFailures = 0
  private retargeting = false
  private stalled = false
  private stopping: (() => void) | null = null
  private installTried = false
  private busy = false
  private pollTimer: unknown = null
  private kickTimer: unknown = null
  private tail: string[] = []
  private readonly deps: SupervisorDeps

  constructor(deps: SupervisorDeps, autoStart: boolean) {
    this.deps = deps
    this.s = { ...INITIAL_MINER_STATE, autoStart, worker: deps.worker }
  }

  get state(): MinerState {
    return this.s
  }

  get alive(): boolean {
    return this.child !== null
  }

  /** At launch: start polling, and mine if auto-start is on. */
  begin(): void {
    if (this.s.autoStart) this.wanted = true
    this.schedulePoll()
    this.kick()
  }

  /** The Start button. Clears any backoff. */
  start(): void {
    this.wanted = true
    this.failures = 0
    this.retryAt = null
    this.installTried = false
    this.set({ status: this.child ? this.s.status : 'starting', detail: this.child ? this.s.detail : 'Checking' })
    this.kick()
  }

  /** The Stop button: stays stopped until Start, or until auto-start is turned on again. */
  async stop(): Promise<void> {
    this.wanted = false
    this.retryAt = null
    if (!this.child) {
      this.set({ status: 'stopped', detail: null, pid: null })
      return
    }
    if (this.stopping) return
    const child = this.child
    const done = new Promise<void>((resolve) => (this.stopping = resolve))
    this.set({ status: 'stopping', detail: 'Stopping the miner' })
    child.kill('SIGTERM')
    const force = this.deps.setTimer(() => {
      if (this.child === child) child.kill('SIGKILL')
    }, STOP_TIMEOUT_MS)
    await done
    this.deps.clearTimer(force)
  }

  setAutoStart(on: boolean): void {
    this.set({ autoStart: on })
    if (on) this.start()
  }

  /** Stops polling and the miner, for quitting. */
  async shutdown(): Promise<void> {
    if (this.pollTimer !== null) this.deps.clearTimer(this.pollTimer)
    if (this.kickTimer !== null) this.deps.clearTimer(this.kickTimer)
    this.pollTimer = null
    this.kickTimer = null
    await this.stop()
  }

  /** Runs one check now. Tests call this directly; the poll timer calls it every POLL_MS. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.check()
    } finally {
      this.busy = false
    }
  }

  private schedulePoll(): void {
    this.pollTimer = this.deps.setTimer(() => {
      void this.tick().finally(() => {
        if (this.pollTimer !== null) this.schedulePoll()
      })
    }, POLL_MS)
  }

  private kick(delay = 0): void {
    if (this.kickTimer !== null) this.deps.clearTimer(this.kickTimer)
    this.kickTimer = this.deps.setTimer(() => {
      this.kickTimer = null
      void this.tick()
    }, delay)
  }

  private async check(): Promise<void> {
    if (!this.wanted || this.stopping) return
    const found = await this.deps.target()
    const target = found?.target ?? null

    if (this.child) {
      if (!sameTarget(target, this.runTarget)) {
        if (!target) return // keep mining the old target until a new one is known
        this.note(`Stratum moved to ${target.host}:${target.port}; reconnecting the miner`)
        this.retargeting = true
        this.set({ status: 'restarting', detail: `Reconnecting to ${target.host}:${target.port}` })
        this.child.kill('SIGTERM')
        return
      }
      const quietFor = this.deps.now() - (this.s.lastSampleAt ?? this.runStartedAt)
      if (quietFor >= STALL_MS && !this.stalled) {
        this.stalled = true
        this.note(`No hashrate reported for ${Math.round(quietFor / 1000)} s; restarting the miner`)
        this.child.kill('SIGTERM')
      }
      return
    }

    if (!found || !target) {
      this.set({ status: 'waiting', detail: 'Waiting for a Lithos stratum (start the Lithos Client)', target: null })
      return
    }
    const local = !found.remote || isLoopback(target.host)
    this.set({ target, remote: found.remote })
    if (local) {
      if (!(await this.deps.isListening(target.port))) {
        this.stratumWasDown = true
        this.set({
          status: 'waiting',
          detail: `Waiting for the Lithos Client stratum on ${target.host}:${target.port}`
        })
        return
      }
      if (this.stratumWasDown) {
        // The pool is back: start straight away instead of sitting out a backoff from while it was down.
        this.stratumWasDown = false
        this.failures = 0
        this.retryAt = null
      }
      const work = this.deps.stratumWork ? await this.deps.stratumWork(target) : 'unknown'
      if (work === 'none') {
        const now = this.deps.now()
        this.noWorkSince ??= now
        if (now - Math.max(this.noWorkSince, this.runStartedAt) < NO_WORK_PROBE_MS) {
          this.set({ status: 'waiting', detail: NO_WORK_DETAIL })
          return
        }
      } else if (work === 'ready' && this.noWorkSince !== null) {
        // The panel said there was no job and now has one: start straight away instead of sitting out the backoff.
        this.noWorkSince = null
        this.noWorkFailures = 0
        this.failures = 0
        this.retryAt = null
      }
    }
    if (this.retryAt !== null && this.deps.now() < this.retryAt) return

    const others = await this.deps.otherMiners()
    if (others.length) {
      this.set({
        status: 'waiting',
        detail: `Another SOAT miner or miner loop is already running on this computer (pid ${others.join(', ')}). Not starting a second one on the same GPU.`
      })
      return
    }

    let miner = await this.deps.resolve()
    if (!miner && this.deps.install && !this.installTried) {
      this.installTried = true
      this.set({ status: 'starting', detail: 'Downloading the SOAT miner' })
      try {
        await this.deps.install((received, total) => this.set({ install: { received, total } }))
        this.note('Installed the SOAT miner')
      } catch (err) {
        this.note(`Could not download the SOAT miner: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.set({ install: null })
      miner = await this.deps.resolve()
    }
    if (!miner) {
      this.set({ status: 'waiting', detail: 'The SOAT miner is not installed. Press Start to download it.' })
      return
    }
    if (!this.wanted || this.stopping || this.child) return
    this.launch(miner, target)
  }

  private launch(miner: ResolvedMiner, target: StratumTarget): void {
    const args = minerArgs({ target, worker: this.deps.worker, backend: miner.backend, vramMb: miner.vramMb })
    this.runTarget = target
    this.runStartedAt = this.deps.now()
    this.hashedThisRun = false
    this.stalled = false
    this.lastError = null
    this.note(`Starting ${miner.backend === 'cuda' ? 'soat-miner (CUDA)' : 'soat-miner-vk (Vulkan)'} on ${miner.gpu} → ${target.host}:${target.port}`)
    const child = this.deps.spawn(
      { command: miner.binary, args, cwd: miner.cwd },
      (line) => this.onLine(line),
      (code) => this.onExit(child, code)
    )
    this.child = child
    this.set({
      status: 'starting',
      detail: 'Building the dataset and connecting',
      pid: child.pid,
      backend: miner.backend,
      gpu: miner.gpu,
      source: miner.source,
      version: miner.version,
      sample: null,
      lastSampleAt: null
    })
  }

  private onLine(line: string): void {
    const sample = parseMinerSample(line)
    if (sample) {
      this.hashedThisRun = true
      this.noWorkSince = null
      this.noWorkFailures = 0
      const text = sampleText(sample)
      this.set({
        status: 'running',
        detail: null,
        sample,
        lastSampleAt: this.deps.now(),
        lastHashLine: text.length > LAST_LINE_MAX ? `${text.slice(0, LAST_LINE_MAX)}…` : text
      })
      return
    }
    const text = minerLineText(line)
    if (!text) return
    if (text.startsWith('error:')) this.lastError = text.slice('error:'.length).trim()
    this.pushTail(text)
  }

  private onExit(child: MinerChild, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.runTarget = null
    const exitText = `exit code ${code ?? 'unknown'}`
    if (this.stopping) {
      const resolve = this.stopping
      this.stopping = null
      this.note(`Miner stopped (${exitText})`)
      this.set({ status: 'stopped', detail: null, pid: null })
      resolve()
      return
    }
    if (this.retargeting) {
      this.retargeting = false
      this.failures = 0
      this.retryAt = null
      this.set({ pid: null })
      this.kick()
      return
    }
    const reason = this.lastError ? `: ${this.lastError}` : ''
    if (isNoJobError(this.lastError) && !this.hashedThisRun && !this.stalled) {
      // Not a crash: the client is up but has no work yet. Wait for it instead of crash-looping.
      this.noWorkFailures++
      const delay = noWorkRetryMs(this.noWorkFailures)
      this.retryAt = this.deps.now() + delay
      this.note(`The Lithos Client sent no work yet (${exitText}); trying again in ${Math.round(delay / 1000)} s`)
      this.set({ status: 'waiting', detail: NO_WORK_DETAIL, pid: null })
      this.kick(delay)
      return
    }
    this.note(`Miner exited (${exitText})${reason}`)
    if (!this.s.autoStart && !this.stalled) {
      this.wanted = false
      this.set({ status: 'stopped', detail: `The miner exited (${exitText})${reason}`, pid: null })
      return
    }
    const healthy = this.hashedThisRun && this.deps.now() - this.runStartedAt >= HEALTHY_RUN_MS
    this.failures = healthy ? 1 : this.failures + 1
    const delay = restartDelayMs(this.failures, this.hashedThisRun)
    this.retryAt = this.deps.now() + delay
    this.set({
      status: 'restarting',
      detail: `The miner exited (${exitText})${reason}. Restarting in ${Math.round(delay / 1000)} s.`,
      pid: null,
      restarts: this.s.restarts + 1
    })
    this.kick(delay)
  }

  private note(message: string): void {
    this.deps.log?.(message)
    this.pushTail(`[launcher] ${message}`)
  }

  private pushTail(line: string): void {
    this.tail.push(line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX)}…` : line)
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES)
    this.set({ logTail: [...this.tail] })
  }

  private set(patch: Partial<MinerState>): void {
    this.s = { ...this.s, ...patch }
    this.deps.emit(this.s)
  }
}
