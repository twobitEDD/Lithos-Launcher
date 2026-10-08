import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planNodeAutoStart, type NodeAutoStartInput, type NodePortCheck } from '../shared/nodeAutoStart.ts'
import { resolveNodeStart } from './nodeStart.ts'

function input(over: Partial<NodeAutoStartInput> = {}): NodeAutoStartInput & { portChecks: () => number } {
  let checks = 0
  const check = over.checkPort ?? (async (): Promise<NodePortCheck> => ({ action: 'start' }))
  return {
    enabled: true,
    attempted: false,
    nodeStatus: 'stopped',
    installing: false,
    remoteLauncher: null,
    javaInstalled: true,
    nodeInstalled: true,
    apiPort: 9053,
    ...over,
    checkPort: () => {
      checks++
      return check()
    },
    portChecks: () => checks
  }
}

test('starts the node when everything is installed and the API port is free', async () => {
  const i = input()
  assert.deepEqual(await planNodeAutoStart(i), { action: 'start' })
  assert.equal(i.portChecks(), 1)
})

test('adopts a node already running on the API port with a key this launcher knows', async () => {
  const i = input({
    checkPort: async () => {
      const d = await resolveNodeStart({ portOpen: true, keys: ['stored'], accepts: async (k) => k === 'stored' })
      return { action: d.action }
    }
  })
  assert.deepEqual(await planNodeAutoStart(i), { action: 'adopt' })
})

test('skips with a reason when the API port belongs to a node this launcher cannot use', async () => {
  const i = input({
    checkPort: async () => {
      const d = await resolveNodeStart({ portOpen: true, keys: ['stored'], accepts: async () => false })
      return { action: d.action }
    }
  })
  const plan = await planNodeAutoStart(i)
  assert.equal(plan.action, 'skip')
  assert.equal(plan.action === 'skip' && plan.reason, 'port-busy')
  assert.match(plan.action === 'skip' ? (plan.message ?? '') : '', /port 9053/)
})

test('does nothing when the setting is off', async () => {
  const i = input({ enabled: false })
  assert.deepEqual(await planNodeAutoStart(i), { action: 'skip', reason: 'off', message: null })
  assert.equal(i.portChecks(), 0)
})

test('runs once per launcher session: a reopened window does not start it again', async () => {
  const i = input({ attempted: true })
  assert.deepEqual(await planNodeAutoStart(i), { action: 'skip', reason: 'already-tried', message: null })
  assert.equal(i.portChecks(), 0)
})

test('leaves a node that is already starting or running alone', async () => {
  for (const nodeStatus of ['starting', 'running', 'stopping'] as const) {
    const plan = await planNodeAutoStart(input({ nodeStatus }))
    assert.equal(plan.action === 'skip' && plan.reason, 'already-running', nodeStatus)
  }
})

test('a node that crashed earlier may be started again', async () => {
  assert.deepEqual(await planNodeAutoStart(input({ nodeStatus: 'crashed' })), { action: 'start' })
})

test('defers to a launcher on another machine without probing the local port', async () => {
  const i = input({ remoteLauncher: { host: '192.168.1.20', port: 3333 } })
  const plan = await planNodeAutoStart(i)
  assert.equal(plan.action === 'skip' && plan.reason, 'remote-launcher')
  assert.match(plan.action === 'skip' ? (plan.message ?? '') : '', /192\.168\.1\.20:3333/)
  assert.equal(i.portChecks(), 0)
})

test('an ignored remote launcher (reported as none) lets the node start locally', async () => {
  assert.deepEqual(await planNodeAutoStart(input({ remoteLauncher: null })), { action: 'start' })
})

test('explains a missing Java or node install', async () => {
  const noJava = await planNodeAutoStart(input({ javaInstalled: false, nodeInstalled: false }))
  assert.equal(noJava.action === 'skip' && noJava.reason, 'no-java')
  assert.match(noJava.action === 'skip' ? (noJava.message ?? '') : '', /Java is not installed/)
  const noNode = await planNodeAutoStart(input({ nodeInstalled: false }))
  assert.equal(noNode.action === 'skip' && noNode.reason, 'no-node')
  assert.match(noNode.action === 'skip' ? (noNode.message ?? '') : '', /Ergo node is not installed/)
})

test('waits for a running install instead of starting mid-download', async () => {
  const plan = await planNodeAutoStart(input({ installing: true }))
  assert.equal(plan.action === 'skip' && plan.reason, 'installing')
})
