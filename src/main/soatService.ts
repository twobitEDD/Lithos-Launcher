// The background SOAT service: the only process that starts soat-miner. Run as
// `<launcher> --soat-service --lithos-root=<root>` by the systemd --user unit (or detached where
// there is no systemd). It has no window; Lithos Launcher's SOAT card and the SOAT Miner window
// talk to it over the control socket.
import type { WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  gapOf,
  isLoopback,
  localStackReady,
  NO_LOCAL_WORK_TEXT,
  nodeInfoFrom,
  notReadyReason,
  parsePoolFile,
  stratumWorkFromStats,
  type MinerState,
  type ReadinessChecks,
  type SoatRequest,
  type StratumTarget
} from '@shared/soatMiner'
import { DEFAULT_WORK_WITH, lanLauncherSkip, resolveWorkWith, walletHolds, walletWaitText } from '@shared/workWith'
import { readClientSettings } from './clientConf'
import { readNodeSettings } from './ergoConf'
import { LanLauncherView } from './lanLaunchers'
import { CLIENT_DEFAULT_PORTS } from './layout'
import {
  acquireLock,
  readLauncherHandoff,
  readServiceConfig,
  serveControl,
  soatPaths,
  writeServiceConfig,
  writeStatusFile,
  type SoatServiceConfig
} from './soatControl'
import { installSoat } from './soatInstall'
import { MinerSupervisor, type MinerTarget } from './soatSupervisor'
import {
  existingMinerDirs,
  isListeningLocal,
  launcherReleaseDirs,
  openMinerLog,
  otherSoatMiners,
  resolveMiner,
  spawnMiner
} from './soatSystem'

const HTTP_TIMEOUT_MS = 3000
const STATUS_WRITE_MS = 1000

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** Runs until SIGTERM. Exits at once when another service already holds the lock. */
export async function runSoatService(root: string, exit: (code: number) => void): Promise<void> {
  const paths = soatPaths(root)
  await mkdir(paths.dir, { recursive: true })
  const lock = acquireLock(paths.lock)
  if (!lock) {
    console.error(`Another SOAT service holds ${paths.lock}; not starting a second one.`)
    exit(1)
    return
  }

  let config: SoatServiceConfig = await readServiceConfig(paths.config)
  const save = async (patch: Partial<SoatServiceConfig>): Promise<void> => {
    config = { ...config, ...patch }
    await writeServiceConfig(paths.config, config)
  }

  let log: WriteStream | null = null
  try {
    log = await openMinerLog(paths.log)
  } catch {
    // mining does not need the log file
  }

  let statusTimer: NodeJS.Timeout | null = null
  let latest: MinerState | null = null
  const flushStatus = (): void => {
    statusTimer = null
    if (latest) void writeStatusFile(paths.status, latest).catch(() => undefined)
  }
  const own = new Set<number>()

  const clientPorts = async (): Promise<{ http: number; stratum: number }> =>
    readClientSettings(root, config.network).then(
      (s) => ({ http: s.httpPort, stratum: s.stratumPort }),
      () => ({ ...CLIENT_DEFAULT_PORTS })
    )

  /** Since when this computer's own stack has had no job. */
  let localDownSince: number | null = null
  const lan = new LanLauncherView()
  const target = async (): Promise<MinerTarget | null> => {
    // Lithos Launcher writes miner-pool.txt: this computer's stratum, or the LAN launcher it defers
    // to, then LAN launchers to mine through while this computer's own stack has no work, then every
    // LAN stratum it found (for the "Work with" picker).
    const text = await readFile(join(root, 'miner-pool.txt'), 'utf8').catch(() => '')
    const pool = parsePoolFile(text)
    const primary = pool?.primary ?? { host: '127.0.0.1', port: (await clientPorts()).stratum }
    const choice = config.workWith ?? DEFAULT_WORK_WITH
    const handoff = await readLauncherHandoff(paths.launcherState)
    const launchers = await lan
      .list([...(pool?.fallbacks ?? []), ...(pool?.peers ?? [])], handoff?.hosts ?? [])
      .catch(() => [])
    const lanLaunchers = launchers.map((l) => ({ ...l, skip: lanLauncherSkip(l, config.network) }))
    const scan = handoff && (handoff.network === null || handoff.network === config.network) ? handoff.walletScan : null
    const current = supervisor.alive ? supervisor.state.target : null

    if (!isLoopback(primary.host)) {
      // This computer defers its node to that launcher: there is no stratum here to come back to.
      const picked = choice.mode === 'lan' ? lanLaunchers.find((l) => l.host === choice.host && l.skip === null) : undefined
      const t = picked ? { host: picked.host, port: picked.stratumPort! } : primary
      return {
        target: t,
        remote: true,
        view: {
          workWith: choice,
          lanLaunchers,
          via: t.host,
          workNote:
            choice.mode === 'local'
              ? `This computer runs no Lithos Client of its own right now; it uses the launcher at ${primary.host}.`
              : choice.mode === 'lan' && !picked
                ? `${choice.host} is not available; mining through ${primary.host}, the launcher this computer uses.`
                : null,
          walletWaiting: null
        }
      }
    }

    const checks = await localChecks(primary)
    const ready = localStackReady(checks)
    const now = Date.now()
    localDownSince = ready ? null : (localDownSince ?? now)
    const result = resolveWorkWith({
      choice,
      network: config.network,
      primary,
      launchers,
      autoHosts: new Set((pool?.fallbacks ?? []).map((f) => f.host)),
      localReady: ready,
      walletHold: walletHolds(scan?.state),
      localDownForMs: localDownSince === null ? 0 : now - localDownSince,
      current
    })
    const waitingHere = result.via ? (notReadyReason(checks) ?? (ready ? walletWaitText(scan, null) : NO_LOCAL_WORK_TEXT)) : null
    return {
      target: result.target,
      remote: result.remote,
      checks,
      lanFallback: result.lanFallback,
      localWaiting: result.lanFallback ? waitingHere : null,
      view: { workWith: choice, lanLaunchers, via: result.via, workNote: result.note, walletWaiting: walletWaitText(scan, result.via) }
    }
  }

  const localChecks = async (t: StratumTarget): Promise<ReadinessChecks> => {
    const [apiPort, ports] = await Promise.all([
      readNodeSettings(root, config.network).then(
        (s) => s.apiPort,
        () => (config.network === 'testnet' ? 9052 : 9053)
      ),
      clientPorts()
    ])
    const [nodeBody, panelBody, statsBody, stratumListening] = await Promise.all([
      getJson(`http://127.0.0.1:${apiPort}/info`),
      getJson(`http://127.0.0.1:${ports.http}/info`),
      getJson(`http://127.0.0.1:${ports.http}/stats`),
      isListeningLocal(t.port)
    ])
    const node = nodeInfoFrom(nodeBody)
    return {
      node,
      gap: gapOf(node),
      panelUp: panelBody !== null,
      stratumListening,
      work: statsBody === null ? 'unknown' : stratumWorkFromStats(statsBody, node?.fullHeight ?? null),
      checkedAt: Date.now()
    }
  }

  const supervisor = new MinerSupervisor(
    {
      worker: hostname().split('.')[0] || 'rig1',
      target,
      isListening: isListeningLocal,
      localChecks,
      otherMiners: () => otherSoatMiners(own),
      resolve: async () =>
        resolveMiner([
          ...(await launcherReleaseDirs(paths.dir)).map((dir) => ({ dir, source: 'launcher' as const })),
          ...(await existingMinerDirs()).map((dir) => ({ dir, source: 'existing' as const }))
        ]),
      install: async (onProgress) => {
        await mkdir(paths.dir, { recursive: true })
        await installSoat(paths.dir, onProgress)
      },
      spawn: (launch, onLine, onExit) => {
        const child = spawnMiner(
          launch,
          onLine,
          (code) => {
            if (child.pid !== null) own.delete(child.pid)
            onExit(code)
          },
          log
        )
        if (child.pid !== null) own.add(child.pid)
        return child
      },
      emit: (s) => {
        latest = s
        statusTimer ??= setTimeout(flushStatus, STATUS_WRITE_MS)
      },
      log: (line) => {
        log?.write(`${JSON.stringify({ event: 'launcher', msg: line, at: new Date().toISOString() })}\n`)
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    config.autoStart
  )

  const handle = async (req: SoatRequest): Promise<MinerState> => {
    switch (req.cmd) {
      case 'status':
        break
      case 'start':
        await save({ userStopped: false })
        supervisor.start()
        break
      case 'stop':
        await save({ userStopped: true })
        await supervisor.stop()
        break
      case 'setAutoStart':
        await save(req.on ? { autoStart: true, userStopped: false } : { autoStart: false })
        supervisor.setAutoStart(req.on)
        break
      case 'configure':
        if (config.network !== req.network) await save({ network: req.network })
        break
      case 'setWorkWith':
        await save({ workWith: req.workWith })
        // Shown at once; the next check moves the miner.
        await supervisor.tick()
        break
    }
    return supervisor.state
  }

  let server: Awaited<ReturnType<typeof serveControl>>
  try {
    server = await serveControl(paths.socket, handle)
  } catch (err) {
    console.error(`SOAT service control socket: ${err instanceof Error ? err.message : String(err)}`)
    lock.release()
    exit(1)
    return
  }

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    void (async () => {
      await supervisor.shutdown().catch(() => undefined)
      server.close()
      if (statusTimer) clearTimeout(statusTimer)
      latest = supervisor.state
      await writeStatusFile(paths.status, latest).catch(() => undefined)
      log?.end()
      lock.release()
      exit(0)
    })()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', shutdown)

  supervisor.begin(config.autoStart && !config.userStopped)
}
