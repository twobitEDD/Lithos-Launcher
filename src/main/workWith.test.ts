import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { parseAdvert, parseLauncherExtras, type ChainSeedAdvert, type LauncherAdvertExtras } from '../shared/chainCopy.ts'
import { parseSoatRequest, type StratumTarget } from '../shared/soatMiner.ts'
import {
  DEFAULT_WORK_WITH,
  isLanHost,
  lanLauncherFrom,
  lanLauncherSkip,
  lanLauncherSummary,
  parseWorkWith,
  rankLanLaunchers,
  resolveWorkWith,
  rewardsText,
  walletHolds,
  walletScanState,
  walletWaitText,
  WORK_WITH_GRACE_MS,
  type LanLauncher,
  type WorkWithInput
} from '../shared/workWith.ts'
import { ADVERT_TTL_MS, LanLauncherView } from './lanLaunchers.ts'
import { HANDOFF_STALE_MS, readLauncherHandoff, readServiceConfig, writeLauncherHandoff, writeServiceConfig } from './soatControl.ts'

const LOCAL: StratumTarget = { host: '127.0.0.1', port: 4444 }
const A = '192.168.86.25'
const B = '192.168.86.28'

function advert(patch: Partial<ChainSeedAdvert> = {}): ChainSeedAdvert {
  return {
    v: 1,
    app: 'lithos-launcher',
    available: true,
    network: 'mainnet',
    nodeVersion: '6.0.1',
    db: 'leveldb',
    stateType: 'utxo',
    fullHeight: 1_890_000,
    headersHeight: 1_890_000,
    fullHistory: true,
    historyNote: null,
    chainBytes: 1,
    busy: false,
    ...patch
  }
}

function extras(patch: Partial<LauncherAdvertExtras> = {}, client: Partial<LauncherAdvertExtras['client']> = {}): LauncherAdvertExtras {
  return {
    version: '0.2.1-twobit.8',
    stratumPort: 4444,
    synced: true,
    walletScan: 'done',
    ...patch,
    client: { running: true, hasJob: true, rigs: 2, ...client }
  }
}

function launcher(host: string, patch: Partial<LanLauncher> = {}): LanLauncher {
  return { ...lanLauncherFrom(host, 4444, advert({ launcher: extras() })), ...patch }
}

function input(patch: Partial<WorkWithInput> = {}): WorkWithInput {
  return {
    choice: DEFAULT_WORK_WITH,
    network: 'mainnet',
    primary: LOCAL,
    launchers: [launcher(A), launcher(B)],
    autoHosts: new Set([A, B]),
    localReady: false,
    walletHold: false,
    localDownForMs: WORK_WITH_GRACE_MS * 2,
    current: null,
    ...patch
  }
}

describe('the "Work with" choice', () => {
  test('parses only known modes and private LAN hosts', () => {
    assert.deepEqual(parseWorkWith({ mode: 'auto' }), { mode: 'auto', host: null, scope: 'syncing' })
    assert.deepEqual(parseWorkWith({ mode: 'local', host: A, scope: 'always' }), { mode: 'local', host: null, scope: 'always' })
    assert.deepEqual(parseWorkWith({ mode: 'lan', host: A, scope: 'always' }), { mode: 'lan', host: A, scope: 'always' })
    assert.equal(parseWorkWith({ mode: 'lan', host: '8.8.8.8' }), null)
    assert.equal(parseWorkWith({ mode: 'lan', host: '127.0.0.1' }), null)
    assert.equal(parseWorkWith({ mode: 'lan', host: 'evil.example' }), null)
    assert.equal(parseWorkWith({ mode: 'lan' }), null)
    assert.equal(parseWorkWith({ mode: 'auto', scope: 'forever' }), null)
    assert.equal(parseWorkWith({ mode: 'remote' }), null)
    assert.equal(parseWorkWith(null), null)
  })

  test('the control socket accepts setWorkWith only with a valid choice', () => {
    assert.deepEqual(parseSoatRequest(JSON.stringify({ cmd: 'setWorkWith', workWith: { mode: 'lan', host: B, scope: 'syncing' } })), {
      cmd: 'setWorkWith',
      workWith: { mode: 'lan', host: B, scope: 'syncing' }
    })
    assert.equal(parseSoatRequest(JSON.stringify({ cmd: 'setWorkWith', workWith: { mode: 'lan', host: '1.2.3.4' } })), null)
    assert.equal(parseSoatRequest(JSON.stringify({ cmd: 'setWorkWith' })), null)
  })

  test('LAN hosts are RFC 1918 IPv4 only', () => {
    for (const ok of ['10.0.0.5', '172.16.1.1', '172.31.255.254', '192.168.86.25']) assert.equal(isLanHost(ok), true, ok)
    for (const bad of ['172.32.0.1', '169.254.1.1', '127.0.0.1', '8.8.8.8', '::1', 'localhost', '192.168.1.256', '', 7]) {
      assert.equal(isLanHost(bad), false, String(bad))
    }
  })
})

describe('choosing where to mine', () => {
  test('This computer only never leaves this computer', () => {
    const r = resolveWorkWith(input({ choice: { mode: 'local', host: null, scope: 'syncing' } }))
    assert.deepEqual(r, { target: LOCAL, lanFallback: false, remote: false, via: null, note: null })
  })

  test('Automatic: this computer when ready, otherwise the best LAN launcher', () => {
    assert.deepEqual(resolveWorkWith(input({ localReady: true })).target, LOCAL)
    const busy = launcher(A, { hasJob: false })
    const ready = launcher(B, { hasJob: true })
    const r = resolveWorkWith(input({ launchers: [busy, ready] }))
    assert.deepEqual(r, { target: { host: B, port: 4444 }, lanFallback: true, remote: true, via: B, note: null })
  })

  test('Automatic keeps the launcher it already mines through, and holds this computer for a short grace', () => {
    const r = resolveWorkWith(input({ current: { host: B, port: 4444 } }))
    assert.equal(r.via, B)
    const grace = resolveWorkWith(input({ current: LOCAL, localDownForMs: 5000 }))
    assert.deepEqual(grace.target, LOCAL)
  })

  test('Automatic only uses launchers "mine through a LAN launcher" allows', () => {
    const r = resolveWorkWith(input({ autoHosts: new Set() }))
    assert.deepEqual(r.target, LOCAL)
  })

  test('a launcher on the other network is never used', () => {
    const testnet = launcher(A, { network: 'testnet' })
    assert.match(lanLauncherSkip(testnet, 'mainnet')!, /testnet/)
    assert.deepEqual(resolveWorkWith(input({ launchers: [testnet] })).target, LOCAL)
    const picked = resolveWorkWith(input({ launchers: [testnet], choice: { mode: 'lan', host: A, scope: 'always' } }))
    assert.deepEqual(picked.target, LOCAL)
    assert.match(picked.note!, /runs testnet/)
  })

  test('a picked launcher, only while syncing, returns here once the client has a job and the wallet has scanned', () => {
    const choice = { mode: 'lan' as const, host: A, scope: 'syncing' as const }
    const syncing = resolveWorkWith(input({ choice }))
    assert.deepEqual(syncing, { target: { host: A, port: 4444 }, lanFallback: true, remote: true, via: A, note: null })
    const walletScanning = resolveWorkWith(input({ choice, localReady: true, walletHold: true }))
    assert.equal(walletScanning.via, A, 'the wallet scan keeps it on the LAN launcher')
    const back = resolveWorkWith(input({ choice, localReady: true, walletHold: false, current: { host: A, port: 4444 } }))
    assert.deepEqual(back.target, LOCAL)
    assert.equal(back.via, null)
  })

  test('a picked launcher, always, stays there even when this computer is ready', () => {
    const r = resolveWorkWith(input({ choice: { mode: 'lan', host: B, scope: 'always' }, localReady: true }))
    assert.deepEqual(r, { target: { host: B, port: 4444 }, lanFallback: false, remote: true, via: B, note: null })
  })

  test('a picked launcher that is gone or stopped falls back to this computer, with a note', () => {
    const gone = resolveWorkWith(input({ choice: { mode: 'lan', host: '192.168.86.99', scope: 'always' } }))
    assert.deepEqual(gone.target, LOCAL)
    assert.match(gone.note!, /not found/)
    const stopped = resolveWorkWith(input({ launchers: [launcher(A, { clientRunning: false })], choice: { mode: 'lan', host: A, scope: 'always' } }))
    assert.match(stopped.note!, /Lithos Client is not running/)
  })

  test('ranking: a job, then synced, then height, then the lowest address', () => {
    const list = [
      launcher('192.168.86.40', { hasJob: null }),
      launcher('192.168.86.30', { hasJob: true, synced: false }),
      launcher('192.168.86.20', { hasJob: true, synced: true, fullHeight: 10 }),
      launcher('192.168.86.10', { hasJob: true, synced: true, fullHeight: 10 }),
      launcher('192.168.86.5', { stratumPort: null })
    ]
    assert.deepEqual(
      rankLanLaunchers(list, 'mainnet').map((l) => l.host),
      ['192.168.86.10', '192.168.86.20', '192.168.86.30', '192.168.86.40']
    )
  })

  test('rewards say whose wallet is paid', () => {
    assert.match(rewardsText(null), /this computer's wallet/)
    assert.match(rewardsText(A), new RegExp(`Lithos Client on ${A.replace(/\./g, '\\.')}.*not this computer's`))
  })
})

describe('the wallet scan', () => {
  const base = { phase: 'unlocked', walletHeight: 100, nodeRunning: true, fullHeight: 100, headersHeight: 100 }
  test('states', () => {
    assert.equal(walletScanState({ ...base, phase: 'uninitialized' }).state, 'none')
    assert.equal(walletScanState({ ...base, phase: 'locked' }).state, 'locked')
    assert.equal(walletScanState({ ...base, headersHeight: 5000 }).state, 'waiting-node')
    assert.equal(walletScanState({ ...base, nodeRunning: false }).state, 'waiting-node')
    assert.equal(walletScanState({ ...base, walletHeight: 50 }).state, 'scanning')
    assert.equal(walletScanState({ ...base, walletHeight: 98 }).state, 'done')
    assert.equal(walletScanState({ ...base, walletHeight: null }).state, 'unknown')
    assert.equal(walletHolds('waiting-node'), true)
    assert.equal(walletHolds('scanning'), true)
    for (const s of ['done', 'unknown', 'locked', 'none', null] as const) assert.equal(walletHolds(s), false)
  })

  test('the picker says the wallet waits on this node, and where it mines meanwhile', () => {
    assert.equal(
      walletWaitText({ state: 'waiting-node', height: null, tip: null }, A),
      `Your wallet will scan once this node syncs; meanwhile mining through ${A}.`
    )
    assert.equal(walletWaitText({ state: 'scanning', height: 500, tip: 1000 }, null), 'Your wallet is scanning the chain (block 500 of 1,000).')
    assert.equal(walletWaitText({ state: 'done', height: 1, tip: 1 }, A), null)
  })
})

describe('the 9077 advert, old and new', () => {
  test('an old advert parses as before, with no launcher part', () => {
    const old = parseAdvert(advert())
    assert.deepEqual(old, advert())
    assert.equal('launcher' in old!, false)
    const row = lanLauncherFrom(A, 4444, old)
    assert.equal(row.advert, 'basic')
    assert.equal(row.clientRunning, null)
    assert.equal(row.synced, true, 'synced comes from the old heights')
    assert.match(lanLauncherSummary(row), /older launcher/)
  })

  test('a new advert keeps its launcher part; secrets and junk are dropped', () => {
    const parsed = parseAdvert({ ...advert(), launcher: { ...extras(), apiKey: 'x', client: { running: true, hasJob: false, rigs: 3, address: '9f...' } } })
    assert.deepEqual(parsed!.launcher, extras({}, { hasJob: false, rigs: 3 }))
    const row = lanLauncherFrom(B, null, parsed)
    assert.equal(row.stratumPort, 4444, 'the stratum port comes from the advert when the scan did not find it')
    assert.equal(row.stratumSeen, false)
    assert.equal(row.advert, 'full')
    assert.match(lanLauncherSummary(row), /client has no job yet · 3 rigs · v0\.2\.1-twobit\.8/)
  })

  test('a malformed launcher part is ignored, not fatal', () => {
    assert.equal(parseLauncherExtras({ client: 'yes' }), null)
    assert.equal(parseLauncherExtras(null), null)
    const parsed = parseAdvert({ ...advert(), launcher: { client: { running: 'yes' } } })
    assert.notEqual(parsed, null)
    assert.equal(parsed!.launcher, undefined)
    const odd = parseLauncherExtras({ version: '<script>', stratumPort: 99999, walletScan: 'hacked', client: { running: false, rigs: -1 } })
    assert.deepEqual(odd, { version: null, stratumPort: null, synced: null, walletScan: null, client: { running: false, hasJob: null, rigs: null } })
  })

  test('no advert at all still lists a stratum the scan found', () => {
    const row = lanLauncherFrom(A, 4444, null)
    assert.equal(row.advert, 'none')
    assert.equal(lanLauncherSkip(row, 'mainnet'), null)
    assert.match(lanLauncherSummary(row), /no details/)
  })
})

const temps: string[] = []
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

describe('the service side', () => {
  test('LAN launcher view: private hosts only, adverts cached for a while', async () => {
    const asked: string[] = []
    let now = 1_000_000
    const view = new LanLauncherView(
      async (host) => {
        asked.push(host)
        return host === A ? advert({ launcher: extras() }) : null
      },
      () => now
    )
    const rows = await view.list([{ host: A, port: 4444 }, { host: '8.8.8.8', port: 4444 }], [B, '127.0.0.1', A])
    assert.deepEqual(
      rows.map((r) => [r.host, r.advert, r.stratumPort]),
      [
        [A, 'full', 4444],
        [B, 'none', null]
      ]
    )
    assert.deepEqual(asked.sort(), [A, B])
    await view.list([{ host: A, port: 4444 }], [B])
    assert.equal(asked.length, 2, 'cached')
    now += ADVERT_TTL_MS
    await view.list([{ host: A, port: 4444 }], [])
    assert.equal(asked.length, 3, 'asked again after the TTL, and not for hosts no longer listed')
  })

  test('the launcher hand-off: written, read back, filtered, and ignored once stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lithos-handoff-'))
    temps.push(dir)
    const file = join(dir, 'launcher-state.json')
    assert.equal(await readLauncherHandoff(file), null)
    await writeLauncherHandoff(file, { network: 'mainnet', walletScan: { state: 'scanning', height: 5, tip: 10 }, hosts: [A, '8.8.8.8', A] }, 1000)
    const back = await readLauncherHandoff(file, 2000)
    assert.deepEqual(back, { writtenAt: 1000, network: 'mainnet', walletScan: { state: 'scanning', height: 5, tip: 10 }, hosts: [A] })
    assert.equal(await readLauncherHandoff(file, 1000 + HANDOFF_STALE_MS + 1), null)
    await writeFile(file, '{"writtenAt":1000,"walletScan":{"state":"bogus"}}')
    assert.equal((await readLauncherHandoff(file, 1000))!.walletScan, null)
  })

  test('the service keeps the choice in its settings file; older files mean Automatic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lithos-workwith-'))
    temps.push(dir)
    const file = join(dir, 'soat-service.json')
    await writeServiceConfig(file, { autoStart: true, userStopped: false, network: 'mainnet', workWith: { mode: 'lan', host: A, scope: 'always' } })
    assert.deepEqual((await readServiceConfig(file)).workWith, { mode: 'lan', host: A, scope: 'always' })
    await writeFile(file, JSON.stringify({ autoStart: true, workWith: { mode: 'lan', host: '1.1.1.1' } }))
    assert.equal((await readServiceConfig(file)).workWith, undefined)
  })
})
