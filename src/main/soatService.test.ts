import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  GAP_MAX,
  INITIAL_MINER_STATE,
  LEGACY_UNITS,
  gapOf,
  legacyFromScan,
  legacyRunning,
  nodeInfoFrom,
  notReadyReason,
  parseSoatRequest,
  stratumWorkFromStats,
  type MinerState,
  type ReadinessChecks,
  type SoatRequest
} from '../shared/soatMiner.ts'
import {
  acquireLock,
  DEFAULT_SERVICE_CONFIG,
  lockHolder,
  readServiceConfig,
  readStatusFile,
  requestControl,
  serveControl,
  soatPaths,
  writeServiceConfig,
  writeStatusFile
} from './soatControl.ts'
import { desktopEntryText, serviceUnitText, systemdWord } from './soatServiceUnit.ts'
import { MinerSupervisor, type MinerChild, type SupervisorDeps } from './soatSupervisor.ts'

let dir = ''
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'soat-service-test-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('lock: one service owns the miner', () => {
  test('a second acquire fails while the holder is alive, and works after release', () => {
    const file = join(dir, 'a.lock')
    const first = acquireLock(file)
    assert.ok(first)
    assert.equal(lockHolder(file), process.pid)
    first.release()
    assert.equal(existsSync(file), false)
    const again = acquireLock(file)
    assert.ok(again)
    again.release()
  })

  test('a lock held by another live pid is refused', async () => {
    const file = join(dir, 'b.lock')
    await writeFile(file, '424242\n')
    assert.equal(acquireLock(file, (pid) => pid === 424242), null)
    assert.equal(lockHolder(file, (pid) => pid === 424242), 424242)
    assert.equal(await readFile(file, 'utf8'), '424242\n', 'the holder keeps its lock')
  })

  test('a lock left by a dead process is taken over', async () => {
    const file = join(dir, 'c.lock')
    await writeFile(file, '424243\n')
    const lock = acquireLock(file, () => false)
    assert.ok(lock)
    assert.equal((await readFile(file, 'utf8')).trim(), String(process.pid))
    lock.release()
  })

  test('release leaves a lock that another process has since taken', async () => {
    const file = join(dir, 'd.lock')
    const lock = acquireLock(file)
    assert.ok(lock)
    await writeFile(file, '424244\n')
    lock.release()
    assert.equal(existsSync(file), true)
  })
})

describe('status protocol', () => {
  test('only known requests with the right types are accepted', () => {
    assert.deepEqual(parseSoatRequest('{"cmd":"status"}'), { cmd: 'status' })
    assert.deepEqual(parseSoatRequest('{"cmd":"stop","extra":1}'), { cmd: 'stop' })
    assert.deepEqual(parseSoatRequest('{"cmd":"setAutoStart","on":false}'), { cmd: 'setAutoStart', on: false })
    assert.equal(parseSoatRequest('{"cmd":"setAutoStart","on":"yes"}'), null)
    assert.deepEqual(parseSoatRequest('{"cmd":"configure","network":"testnet"}'), { cmd: 'configure', network: 'testnet' })
    assert.equal(parseSoatRequest('{"cmd":"configure","network":"/etc"}'), null)
    assert.equal(parseSoatRequest('{"cmd":"exec","argv":["rm"]}'), null)
    assert.equal(parseSoatRequest('not json'), null)
    assert.equal(parseSoatRequest('null'), null)
  })

  test('requests round-trip over the control socket; a second service is refused', { skip: process.platform === 'win32' }, async () => {
    const socket = join(dir, 'ctl.sock')
    const seen: SoatRequest[] = []
    let state: MinerState = { ...INITIAL_MINER_STATE, worker: 'rig1' }
    const server = await serveControl(socket, (req) => {
      seen.push(req)
      if (req.cmd === 'start') state = { ...state, status: 'waiting' }
      if (req.cmd === 'stop') state = { ...state, status: 'stopped' }
      if (req.cmd === 'setAutoStart') state = { ...state, autoStart: req.on }
      return state
    })
    try {
      assert.equal((await requestControl(socket, { cmd: 'status' })).worker, 'rig1')
      assert.equal((await requestControl(socket, { cmd: 'start' })).status, 'waiting')
      assert.equal((await requestControl(socket, { cmd: 'setAutoStart', on: false })).autoStart, false)
      assert.equal((await requestControl(socket, { cmd: 'stop' })).status, 'stopped')
      assert.deepEqual(
        seen.map((r) => r.cmd),
        ['status', 'start', 'setAutoStart', 'stop']
      )
      await assert.rejects(
        serveControl(socket, () => state),
        /already running/
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('a handler error comes back as an error, not a hang', { skip: process.platform === 'win32' }, async () => {
    const socket = join(dir, 'err.sock')
    const server = await serveControl(socket, () => {
      throw new Error('nope')
    })
    try {
      await assert.rejects(requestControl(socket, { cmd: 'start' }), /nope/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('a stale socket file from a dead service is replaced', { skip: process.platform === 'win32' }, async () => {
    const socket = join(dir, 'stale.sock')
    const first = await serveControl(socket, () => INITIAL_MINER_STATE)
    // Simulate a crash: the file stays, nothing listens.
    await new Promise<void>((resolve) => first.close(() => resolve()))
    await writeFile(socket, '')
    const second = await serveControl(socket, () => ({ ...INITIAL_MINER_STATE, worker: 'second' }))
    try {
      assert.equal((await requestControl(socket, { cmd: 'status' })).worker, 'second')
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()))
    }
  })

  test('nothing listening rejects quickly', { skip: process.platform === 'win32' }, async () => {
    await assert.rejects(requestControl(join(dir, 'none.sock'), { cmd: 'status' }, 500))
  })

  test('status file and service settings round-trip; bad files fall back to defaults', async () => {
    const status = join(dir, 'status.json')
    await writeStatusFile(status, { ...INITIAL_MINER_STATE, status: 'running', restarts: 3 })
    const back = await readStatusFile(status)
    assert.equal(back?.status, 'running')
    assert.equal(back?.restarts, 3)
    assert.equal(typeof back?.writtenAt, 'number')
    await writeFile(status, '{"oops"')
    assert.equal(await readStatusFile(status), null)

    const config = join(dir, 'cfg', 'soat-service.json')
    assert.deepEqual(await readServiceConfig(config), DEFAULT_SERVICE_CONFIG)
    await writeServiceConfig(config, { autoStart: false, userStopped: true, network: 'testnet' })
    assert.deepEqual(await readServiceConfig(config), { autoStart: false, userStopped: true, network: 'testnet' })
    await writeFile(config, '{"autoStart":"no","network":"moon"}')
    assert.deepEqual(await readServiceConfig(config), DEFAULT_SERVICE_CONFIG)
  })

  test('paths: lock and socket in XDG_RUNTIME_DIR, the rest under <root>/miner', () => {
    const p = soatPaths('/home/u/Lithos', { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')
    assert.equal(p.lock, '/run/user/1000/lithos-soat.lock')
    assert.equal(p.socket, '/run/user/1000/lithos-soat.sock')
    assert.equal(p.status, '/home/u/Lithos/miner/status.json')
    assert.equal(p.log, '/home/u/Lithos/miner/soat-miner.log')
    const noRuntime = soatPaths('/home/u/Lithos', {}, 'linux')
    assert.equal(noRuntime.lock, '/home/u/Lithos/miner/lithos-soat.lock')
    assert.match(soatPaths('C:\\L', { USERNAME: 'Ed Norris' }, 'win32').socket, /^\\\\\.\\pipe\\lithos-soat-Ed_Norris$/)
  })
})

const READY: Omit<ReadinessChecks, 'checkedAt'> = {
  node: { fullHeight: 1890981, headersHeight: 1890981, peers: 31 },
  gap: 0,
  panelUp: true,
  stratumListening: true,
  work: 'ready'
}

describe('readiness', () => {
  test('node /info becomes heights and a gap', () => {
    const node = nodeInfoFrom({ fullHeight: 100, headersHeight: 150, peersCount: 4 })
    assert.deepEqual(node, { fullHeight: 100, headersHeight: 150, peers: 4 })
    assert.equal(gapOf(node), 50)
    assert.equal(gapOf(nodeInfoFrom({ fullHeight: null, headersHeight: 150 })), null)
    assert.equal(nodeInfoFrom(null), null)
  })

  test('waits in soat-launcher.py order: node, fullHeight, gap, panel, stratum', () => {
    assert.equal(notReadyReason(READY), null)
    assert.match(notReadyReason({ ...READY, node: null, gap: null })!, /node API/)
    assert.match(notReadyReason({ ...READY, node: { ...READY.node!, fullHeight: null }, gap: null })!, /fullHeight/)
    assert.match(notReadyReason({ ...READY, gap: GAP_MAX + 1 })!, /16,001 blocks behind/)
    assert.equal(notReadyReason({ ...READY, gap: GAP_MAX }), null)
    assert.match(notReadyReason({ ...READY, panelUp: false })!, /panel/)
    assert.match(notReadyReason({ ...READY, stratumListening: false })!, /stratum/)
  })

  test('the client has no job: null activeJob, or one older than the node tip', () => {
    // Lithos Client 1.0.2 after a node restart: stratum "active" but no candidate from the node yet.
    assert.equal(stratumWorkFromStats({ local: { stratum: { status: 'active', activeJob: null } } }), 'none')
    const job = { local: { stratum: { status: 'active', activeJob: { jobId: '1', height: '1890982' } } } }
    assert.equal(stratumWorkFromStats(job, 1890981), 'ready')
    assert.equal(stratumWorkFromStats(job, 1890982), 'ready')
    assert.equal(stratumWorkFromStats(job, 1890990), 'none', 'a job from before a restart, several blocks back')
    assert.equal(stratumWorkFromStats({ local: { stratum: { status: 'active' } } }), 'ready', 'older clients without activeJob')
  })

  test('the supervisor waits on the checks and starts once the client has a job', async () => {
    let checks: ReadinessChecks = { ...READY, work: 'none', checkedAt: 0 }
    const spawned: string[] = []
    let state: MinerState | null = null
    const timers: (() => void)[] = []
    const deps: SupervisorDeps = {
      worker: 'rig1',
      target: async () => ({ target: { host: '127.0.0.1', port: 4444 }, remote: false }),
      isListening: async () => true,
      localChecks: async () => checks,
      otherMiners: async () => [],
      resolve: async () => ({
        binary: '/x/soat-miner',
        cwd: '/x',
        backend: 'cuda',
        gpu: 'GPU',
        vramMb: 8192,
        source: 'existing',
        version: null
      }),
      spawn: (launch): MinerChild => {
        spawned.push(launch.command)
        return { pid: 1, kill: () => undefined }
      },
      emit: (s) => (state = s),
      now: () => 0,
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => undefined
    }
    const sup = new MinerSupervisor(deps, true)
    sup.begin()
    await sup.tick()
    assert.equal(spawned.length, 0)
    assert.equal(state!.status, 'waiting')
    assert.equal(state!.checks?.work, 'none')

    checks = { ...READY, gap: GAP_MAX + 500, checkedAt: 1 }
    await sup.tick()
    assert.equal(spawned.length, 0)
    assert.match(state!.detail!, /blocks behind/)

    checks = { ...READY, checkedAt: 2 }
    await sup.tick()
    assert.deepEqual(spawned, ['/x/soat-miner'])
  })

  test('stopped by the user: checks still update, nothing starts', async () => {
    let spawns = 0
    let state: MinerState | null = null
    const sup = new MinerSupervisor(
      {
        worker: 'rig1',
        target: async () => ({ target: { host: '127.0.0.1', port: 4444 }, remote: false }),
        isListening: async () => true,
        localChecks: async () => ({ ...READY, checkedAt: 5 }),
        otherMiners: async () => [],
        resolve: async () => null,
        spawn: () => {
          spawns++
          return { pid: 1, kill: () => undefined }
        },
        emit: (s) => (state = s),
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => undefined
      },
      true
    )
    sup.begin(false)
    await sup.tick()
    assert.equal(spawns, 0)
    assert.equal(state!.checks?.checkedAt, 5)
  })
})

describe('legacy SOAT stack', () => {
  const procs = [
    { pid: 10, argv: ['/usr/bin/python3', '/home/owner/dev/lithos-testnet/stack/bin/soat-launcher.py'] },
    { pid: 11, argv: ['bash', '/home/owner/dev/lithos-testnet/stack/bin/soat-reconnect-lithos-mainnet.sh'] },
    { pid: 12, argv: ['./soat-miner', '--lithos', '--pool', '127.0.0.1:4444'] },
    { pid: 13, argv: ['/usr/bin/vim', 'soat-launcher.py.bak'] },
    { pid: 14, argv: ['grep', 'soat-launcher.py'] }
  ]

  test('finds the launcher window, the reconnect loop and active or enabled units', () => {
    const l = legacyFromScan({
      procs,
      units: [
        { name: 'soat-lithos-mainnet.service', active: true, enabled: false },
        { name: 'soat-ergo-mainnet-pool.service', active: false, enabled: true },
        { name: 'lithos-soat.service', active: true, enabled: true }
      ]
    })
    assert.deepEqual(l, {
      activeUnits: ['soat-lithos-mainnet.service'],
      enabledUnits: ['soat-ergo-mainnet-pool.service'],
      launcherPids: [10],
      loopPids: [11]
    })
    assert.equal(legacyRunning(l), true)
  })

  test('the Lithos service and grep lines are not legacy; enabled-only is present but not running', () => {
    assert.equal(legacyFromScan({ procs: procs.slice(2), units: [{ name: 'lithos-soat.service', active: true, enabled: true }] }), null)
    const enabledOnly = legacyFromScan({ procs: [], units: [{ name: LEGACY_UNITS[0], active: false, enabled: true }] })
    assert.ok(enabledOnly)
    assert.equal(legacyRunning(enabledOnly), false)
    assert.equal(legacyRunning(null), false)
  })
})

describe('service unit and desktop entry', () => {
  test('the unit restarts always and conflicts with every legacy unit', () => {
    const text = serviceUnitText(['/opt/Lithos Launcher/lithos-launcher', '--soat-service', '--lithos-root=/home/u/Lithos'])
    assert.match(text, /^Restart=always$/m)
    assert.match(text, /^KillMode=control-group$/m)
    assert.match(text, /^WantedBy=default\.target$/m)
    assert.match(text, new RegExp(`^Conflicts=${LEGACY_UNITS.join(' ').replace(/\./g, '\\.')}$`, 'm'))
    assert.match(text, /^ExecStart="\/opt\/Lithos Launcher\/lithos-launcher" --soat-service --lithos-root=\/home\/u\/Lithos$/m)
  })

  test('ExecStart words escape systemd specifiers and quotes', () => {
    assert.equal(systemdWord('/a/b'), '/a/b')
    assert.equal(systemdWord('100%'), '100%%')
    assert.equal(systemdWord('$HOME'), '$$HOME')
    assert.equal(systemdWord('a "b"'), '"a \\"b\\""')
  })

  test('the desktop entry opens the SOAT window', () => {
    const text = desktopEntryText(['/home/u/Lithos/miner/app/Lithos-Launcher-1.AppImage', '--soat', '--lithos-root=/home/u/Lithos'], '/i.png')
    assert.match(text, /^Name=SOAT Miner$/m)
    assert.match(text, /^Exec=\/home\/u\/Lithos\/miner\/app\/Lithos-Launcher-1\.AppImage --soat --lithos-root=\/home\/u\/Lithos$/m)
    assert.match(desktopEntryText(['/opt/My App/x', '--soat'], '/i.png'), /^Exec="\/opt\/My App\/x" --soat$/m)
  })
})
