import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { blocksStillMissing, buildNodeSyncDetails, hostOnLan, parsePeerAddress, type SyncSubnet } from '../shared/syncDetails.ts'
import { NodeApi } from './nodeApi.ts'

const TIP = 1_890_270
const HISTORY_FROM = 1_880_064
const SUFFIX = TIP - HISTORY_FROM + 1
const FULL = 5_000
const LAN: SyncSubnet[] = [{ address: '192.168.86.25', netmask: '255.255.255.0' }]
const OWN = new Set(['127.0.0.1', '192.168.86.25'])

function peer(address: string, suffix: number) {
  return {
    address,
    version: '6.0.1',
    mode: { state: 'utxo', verifyingTransactions: true, fullBlocksSuffix: suffix },
    status: 'Older',
    height: TIP
  }
}

describe('parsePeerAddress', () => {
  test('reads Java socket text and a plain host:port', () => {
    assert.deepEqual(parsePeerAddress('/192.168.86.28:9030'), { host: '192.168.86.28', port: 9030 })
    assert.deepEqual(parsePeerAddress('ergo/192.168.86.23:9030'), { host: '192.168.86.23', port: 9030 })
    assert.deepEqual(parsePeerAddress('192.168.86.28:9030'), { host: '192.168.86.28', port: 9030 })
    assert.equal(parsePeerAddress('N/A'), null)
  })
})

describe('hostOnLan', () => {
  test('same subnet is local, this machine and the public internet are not', () => {
    assert.equal(hostOnLan('192.168.86.28', LAN, OWN), true)
    assert.equal(hostOnLan('192.168.86.23', LAN, OWN), true)
    assert.equal(hostOnLan('192.168.86.25', LAN, OWN), false)
    assert.equal(hostOnLan('192.168.1.20', LAN, OWN), false)
    assert.equal(hostOnLan('159.65.10.10', LAN, OWN), false)
  })
})

describe('blocksStillMissing', () => {
  test('counts full blocks short of the announced chain', () => {
    assert.equal(blocksStillMissing(TIP, FULL, TIP), TIP - FULL)
    assert.equal(blocksStillMissing(null, null, TIP), null)
    assert.equal(blocksStillMissing(10, 10, 10), 0)
  })
})

describe('buildNodeSyncDetails', () => {
  test('LAN peers that start late are not treated as the source of a long download', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: [
        peer('/192.168.86.28:9030', SUFFIX),
        peer('/192.168.86.23:9030', SUFFIX),
        peer('/159.65.10.10:9030', -1)
      ],
      connected: [
        { address: '/192.168.86.28:9030', connectionType: 'Outgoing' },
        { address: '/192.168.86.23:9030', connectionType: 'Incoming' },
        { address: '/159.65.10.10:9030', connectionType: 'Outgoing' }
      ],
      track: {
        invalidModifierApproxSize: 0,
        requested: {
          BlockTransactions: { aaa: { address: '/192.168.86.28:9030', checks: 1 } }
        },
        received: {
          Header: { bbb: { address: '/192.168.86.28:9030' } },
          BlockTransactions: { ccc: { address: '/159.65.10.10:9030' } }
        }
      },
      ifaces: LAN,
      own: OWN
    })

    assert.equal(details.blocksRemaining, TIP - FULL)
    assert.equal(details.etaIsNodeSync, true)
    assert.match(details.lanNote ?? '', /1,880,064/)
    assert.match(details.lanNote ?? '', /none have arrived/)
    assert.match(details.lanNote ?? '', /both already have/)
    assert.equal(/sending block bodies/.test(details.lanNote ?? ''), false)

    const local = details.peers.filter((row) => row.lan)
    assert.deepEqual(
      local.map((row) => row.host).sort(),
      ['192.168.86.23', '192.168.86.28']
    )
    const best = local.find((row) => row.host === '192.168.86.28')
    assert.equal(best?.direction, 'outgoing')
    assert.equal(best?.remoteHeight, TIP)
    assert.equal(best?.historyFrom, HISTORY_FROM)
    assert.equal(best?.sendingBlocks, false)
    assert.equal(best?.blockRequested, true)
    assert.equal(local.find((row) => row.host === '192.168.86.23')?.direction, 'incoming')

    const remote = details.peers.find((row) => row.host === '159.65.10.10')
    assert.equal(remote?.lan, false)
    assert.equal(remote?.historyFrom, 1)
    assert.equal(remote?.sendingBlocks, true)
  })

  test('headers alone do not count as block bodies', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: [peer('/192.168.86.28:9030', SUFFIX)],
      connected: [{ address: '/192.168.86.28:9030', connectionType: 'Outgoing' }],
      track: {
        requested: {},
        received: { Header: { bbb: { address: '/192.168.86.28:9030' } } }
      },
      ifaces: LAN,
      own: OWN
    })
    assert.equal(details.peers[0]?.sendingBlocks, false)
    assert.match(details.lanNote ?? '', /not sending block bodies/)
    assert.equal(details.etaIsNodeSync, true)
  })

  test('a local peer that reports the whole chain and has delivered a body is credited', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: [peer('/192.168.86.28:9030', -1)],
      connected: [{ address: '/192.168.86.28:9030', connectionType: 'Outgoing' }],
      track: {
        requested: {},
        received: { BlockTransactions: { ccc: { address: '/192.168.86.28:9030' } } }
      },
      ifaces: LAN,
      own: OWN
    })
    assert.equal(details.peers[0]?.sendingBlocks, true)
    assert.equal(details.peers[0]?.historyFrom, 1)
    assert.equal(details.etaIsNodeSync, false)
    assert.match(details.lanNote ?? '', /A local peer is sending block bodies/)
    assert.equal(/only from about height/.test(details.lanNote ?? ''), false)
  })

  test('a full-history local peer with no bodies is not described as missing the early chain', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: [peer('/192.168.86.28:9030', -1)],
      connected: [],
      track: { requested: {}, received: {} },
      ifaces: LAN,
      own: OWN
    })
    assert.match(details.lanNote ?? '', /not receiving block bodies/)
    assert.equal(/only from about height/.test(details.lanNote ?? ''), false)
    assert.equal(details.etaIsNodeSync, false)
  })

  test('no local peers means the countdown is not a LAN download', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: [peer('/159.65.10.10:9030', -1)],
      connected: [{ address: '/159.65.10.10:9030', connectionType: 'Outgoing' }],
      track: { requested: {}, received: {} },
      ifaces: LAN,
      own: OWN
    })
    assert.match(details.lanNote ?? '', /No local peers are connected/)
    assert.equal(details.etaIsNodeSync, true)
    assert.equal(details.peers[0]?.lan, false)
    assert.equal(details.peers[0]?.sendingBlocks, false)
  })

  test('a failed peer read does not invent an empty peer list', () => {
    const details = buildNodeSyncDetails({
      headersHeight: TIP,
      fullHeight: FULL,
      maxPeerHeight: TIP,
      syncInfo: null,
      connected: null,
      track: null,
      ifaces: LAN,
      own: OWN
    })
    assert.equal(details.peersKnown, false)
    assert.equal(details.trackKnown, false)
    assert.equal(details.lanNote, null)
    assert.equal(details.etaIsNodeSync, false)
    assert.equal(details.headersHeight, TIP)
    assert.equal(details.blocksRemaining, TIP - FULL)
  })
})

test('peer debug calls the node peer routes and does not claim traffic the body did not name', async () => {
  const seen: { url: string; apiKey: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({ url: String(url), apiKey: headers.get('api_key') })
    const path = String(url)
    const body = path.endsWith('/syncInfo')
      ? [peer('/192.168.86.28:9030', 4)]
      : path.endsWith('/connected')
        ? [{ address: '/192.168.86.28:9030', connectionType: 'Outgoing' }]
        : { requested: {}, received: { Header: { h: { address: '/192.168.86.28:9030' } } } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    const api = new NodeApi(9053)
    const [syncInfo, connected, track] = await Promise.all([
      api.peerSyncInfo('secret'),
      api.connectedPeers('secret'),
      api.peerTrackInfo('secret')
    ])
    assert.deepEqual(
      seen.map((call) => call.url),
      [
        'http://127.0.0.1:9053/peers/syncInfo',
        'http://127.0.0.1:9053/peers/connected',
        'http://127.0.0.1:9053/peers/trackInfo'
      ]
    )
    assert.equal(
      seen.every((call) => call.apiKey === 'secret'),
      true
    )
    const details = buildNodeSyncDetails({
      headersHeight: 20,
      fullHeight: 1,
      maxPeerHeight: 20,
      syncInfo,
      connected,
      track,
      ifaces: LAN,
      own: OWN
    })
    assert.equal(details.peers[0]?.lan, true)
    assert.equal(details.peers[0]?.direction, 'outgoing')
    assert.equal(details.peers[0]?.remoteHeight, TIP)
    assert.equal(details.peers[0]?.historyFrom, TIP - 4 + 1)
    assert.equal(details.peers[0]?.sendingBlocks, false)
  } finally {
    globalThis.fetch = original
  }
})

test('sync details stay closed until the control is opened', async () => {
  const source = await readFile(new URL('../renderer/src/lib/NodeCard.svelte', import.meta.url), 'utf8')
  assert.match(source, /let detailsOpen = \$state\(false\)/)
  assert.match(source, /aria-expanded=\{detailsOpen\}/)
  assert.match(source, /Sync details/)
  const panel = await readFile(new URL('../renderer/src/lib/SyncDetails.svelte', import.meta.url), 'utf8')
  assert.match(panel, /Still to download/)
  assert.match(panel, /On this LAN/)
  assert.match(panel, /sending block bodies/)
  assert.match(panel, /That time is this node's own sync, not from the LAN/)
  const opened = source.match(/\{#if detailsOpen\}[\s\S]*?\{\/if\}/g) ?? []
  assert.equal(
    opened.some((block) => block.includes('<SyncDetails')),
    true
  )
  const outside = source.replace(/\{#if detailsOpen\}[\s\S]*?\{\/if\}/g, '')
  assert.equal(outside.includes('<SyncDetails'), false)
})
