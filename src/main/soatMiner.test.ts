import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  chooseMiningTarget,
  formatPoolFile,
  isNoJobError,
  lanFallbackText,
  listeningPortsFromNetstat,
  LOCAL_GRACE_MS,
  localStackReady,
  listeningPortsFromProcNet,
  minerArgs,
  minerLineText,
  noWorkRetryMs,
  parseMinerSample,
  parsePoolFile,
  parsePoolLine,
  pickBackend,
  restartDelayMs,
  soatMinerCommand,
  stratumWorkFromStats,
  type MinerState,
  type ReadinessChecks,
  type StratumTarget,
  type StratumWork
} from '../shared/soatMiner.ts'
import { miningFallbacks } from '../shared/lanDefer.ts'
import { CUDA_BIN, isListeningLocal, lithosStratumWork, parseNvidiaSmi, resolveMiner, VULKAN_BIN } from './soatSystem.ts'
import {
  MinerSupervisor,
  NO_WORK_DETAIL,
  NO_WORK_PROBE_MS,
  POLL_MS,
  STALL_MS,
  type MinerChild,
  type MinerLaunch,
  type MinerTarget,
  type ResolvedMiner,
  type SupervisorDeps
} from './soatSupervisor.ts'

test('SOAT rigs target Lithos stratum as host:port', () => {
  assert.equal(
    soatMinerCommand('192.168.86.25:4444'),
    'soat-miner --lithos --pool 192.168.86.25:4444 --worker $(hostname -s)'
  )
  assert.equal(
    soatMinerCommand('10.0.0.2:4444', 'rig1'),
    'soat-miner --lithos --pool 10.0.0.2:4444 --worker rig1'
  )
})

// A real line from soat-lithos-mainnet.log on the RTX 2070.
const STATS_LINE =
  '{"uptime_s":82332,"algo":"autolykos2","backend":"CUDA","rate":63.31,"rate_avg":57.23,"unit":"MH/s","eff":0.379,' +
  '"eff_unit":"MH/W","mhs":63.31,"mhs_avg":57.23,"eff_mh_w":0.379,"watts":167.0,"temp_c":69,"fan_pct":61,' +
  '"epoch":1890350,"accepted":365,"rejected":0,"nonces":4711698661376}'

describe('SOAT output', () => {
  test('stats lines become a hashrate sample; events do not', () => {
    const s = parseMinerSample(STATS_LINE)
    assert.equal(s?.mhs, 63.31)
    assert.equal(s?.mhsAvg, 57.23)
    assert.equal(s?.accepted, 365)
    assert.equal(s?.rejected, 0)
    assert.equal(s?.tempC, 69)
    assert.equal(parseMinerSample('{"event":"ok","msg":"dataset ready in 10.14s - mining"}'), null)
    assert.equal(parseMinerSample('SOAT Miner | NVIDIA GeForce RTX 2070 | 8.2 GB'), null)
    assert.equal(
      minerLineText('{"event":"error","msg":"no Lithos client is answering on 127.0.0.1:4444."}'),
      'error: no Lithos client is answering on 127.0.0.1:4444.'
    )
  })

  test('miner-pool.txt accepts host:port only, like the reconnect script', () => {
    assert.deepEqual(parsePoolLine('192.168.86.25:4444\n'), { host: '192.168.86.25', port: 4444 })
    assert.deepEqual(parsePoolLine('  127.0.0.1:4444  '), { host: '127.0.0.1', port: 4444 })
    assert.equal(parsePoolLine('stratum+tcp://1.2.3.4:4444'), null)
    assert.equal(parsePoolLine('1.2.3.4:99999'), null)
    assert.equal(parsePoolLine(''), null)
  })
})

describe('backend choice', () => {
  const nvidia = (computeCap: number | null, vramMb = 8192) => ({ name: 'NVIDIA GeForce RTX 2070', computeCap, vramMb })

  test('NVIDIA before Blackwell gets CUDA', () => {
    const c = pickBackend({ nvidia: nvidia(7.5), other: null, hasCuda: true, hasVulkan: true })
    assert.equal(c?.backend, 'cuda')
    assert.equal(c?.vramMb, 8192)
  })

  test('Blackwell (compute capability 12) gets Vulkan', () => {
    assert.equal(pickBackend({ nvidia: nvidia(12.0), other: null, hasCuda: true, hasVulkan: true })?.backend, 'vulkan')
  })

  test('AMD (no nvidia-smi) gets Vulkan', () => {
    const c = pickBackend({ nvidia: null, other: { vendor: 'amd', vramMb: 8192 }, hasCuda: true, hasVulkan: true })
    assert.equal(c?.backend, 'vulkan')
    assert.equal(c?.gpu, 'AMD GPU')
  })

  test('falls back to the binary that exists', () => {
    assert.equal(pickBackend({ nvidia: nvidia(7.5), other: null, hasCuda: false, hasVulkan: true })?.backend, 'vulkan')
    assert.equal(pickBackend({ nvidia: null, other: null, hasCuda: true, hasVulkan: false })?.backend, 'cuda')
    assert.equal(pickBackend({ nvidia: null, other: null, hasCuda: false, hasVulkan: false }), null)
  })

  test('reads nvidia-smi csv', () => {
    assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 2070, 8192, 7.5\n'), {
      name: 'NVIDIA GeForce RTX 2070',
      vramMb: 8192,
      computeCap: 7.5
    })
    assert.equal(parseNvidiaSmi('GeForce GTX 1080, 8192\n')?.computeCap, null)
  })

  test('8 GB CUDA cards run --cache-dag off with a half batch; Vulkan never gets --cache-dag', () => {
    const target = { host: '127.0.0.1', port: 4444 }
    const cuda = minerArgs({ target, worker: 'owner-hp-z230', backend: 'cuda', vramMb: 8192 })
    assert.deepEqual(cuda.slice(0, 5), ['--lithos', '--pool', '127.0.0.1:4444', '--worker', 'owner-hp-z230'])
    assert.equal(cuda[cuda.indexOf('--batch') + 1], '2097152')
    assert.equal(cuda[cuda.indexOf('--cache-dag') + 1], 'off')
    const vk = minerArgs({ target, worker: 'rx570', backend: 'vulkan', vramMb: 8192 })
    assert.equal(vk.includes('--cache-dag'), false)
    const big = minerArgs({ target, worker: 'r', backend: 'cuda', vramMb: 24576 })
    assert.equal(big.includes('--batch'), false)
    assert.equal(big[big.indexOf('--cache-dag') + 1], 'auto')
  })

  test('resolveMiner runs soat-miner on NVIDIA and soat-miner-vk on AMD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soat-'))
    try {
      const empty = join(dir, 'empty')
      const rel = join(dir, 'soat-miner_v0.2.18_Lin64')
      await mkdir(empty)
      await mkdir(rel)
      for (const name of [CUDA_BIN, VULKAN_BIN]) {
        await writeFile(join(rel, name), '#!/bin/sh\n')
        await chmod(join(rel, name), 0o755)
      }
      const candidates = [
        { dir: empty, source: 'launcher' as const },
        { dir: rel, source: 'existing' as const }
      ]
      const onNvidia = await resolveMiner(candidates, async () => ({
        nvidia: { name: 'NVIDIA GeForce RTX 2070', computeCap: 7.5, vramMb: 8192 },
        other: null
      }))
      assert.equal(onNvidia?.binary, join(rel, CUDA_BIN))
      assert.equal(onNvidia?.backend, 'cuda')
      assert.equal(onNvidia?.version, '0.2.18')
      assert.equal(onNvidia?.source, 'existing')
      const onAmd = await resolveMiner(candidates, async () => ({
        nvidia: null,
        other: { vendor: 'amd', vramMb: 8192 }
      }))
      assert.equal(onAmd?.binary, join(rel, VULKAN_BIN))
      assert.equal(onAmd?.backend, 'vulkan')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('restart backoff', () => {
  test('2 s after a run that hashed, 5/10/20/40/60 s after ones that did not', () => {
    assert.equal(restartDelayMs(3, true), 2000)
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => restartDelayMs(n, false)),
      [5000, 10_000, 20_000, 40_000, 60_000, 60_000]
    )
  })
})

// SOAT's message when the Lithos Client accepted the connection but had no job (node 500
// "Miner has not started yet" on /mining/candidate after a restart).
const NO_JOB_LINE =
  '{"event":"error","msg":"connected to the pool but it sent no job in 20s. The socket is open, so this is not a ' +
  'firewall - the pool may have refused the wallet silently, or the port is for a different algorithm."}'

// Shapes of the Lithos Client 1.0.2 panel's GET /stats, before and after the node had a candidate.
const STATS_NO_JOB = {
  enabled: true,
  local: { stratum: { status: 'waiting', observedAt: 1, connectedConnections: 1, difficulty: { served: '2400000' } } }
}
const STATS_WITH_JOB = {
  enabled: true,
  local: {
    stratum: {
      status: 'active',
      connectedConnections: 1,
      activeJob: { jobId: '1', height: 1890366, mode: 'genesis' }
    }
  }
}

describe('stratum work', () => {
  test('reads the panel /stats', () => {
    assert.equal(stratumWorkFromStats(STATS_NO_JOB), 'none')
    assert.equal(stratumWorkFromStats(STATS_WITH_JOB), 'ready')
    assert.equal(stratumWorkFromStats({ local: { stratum: { status: 'waiting', activeJob: { jobId: '2' } } } }), 'ready')
    assert.equal(stratumWorkFromStats({ enabled: true }), 'unknown')
    assert.equal(stratumWorkFromStats(null), 'unknown')
    assert.equal(stratumWorkFromStats({ local: { stratum: { status: 'something-new' } } }), 'unknown')
  })

  test('recognises the no-job exit and backs off 10/20/40/60 s', () => {
    assert.equal(isNoJobError(minerLineText(NO_JOB_LINE).slice('error:'.length).trim()), true)
    assert.equal(isNoJobError('no Lithos client is answering on 127.0.0.1:4444.'), false)
    assert.equal(isNoJobError(null), false)
    assert.deepEqual([1, 2, 3, 4, 5].map(noWorkRetryMs), [10_000, 20_000, 40_000, 60_000, 60_000])
  })

  test('lithosStratumWork asks the panel over HTTP and treats failures as unknown', async () => {
    let body: unknown = STATS_NO_JOB
    let status = 200
    const server = createHttpServer((req, res) => {
      assert.equal(req.url, '/stats')
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      assert.equal(await lithosStratumWork(port), 'none')
      body = STATS_WITH_JOB
      assert.equal(await lithosStratumWork(port), 'ready')
      status = 503
      assert.equal(await lithosStratumWork(port), 'unknown')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    assert.equal(await lithosStratumWork(port, 500), 'unknown', 'panel not answering')
  })
})

describe('listen table', () => {
  test('reads LISTEN rows from /proc/net/tcp only', () => {
    const proc = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:115C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
      '   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1'
    ].join('\n')
    const ports = listeningPortsFromProcNet(proc)
    assert.equal(ports.has(4444), true)
    assert.equal(ports.has(8080), false) // established, not listening
  })

  test('reads LISTENING rows from Windows netstat', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:4444           0.0.0.0:0              LISTENING       4120',
      '  TCP    127.0.0.1:9000         127.0.0.1:51000        ESTABLISHED     4120'
    ].join('\r\n')
    const ports = listeningPortsFromNetstat(out)
    assert.equal(ports.has(4444), true)
    assert.equal(ports.has(9000), false)
  })
})

class FakeClock {
  t = 1_000_000
  private timers: { id: number; at: number; fn: () => void }[] = []
  private next = 1

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.push({ id, at: this.t + ms, fn })
    return id
  }

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }

  /** Moves time forward, firing due timers in order and letting their async work finish. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await settle()
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    this.t = end
    await settle()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

class FakeChild implements MinerChild {
  readonly signals: string[] = []
  readonly pid: number
  readonly launch: MinerLaunch
  private readonly line: (l: string) => void
  private readonly onExit: (code: number | null) => void
  private readonly exitOnSignal: boolean

  constructor(
    pid: number,
    launch: MinerLaunch,
    line: (l: string) => void,
    onExit: (code: number | null) => void,
    exitOnSignal: boolean
  ) {
    this.pid = pid
    this.launch = launch
    this.line = line
    this.onExit = onExit
    this.exitOnSignal = exitOnSignal
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.signals.push(signal)
    if (this.exitOnSignal) queueMicrotask(() => this.exit(null))
  }

  print(l: string): void {
    this.line(l)
  }

  exit(code: number | null): void {
    this.onExit(code)
  }
}

const MINER: ResolvedMiner = {
  binary: '/opt/soat/soat-miner',
  cwd: '/opt/soat',
  backend: 'cuda',
  gpu: 'NVIDIA GeForce RTX 2070',
  vramMb: 8192,
  source: 'launcher',
  version: '0.2.18'
}

function harness(
  opts: { listening?: boolean; autoStart?: boolean; others?: number[]; exitOnSignal?: boolean; work?: StratumWork } = {}
) {
  const clock = new FakeClock()
  const children: FakeChild[] = []
  const world = {
    listening: opts.listening ?? true,
    target: { target: { host: '127.0.0.1', port: 4444 }, remote: false } as MinerTarget | null,
    others: opts.others ?? [],
    listenChecks: 0,
    work: opts.work
  }
  let state: MinerState | null = null
  const deps: SupervisorDeps = {
    worker: 'owner-hp-z230',
    target: async () => world.target,
    isListening: async () => {
      world.listenChecks++
      return world.listening
    },
    ...(opts.work !== undefined ? { stratumWork: async () => world.work ?? 'unknown' } : {}),
    otherMiners: async () => world.others,
    resolve: async () => MINER,
    spawn: (launch, onLine, onExit) => {
      const child = new FakeChild(9000 + children.length, launch, onLine, onExit, opts.exitOnSignal ?? true)
      children.push(child)
      return child
    },
    emit: (s) => (state = s),
    now: () => clock.t,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  }
  const sup = new MinerSupervisor(deps, opts.autoStart ?? true)
  return { sup, clock, children, world, state: () => state! }
}

const pool = (c: FakeChild): string => c.launch.args[c.launch.args.indexOf('--pool') + 1]

describe('MinerSupervisor', () => {
  test('waits for the stratum to listen before starting', async () => {
    const h = harness({ listening: false })
    h.sup.begin()
    await h.clock.advance(3 * POLL_MS)
    assert.equal(h.children.length, 0)
    assert.equal(h.state().status, 'waiting')
    assert.match(h.state().detail ?? '', /Waiting for the Lithos Client stratum on 127\.0\.0\.1:4444/)

    h.world.listening = true
    await h.clock.advance(POLL_MS)
    assert.equal(h.children.length, 1)
    assert.equal(h.children[0].launch.command, MINER.binary)
    assert.equal(pool(h.children[0]), '127.0.0.1:4444')
    assert.equal(h.state().status, 'starting')

    h.children[0].print(STATS_LINE)
    assert.equal(h.state().status, 'running')
    assert.match(h.state().lastHashLine ?? '', /^63\.31 MH\/s/)
  })

  test('restarts after a crash with a growing backoff', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    assert.equal(h.children.length, 1)

    h.children[0].exit(1)
    assert.equal(h.state().status, 'restarting')
    assert.equal(h.state().restarts, 1)
    await h.clock.advance(4900)
    assert.equal(h.children.length, 1, 'no restart before the 5 s backoff')
    await h.clock.advance(200)
    assert.equal(h.children.length, 2)

    h.children[1].exit(1)
    assert.equal(h.state().restarts, 2)
    await h.clock.advance(9000)
    assert.equal(h.children.length, 2, 'second failure waits 10 s')
    await h.clock.advance(1100)
    assert.equal(h.children.length, 3)
  })

  test('a run that hashed comes back after 2 s, as the reconnect script did', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    h.children[0].print(STATS_LINE)
    await h.clock.advance(90_000)
    h.children[0].exit(0)
    await h.clock.advance(2100)
    assert.equal(h.children.length, 2)
  })

  test('restarts at once when the pool comes back after being down', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    // Lithos client went away: SOAT exits with "no Lithos client is answering" a few times.
    h.world.listening = false
    for (let i = 0; i < 3; i++) {
      h.children.at(-1)!.print('{"event":"error","msg":"no Lithos client is answering on 127.0.0.1:4444."}')
      h.children.at(-1)!.exit(1)
      await h.clock.advance(1)
    }
    const before = h.children.length
    await h.clock.advance(2 * POLL_MS)
    assert.equal(h.children.length, before, 'no spawn while the stratum is down')
    assert.equal(h.state().status, 'waiting')
    h.world.listening = true
    await h.clock.advance(POLL_MS)
    assert.equal(h.children.length, before + 1, 'started on the next poll, not after a long backoff')
  })

  test('reconnects when the stratum target moves (LAN deferral)', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    assert.equal(pool(h.children[0]), '127.0.0.1:4444')

    h.world.target = { target: { host: '192.168.86.25', port: 4444 }, remote: true }
    await h.clock.advance(POLL_MS)
    assert.deepEqual(h.children[0].signals, ['SIGTERM'])
    await h.clock.advance(1)
    assert.equal(h.children.length, 2)
    assert.equal(pool(h.children[1]), '192.168.86.25:4444')
    assert.equal(h.state().restarts, 0, 'a retarget is not a crash')
    assert.equal(h.state().remote, true)
  })

  test('restarts a miner that stops reporting hashrate', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    h.children[0].print(STATS_LINE)
    await h.clock.advance(STALL_MS + POLL_MS)
    assert.deepEqual(h.children[0].signals, ['SIGTERM'])
    await h.clock.advance(3000)
    assert.equal(h.children.length, 2)
  })

  test('never starts a second miner next to one it did not start', async () => {
    const h = harness({ others: [905441] })
    h.sup.begin()
    await h.clock.advance(3 * POLL_MS)
    assert.equal(h.children.length, 0)
    assert.equal(h.state().status, 'waiting')
    assert.match(h.state().detail ?? '', /905441/)
  })

  test('Stop stays stopped; auto-start off waits for Start', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    await h.sup.stop()
    assert.equal(h.state().status, 'stopped')
    await h.clock.advance(10 * POLL_MS)
    assert.equal(h.children.length, 1)

    const off = harness({ autoStart: false })
    off.sup.begin()
    await off.clock.advance(3 * POLL_MS)
    assert.equal(off.children.length, 0)
    off.sup.start()
    await off.clock.advance(0)
    assert.equal(off.children.length, 1)
    off.children[0].exit(1)
    await off.clock.advance(60_000)
    assert.equal(off.children.length, 1, 'with auto-start off a crash is not restarted')
    assert.equal(off.state().status, 'stopped')
  })

  test('waits for the client to have a job before starting the miner', async () => {
    const h = harness({ work: 'none' })
    h.sup.begin()
    await h.clock.advance(5 * POLL_MS)
    assert.equal(h.children.length, 0, 'no miner while the panel says there is no job')
    assert.equal(h.state().status, 'waiting')
    assert.equal(h.state().detail, NO_WORK_DETAIL)

    h.world.work = 'ready'
    await h.clock.advance(POLL_MS)
    assert.equal(h.children.length, 1)
    assert.equal(h.state().restarts, 0)
  })

  test('"sent no job" is waiting for work, not a crash loop', async () => {
    const h = harness()
    h.sup.begin()
    await h.clock.advance(0)
    h.children[0].print(NO_JOB_LINE)
    h.children[0].exit(1)
    assert.equal(h.state().status, 'waiting')
    assert.equal(h.state().detail, NO_WORK_DETAIL)
    assert.equal(h.state().restarts, 0, 'not counted as a crash')
    await h.clock.advance(9900)
    assert.equal(h.children.length, 1, 'no retry before 10 s')
    await h.clock.advance(200)
    assert.equal(h.children.length, 2)

    h.children[1].print(NO_JOB_LINE)
    h.children[1].exit(1)
    await h.clock.advance(19_900)
    assert.equal(h.children.length, 2, 'second no-job waits 20 s')
    await h.clock.advance(200)
    assert.equal(h.children.length, 3)

    // Work arrives: hashing resets the no-job backoff.
    h.children[2].print(STATS_LINE)
    assert.equal(h.state().status, 'running')
  })

  test('with auto-start off, "sent no job" keeps waiting instead of stopping', async () => {
    const h = harness({ autoStart: false })
    h.sup.begin()
    h.sup.start()
    await h.clock.advance(0)
    h.children[0].print(NO_JOB_LINE)
    h.children[0].exit(1)
    assert.equal(h.state().status, 'waiting')
    await h.clock.advance(10_100)
    assert.equal(h.children.length, 2)
  })

  test('after a no-job exit, starts as soon as the panel reports a job', async () => {
    const h = harness({ work: 'ready' })
    h.sup.begin()
    await h.clock.advance(0)
    h.world.work = 'none'
    h.children[0].print(NO_JOB_LINE)
    h.children[0].exit(1)
    await h.clock.advance(60_000)
    assert.equal(h.children.length, 1, 'held while the panel has no job')
    h.world.work = 'ready'
    await h.clock.advance(POLL_MS)
    assert.equal(h.children.length, 2)
  })

  test('still tries the miner now and then if the panel keeps saying there is no job', async () => {
    const h = harness({ work: 'none' })
    h.sup.begin()
    await h.clock.advance(NO_WORK_PROBE_MS - POLL_MS)
    assert.equal(h.children.length, 0)
    await h.clock.advance(2 * POLL_MS)
    assert.equal(h.children.length, 1, 'one probe run after NO_WORK_PROBE_MS')
    h.children[0].print(NO_JOB_LINE)
    h.children[0].exit(1)
    await h.clock.advance(NO_WORK_PROBE_MS - 30_000)
    assert.equal(h.children.length, 1, 'the next probe waits another NO_WORK_PROBE_MS')
  })

  test('the health check never opens a TCP connection to the stratum port', { skip: process.platform !== 'linux' }, async () => {
    let connections = 0
    const server = createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const realConnect = Socket.prototype.connect
    let connectCalls = 0
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      connectCalls++
      return (realConnect as (...a: unknown[]) => Socket).apply(this, args)
    } as typeof Socket.prototype.connect
    try {
      const target: StratumTarget = { host: '127.0.0.1', port }
      const children: FakeChild[] = []
      const sup = new MinerSupervisor(
        {
          worker: 'w',
          target: async () => ({ target, remote: false }),
          isListening: isListeningLocal,
          otherMiners: async () => [],
          resolve: async () => MINER,
          spawn: (launch, onLine, onExit) => {
            const c = new FakeChild(1, launch, onLine, onExit, true)
            children.push(c)
            return c
          },
          emit: () => undefined,
          now: () => Date.now(),
          setTimer: () => 0,
          clearTimer: () => undefined
        },
        true
      )
      sup.start()
      for (let i = 0; i < 5; i++) await sup.tick()
      assert.equal(children.length, 1, 'the listening port was seen from the socket table')
      assert.equal(pool(children[0]), `127.0.0.1:${port}`)
      // Ten more health checks with the miner "running".
      for (let i = 0; i < 10; i++) await sup.tick()
      await settle()
      assert.equal(connectCalls, 0)
      assert.equal(connections, 0)
    } finally {
      Socket.prototype.connect = realConnect
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('mining target while this computer is not ready', () => {
  const LOCAL: StratumTarget = { host: '127.0.0.1', port: 4444 }
  const LAN25: StratumTarget = { host: '192.168.86.25', port: 4444 }
  const LAN28: StratumTarget = { host: '192.168.86.28', port: 4444 }
  const readyChecks: Omit<ReadinessChecks, 'checkedAt'> = {
    node: { fullHeight: 1_000_000, headersHeight: 1_000_000, peers: 10 },
    gap: 0,
    panelUp: true,
    stratumListening: true,
    work: 'ready'
  }

  test('miner-pool.txt keeps its first line and adds LAN fallbacks', () => {
    const text = formatPoolFile('127.0.0.1:4444', [LAN25, LAN28])
    assert.equal(text, '127.0.0.1:4444\nlan 192.168.86.25:4444\nlan 192.168.86.28:4444\n')
    assert.deepEqual(parsePoolLine(text), LOCAL, 'older services read only the first line')
    assert.deepEqual(parsePoolFile(text), { primary: LOCAL, fallbacks: [LAN25, LAN28], peers: [] })
    assert.deepEqual(parsePoolFile('127.0.0.1:4444\r\nlan 127.0.0.1:4444\r\nlan bad\r\n'), { primary: LOCAL, fallbacks: [], peers: [] })
    assert.equal(parsePoolFile(''), null)
  })

  test('peer lines list every LAN stratum and leave the first line and lan lines as before', () => {
    const text = formatPoolFile('127.0.0.1:4444', [LAN25], [LAN25, LAN28])
    assert.equal(text, '127.0.0.1:4444\nlan 192.168.86.25:4444\npeer 192.168.86.25:4444\npeer 192.168.86.28:4444\n')
    assert.deepEqual(parsePoolLine(text), LOCAL)
    assert.deepEqual(parsePoolFile(text), { primary: LOCAL, fallbacks: [LAN25], peers: [LAN25, LAN28] })
    assert.deepEqual(parsePoolFile('127.0.0.1:4444\npeer 127.0.0.1:4444\npeer 192.168.86.28:4444\n')?.peers, [LAN28])
  })

  test('the local stack is ready only with a current job', () => {
    assert.equal(localStackReady(readyChecks), true)
    assert.equal(localStackReady({ ...readyChecks, work: 'unknown' }), false)
    assert.equal(localStackReady({ ...readyChecks, work: 'none' }), false)
    assert.equal(localStackReady({ ...readyChecks, node: null }), false)
    assert.equal(localStackReady({ ...readyChecks, panelUp: false }), false)
    assert.equal(localStackReady({ ...readyChecks, node: { fullHeight: null, headersHeight: null, peers: 32 }, gap: null }), false)
    assert.equal(localStackReady(null), false)
  })

  test('the Windows rig: mining through .25, client stopped, node unsynced -> stays on .25', () => {
    const choice = chooseMiningTarget({ primary: LOCAL, fallbacks: [LAN25], localReady: false, localDownForMs: 3_600_000, current: LAN25 })
    assert.deepEqual(choice, { target: LAN25, lanFallback: true })
  })

  test('picks a LAN launcher when not mining yet, and keeps the one already in use', () => {
    assert.deepEqual(chooseMiningTarget({ primary: LOCAL, fallbacks: [LAN25, LAN28], localReady: false, localDownForMs: 0, current: null }), {
      target: LAN25,
      lanFallback: true
    })
    assert.deepEqual(chooseMiningTarget({ primary: LOCAL, fallbacks: [LAN25, LAN28], localReady: false, localDownForMs: 0, current: LAN28 }), {
      target: LAN28,
      lanFallback: true
    })
  })

  test('moves to the local stratum once its client has a job', () => {
    assert.deepEqual(chooseMiningTarget({ primary: LOCAL, fallbacks: [LAN25], localReady: true, localDownForMs: 0, current: LAN25 }), {
      target: LOCAL,
      lanFallback: false
    })
  })

  test('a short local hiccup does not bounce the miner to the LAN', () => {
    const base = { primary: LOCAL, fallbacks: [LAN25], localReady: false, current: LOCAL }
    assert.deepEqual(chooseMiningTarget({ ...base, localDownForMs: LOCAL_GRACE_MS - 1 }), { target: LOCAL, lanFallback: false })
    assert.deepEqual(chooseMiningTarget({ ...base, localDownForMs: LOCAL_GRACE_MS }), { target: LAN25, lanFallback: true })
  })

  test('without fallbacks (none found, or turned off) it waits on the local stratum as before', () => {
    assert.deepEqual(chooseMiningTarget({ primary: LOCAL, fallbacks: [], localReady: false, localDownForMs: 0, current: null }), {
      target: LOCAL,
      lanFallback: false
    })
  })

  test('an ignored launcher is still a mining fallback; the setting turns them all off', () => {
    const own = new Set(['192.168.86.23', '192.168.1.185'])
    const remotes = [{ host: '192.168.86.25', port: 4444 }]
    assert.deepEqual(miningFallbacks(remotes, own, true), remotes)
    assert.deepEqual(miningFallbacks(remotes, own, false), [])
    assert.deepEqual(miningFallbacks([{ host: '192.168.86.23', port: 4444 }], own, true), [])
  })

  test('the rewards wording names the other launcher and its wallet', () => {
    const text = lanFallbackText(LAN25)
    assert.match(text, /^Mining through 192\.168\.86\.25 while this computer's node and Lithos Client are not ready\./)
    assert.match(text, /Shares go to the Lithos Client on 192\.168\.86\.25 and are paid to that launcher's wallet, not this computer's/)
  })

  test('supervisor: no "Stratum moved to 127.0.0.1" while the local stack has no job', async () => {
    const h = harness()
    let localReady = false
    const pick = (): MinerTarget => {
      const current = h.sup.alive ? h.sup.state.target : null
      const c = chooseMiningTarget({ primary: LOCAL, fallbacks: [LAN25], localReady, localDownForMs: localReady ? 0 : 3_600_000, current })
      return { target: c.target, remote: c.lanFallback, checks: null, lanFallback: c.lanFallback, localWaiting: c.lanFallback ? 'no job' : null }
    }
    h.world.target = pick()
    h.sup.begin()
    await h.clock.advance(0)
    assert.equal(h.children.length, 1)
    assert.equal(pool(h.children[0]), '192.168.86.25:4444')
    assert.equal(h.state().lanFallback, true)
    assert.equal(h.state().localWaiting, 'no job')
    h.children[0].print(STATS_LINE)

    for (let i = 0; i < 5; i++) {
      h.world.target = pick()
      await h.clock.advance(POLL_MS)
    }
    assert.deepEqual(h.children[0].signals, [], 'kept mining through .25')
    assert.ok(!h.state().logTail.some((l) => l.includes('Stratum moved to 127.0.0.1')))

    localReady = true
    h.world.target = pick()
    await h.clock.advance(POLL_MS)
    assert.deepEqual(h.children[0].signals, ['SIGTERM'])
    await h.clock.advance(1)
    assert.equal(pool(h.children[1]), '127.0.0.1:4444')
    assert.equal(h.state().lanFallback, false)
  })
})
