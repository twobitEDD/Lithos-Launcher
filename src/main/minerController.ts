import type { WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { MinerState } from '@shared/soatMiner'
import { readClientSettings } from './clientConf'
import type { ClientController } from './clientController'
import type { LauncherDeferral } from './deferral'
import { CLIENT_DEFAULT_PORTS, layout } from './layout'
import { settings, updateSettings } from './settings'
import { installSoat } from './soatInstall'
import {
  existingMinerDirs,
  isListeningLocal,
  launcherReleaseDirs,
  lithosStratumWork,
  openMinerLog,
  otherSoatMiners,
  resolveMiner,
  spawnMiner
} from './soatSystem'
import { MinerSupervisor, type MinerTarget } from './soatSupervisor'

/** Whether the miner starts by itself and is kept running. Absent in launcher.json means on. */
export function minerAutoStart(): boolean {
  return settings().soatMiner?.autoStart !== false
}

/** Runs SOAT on this computer's GPU against this launcher's stratum, or the one it defers to. */
export class MinerController {
  readonly supervisor: MinerSupervisor
  private readonly own = new Set<number>()
  private log: WriteStream | null = null

  constructor(
    private readonly root: string,
    private readonly client: ClientController,
    private readonly deferral: LauncherDeferral,
    emit: (state: MinerState) => void,
    note: (line: string) => void
  ) {
    const minerDir = layout.minerDir(root)
    this.supervisor = new MinerSupervisor(
      {
        worker: hostname().split('.')[0] || 'rig1',
        target: () => this.target(),
        isListening: isListeningLocal,
        stratumWork: async () => lithosStratumWork(await this.panelPort()),
        otherMiners: () => otherSoatMiners(this.own),
        resolve: async () =>
          resolveMiner([
            ...(await launcherReleaseDirs(minerDir)).map((dir) => ({ dir, source: 'launcher' as const })),
            ...(await existingMinerDirs()).map((dir) => ({ dir, source: 'existing' as const }))
          ]),
        install: async (onProgress) => {
          await mkdir(minerDir, { recursive: true })
          await installSoat(minerDir, onProgress)
        },
        spawn: (launch, onLine, onExit) => {
          const child = spawnMiner(
            launch,
            onLine,
            (code) => {
              if (child.pid !== null) this.own.delete(child.pid)
              onExit(code)
            },
            this.log
          )
          if (child.pid !== null) this.own.add(child.pid)
          return child
        },
        emit,
        log: (line) => {
          this.log?.write(`${JSON.stringify({ event: 'launcher', msg: line, at: new Date().toISOString() })}\n`)
          note(`SOAT miner: ${line}`)
        },
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout)
      },
      minerAutoStart()
    )
  }

  get state(): MinerState {
    return this.supervisor.state
  }

  get alive(): boolean {
    return this.supervisor.alive
  }

  async begin(): Promise<void> {
    const dir = layout.minerDir(this.root)
    try {
      await mkdir(dir, { recursive: true })
      this.log = await openMinerLog(join(dir, 'soat-miner.log'))
    } catch {
      // mining does not need the log file
    }
    this.supervisor.begin()
  }

  start(): MinerState {
    this.supervisor.start()
    return this.state
  }

  async stop(): Promise<MinerState> {
    await this.supervisor.stop()
    return this.state
  }

  async setAutoStart(on: boolean): Promise<MinerState> {
    await updateSettings((s) => {
      if (on) delete s.soatMiner
      else s.soatMiner = { autoStart: false }
    })
    this.supervisor.setAutoStart(on)
    return this.state
  }

  async shutdown(): Promise<void> {
    await this.supervisor.shutdown()
    this.log?.end()
    this.log = null
  }

  private async panelPort(): Promise<number> {
    const running = this.client.proc.state.ports?.http
    if (running) return running
    const network = this.client.proc.state.network ?? 'mainnet'
    return readClientSettings(this.root, network).then(
      (s) => s.httpPort,
      () => CLIENT_DEFAULT_PORTS.http
    )
  }

  private async target(): Promise<MinerTarget | null> {
    const remote = this.deferral.current()
    if (remote) return { target: { host: remote.host, port: remote.port }, remote: true }
    const running = this.client.proc.state.ports?.stratum
    if (running) return { target: { host: '127.0.0.1', port: running }, remote: false }
    const network = this.client.proc.state.network ?? 'mainnet'
    const port = await readClientSettings(this.root, network).then(
      (s) => s.stratumPort,
      () => CLIENT_DEFAULT_PORTS.stratum
    )
    return { target: { host: '127.0.0.1', port }, remote: false }
  }
}
