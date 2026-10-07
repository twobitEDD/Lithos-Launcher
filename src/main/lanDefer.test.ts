import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { describe, test } from 'node:test'
import {
  decideDefer,
  ignoreLauncher,
  isStratumReply,
  localStartAllowed,
  scanTargets,
  searchLan,
  type LanIface
} from '../shared/lanDefer.ts'
import { probeStratum } from './lanDiscover.ts'

const LAN: LanIface[] = [{ address: '192.168.86.25', netmask: '255.255.255.0' }]
const OWN = new Set(['127.0.0.1', '192.168.86.25', '172.17.0.1'])

describe('scanTargets', () => {
  test('skips this machine and does not sweep a wide bridge network', () => {
    const hosts = scanTargets(
      [...LAN, { address: '172.17.0.1', netmask: '255.255.0.0' }],
      OWN
    )
    assert.equal(hosts.includes('192.168.86.25'), false)
    assert.equal(hosts.includes('192.168.86.0'), false)
    assert.equal(hosts.includes('192.168.86.255'), false)
    assert.equal(hosts.includes('172.17.0.2'), false)
    assert.equal(hosts.includes('192.168.86.1'), true)
    assert.equal(hosts.includes('192.168.86.254'), true)
    assert.equal(hosts.length, 253)
  })
})

describe('decideDefer', () => {
  test('peer found', () => {
    const decision = decideDefer({
      localStratumOpen: false,
      remotes: [{ host: '192.168.86.40', port: 4444 }],
      own: OWN
    })
    assert.deepEqual(decision, { action: 'defer', host: '192.168.86.40', port: 4444 })
  })

  test('no peer', () => {
    assert.deepEqual(decideDefer({ localStratumOpen: false, remotes: [], own: OWN }), {
      action: 'local',
      reason: 'no-peer'
    })
  })

  test('only myself', () => {
    assert.deepEqual(
      decideDefer({
        localStratumOpen: false,
        remotes: [{ host: '192.168.86.25', port: 4444 }],
        own: OWN
      }),
      { action: 'local', reason: 'no-peer' }
    )
  })

  test('another machine defers and this computer is not treated as that launcher', () => {
    const decision = decideDefer({
      localStratumOpen: false,
      remotes: [
        { host: '192.168.86.25', port: 4444 },
        { host: '127.0.0.1', port: 4444 },
        { host: '192.168.86.28', port: 4444 }
      ],
      own: OWN
    })
    assert.deepEqual(decision, { action: 'defer', host: '192.168.86.28', port: 4444 })
  })

  test('ignoring the other machine clears deferral and allows a local start', () => {
    const remote = { host: '192.168.86.28', port: 4444 }
    const before = decideDefer({ localStratumOpen: false, remotes: [remote], own: OWN })
    assert.deepEqual(before, { action: 'defer', host: '192.168.86.28', port: 4444 })
    assert.equal(localStartAllowed(remote, new Set()), false)
    const ignored = ignoreLauncher(remote, [])
    assert.deepEqual(ignored, ['192.168.86.28'])
    assert.equal(localStartAllowed(remote, new Set(ignored)), true)
    assert.deepEqual(
      decideDefer({ localStratumOpen: false, remotes: [remote], own: OWN, ignored: new Set(ignored) }),
      { action: 'local', reason: 'no-peer' }
    )
  })

  test('this machine already serving ignores a remote and does not say to stop', () => {
    assert.deepEqual(
      decideDefer({
        localStratumOpen: true,
        remotes: [{ host: '192.168.86.40', port: 4444 }],
        own: OWN
      }),
      { action: 'local', reason: 'this-machine-already-serving' }
    )
  })
})

describe('searchLan', () => {
  test('does not probe anyone when this computer is already the launcher', async () => {
    let calls = 0
    const decision = await searchLan({
      ifaces: LAN,
      own: OWN,
      port: 4444,
      localStratumOpen: true,
      probe: async () => {
        calls++
        return true
      }
    })
    assert.equal(calls, 0)
    assert.deepEqual(decision, { action: 'local', reason: 'this-machine-already-serving' })
  })

  test('peer found vs no peer vs only myself', async () => {
    const probe = async (host: string): Promise<boolean> => host === '192.168.86.40'
    assert.deepEqual(
      await searchLan({ ifaces: LAN, own: OWN, port: 4444, localStratumOpen: false, probe }),
      { action: 'defer', host: '192.168.86.40', port: 4444 }
    )
    assert.deepEqual(
      await searchLan({
        ifaces: LAN,
        own: OWN,
        port: 4444,
        localStratumOpen: false,
        probe: async () => false
      }),
      { action: 'local', reason: 'no-peer' }
    )
    let sawSelf = false
    await searchLan({
      ifaces: LAN,
      own: OWN,
      port: 4444,
      localStratumOpen: false,
      probe: async (host) => {
        if (host === '192.168.86.25') sawSelf = true
        return false
      }
    })
    assert.equal(sawSelf, false)
  })
})

describe('isStratumReply', () => {
  test('accepts a subscribe result and rejects http', () => {
    assert.equal(
      isStratumReply('{"id":1,"result":[[["mining.notify","abc"]],"00",4],"error":null}\n'),
      true
    )
    assert.equal(isStratumReply('HTTP/1.1 200 OK\r\n'), false)
    assert.equal(isStratumReply(''), false)
  })
})

describe('probeStratum', () => {
  test('a local fake stratum answers and a closed port does not', async () => {
    const server: Server = createServer((socket) => {
      socket.once('data', () => {
        socket.end('{"id":1,"result":[null,"00"],"error":null}\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    try {
      assert.equal(await probeStratum('127.0.0.1', addr.port, 500), true)
      assert.equal(await probeStratum('127.0.0.1', 1, 200), false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })
})
