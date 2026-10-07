import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveNodeStart } from './nodeStart.ts'

test('a closed port starts a node and does not probe keys', async () => {
  let probes = 0
  const decision = await resolveNodeStart({
    portOpen: false,
    keys: ['stored-key'],
    accepts: async () => {
      probes++
      return true
    }
  })
  assert.deepEqual(decision, { action: 'start' })
  assert.equal(probes, 0)
})

test('an open port with a working key is adopted and does not start another node', async () => {
  const tried: string[] = []
  const decision = await resolveNodeStart({
    portOpen: true,
    keys: ['stored-key', 'hello'],
    accepts: async (key) => {
      tried.push(key)
      return key === 'stored-key'
    }
  })
  assert.deepEqual(decision, { action: 'adopt', apiKey: 'stored-key' })
  assert.deepEqual(tried, ['stored-key'])
})

test('an open port falls through to the next key and never chooses start', async () => {
  const tried: string[] = []
  const decision = await resolveNodeStart({
    portOpen: true,
    keys: ['stored-key', 'hello'],
    accepts: async (key) => {
      tried.push(key)
      return key === 'hello'
    }
  })
  assert.deepEqual(decision, { action: 'adopt', apiKey: 'hello' })
  assert.deepEqual(tried, ['stored-key', 'hello'])
  assert.notEqual(decision.action, 'start')
})

test('an open port with no working key stays busy instead of starting', async () => {
  const decision = await resolveNodeStart({
    portOpen: true,
    keys: ['stored-key', 'hello'],
    accepts: async () => false
  })
  assert.deepEqual(decision, { action: 'busy' })
})
