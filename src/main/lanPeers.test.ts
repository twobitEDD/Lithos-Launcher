import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { describe, test } from 'node:test'
import type { LanIface } from '../shared/lanDefer.ts'
import { addLanPeers, lanPeerLabel, MAX_LAN_PEERS, peeringAllowed, skipSelf } from '../shared/lanPeers.ts'
import { discoverLanPeers } from './lanPeerDiscover.ts'
import { probePeerPort } from './lanPeerProbe.ts'

const LAN: LanIface[] = [{ address: '192.168.86.25', netmask: '255.255.255.0' }]
const OWN = new Set(['127.0.0.1', '192.168.86.25', '172.17.0.1'])

describe('skipSelf', () => {
  test('drops this machine and keeps another node', () => {
    assert.deepEqual(
      skipSelf(
        [
          { host: '192.168.86.25', port: 9030 },
          { host: '127.0.0.1', port: 9030 },
          { host: '192.168.86.40', port: 9030 }
        ],
        OWN
      ),
      [{ host: '192.168.86.40', port: 9030 }]
    )
  })
})

describe('discoverLanPeers', () => {
  test('peer found on the Ergo peer port', async () => {
    const peers = await discoverLanPeers({
      ifaces: LAN,
      own: OWN,
      port: 9030,
      probe: async (host, port) => host === '192.168.86.40' && port === 9030
    })
    assert.deepEqual(peers, [{ host: '192.168.86.40', port: 9030 }])
  })

  test('no peer', async () => {
    assert.deepEqual(
      await discoverLanPeers({
        ifaces: LAN,
        own: OWN,
        port: 9030,
        probe: async () => false
      }),
      []
    )
  })

  test('does not probe this machine', async () => {
    let sawSelf = false
    const peers = await discoverLanPeers({
      ifaces: LAN,
      own: OWN,
      port: 9030,
      probe: async (host) => {
        if (OWN.has(host)) sawSelf = true
        return host === '192.168.86.40'
      }
    })
    assert.equal(sawSelf, false)
    assert.deepEqual(peers, [{ host: '192.168.86.40', port: 9030 }])
  })

  test('caps a subnet where every host accepts the port', async () => {
    const peers = await discoverLanPeers({
      ifaces: LAN,
      own: OWN,
      port: 9030,
      probe: async () => true
    })
    assert.equal(peers.length, MAX_LAN_PEERS)
    assert.equal(peers.some((peer) => OWN.has(peer.host)), false)
    assert.equal(peers[0]?.host, '192.168.86.1')
  })
})

describe('addLanPeers', () => {
  test('connects to the other node and skips our own address', async () => {
    const asked: string[] = []
    const { added, failed } = await addLanPeers(
      [
        { host: '192.168.86.25', port: 9030 },
        { host: '192.168.86.40', port: 9030 },
        { host: '192.168.86.41', port: 9030 }
      ],
      OWN,
      async (address) => {
        asked.push(address)
        if (address === '192.168.86.41:9030') throw new Error('refused')
      }
    )
    assert.deepEqual(asked, ['192.168.86.40:9030', '192.168.86.41:9030'])
    assert.deepEqual(added, [{ host: '192.168.86.40', port: 9030 }])
    assert.deepEqual(failed, [{ host: '192.168.86.41', port: 9030 }])
  })
})

describe('lanPeerLabel', () => {
  test('found, none, and off', () => {
    assert.equal(lanPeerLabel({ enabled: true, phase: 'done', found: 2 }), 'Found 2 local peers')
    assert.equal(lanPeerLabel({ enabled: true, phase: 'done', found: 1 }), 'Found 1 local peer')
    assert.equal(lanPeerLabel({ enabled: true, phase: 'done', found: 0 }), 'No local peers')
    assert.equal(lanPeerLabel({ enabled: true, phase: 'idle', found: 0 }), null)
    assert.equal(lanPeerLabel({ enabled: false, phase: 'idle', found: 0 }), 'LAN peering off')
    assert.equal(peeringAllowed(undefined), true)
    assert.equal(peeringAllowed(false), false)
  })
})

describe('probePeerPort', () => {
  test('an open port counts and a closed port does not, with nothing written', async () => {
    let received = 0
    const server: Server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    try {
      assert.equal(await probePeerPort('127.0.0.1', addr.port, 500), true)
      assert.equal(await probePeerPort('127.0.0.1', 1, 200), false)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(received, 0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })
})
