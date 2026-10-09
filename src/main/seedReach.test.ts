import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import { seedUnreachableNote, unreachableSeeds, type PortProbe } from '../shared/chainCopy.ts'
import { buildNodeSyncDetails } from '../shared/syncDetails.ts'
import { probePortDetail } from './lanPeerProbe.ts'

describe('LAN seed reachability', () => {
  test('lists Ergo hosts that did not offer a chain, with why', () => {
    const probes = new Map<string, PortProbe>([
      ['192.168.86.28', 'timeout'],
      ['192.168.86.30', 'refused'],
      ['192.168.86.31', 'open']
    ])
    const rows = unreachableSeeds(
      ['192.168.86.25', '192.168.86.28', '192.168.86.30', '192.168.86.31', '192.168.86.40'],
      new Set(['192.168.86.25']),
      probes,
      new Set(['192.168.86.40'])
    )
    assert.deepEqual(rows, [
      { host: '192.168.86.28', reason: 'timeout' },
      { host: '192.168.86.30', reason: 'refused' },
      { host: '192.168.86.31', reason: 'no-advert' }
    ])
  })

  test('the note says firewall for a timeout and old launcher for a refusal', () => {
    assert.match(seedUnreachableNote({ host: 'h', reason: 'timeout' }), /firewall.*allow TCP 9077/)
    assert.match(seedUnreachableNote({ host: 'h', reason: 'refused' }), /older than 0\.2\.1-twobit\.5/)
    assert.match(seedUnreachableNote({ host: 'h', reason: 'no-advert' }), /not with a Lithos chain advert/)
  })

  test('probePortDetail tells open from refused on loopback', async () => {
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    assert.equal(await probePortDetail('127.0.0.1', port, 1000), 'open')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    assert.equal(await probePortDetail('127.0.0.1', port, 1000), 'refused')
  })
})

describe('sync details on a fresh node', () => {
  const base = {
    headersHeight: 0,
    fullHeight: null,
    maxPeerHeight: null,
    ifaces: [{ address: '192.168.86.40', netmask: '255.255.255.0' }],
    own: new Set(['127.0.0.1', '192.168.86.40'])
  }

  test('connected peers with no sync status yet are counted as having no height', () => {
    const details = buildNodeSyncDetails({
      ...base,
      syncInfo: [],
      connected: [
        { address: '/5.6.7.8:9030', connectionType: 'Outgoing' },
        { address: '/9.9.9.9:9030', connectionType: 'Outgoing' }
      ],
      track: { received: {}, requested: {} }
    })
    assert.equal(details.syncInfoKnown, true)
    assert.equal(details.peers.length, 2)
    assert.equal(details.peersWithHeight, 0)
  })

  test('a failed /peers/syncInfo is reported as unknown, not as heightless peers', () => {
    const details = buildNodeSyncDetails({
      ...base,
      syncInfo: null,
      connected: [{ address: '/5.6.7.8:9030', connectionType: 'Outgoing' }],
      track: null
    })
    assert.equal(details.syncInfoKnown, false)
    assert.equal(details.peersKnown, true)
  })
})
