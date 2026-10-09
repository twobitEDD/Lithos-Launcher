import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NODE_STOP_TIMEOUT_MS, stopNodeGracefully, type NodeStopSteps } from './nodeStop.ts'

function harness(opts: { apiFails?: boolean; noApi?: boolean; exitsAfter: 'api' | 'interrupt' | 'never'; interruptOk?: boolean }) {
  const calls: string[] = []
  let stage: 'none' | 'api' | 'interrupt' = 'none'
  const steps: NodeStopSteps = {
    requestApi: opts.noApi
      ? null
      : async () => {
          calls.push('api')
          if (opts.apiFails) throw new Error('connection refused')
          stage = 'api'
        },
    interrupt: async () => {
      calls.push('interrupt')
      if (opts.interruptOk === false) return false
      stage = 'interrupt'
      return true
    },
    waitForExit: async (ms) => {
      calls.push(`wait ${ms}`)
      return (opts.exitsAfter === 'api' && stage === 'api') || (opts.exitsAfter === 'interrupt' && stage === 'interrupt')
    },
    kill: () => calls.push('kill'),
    log: () => undefined
  }
  return { steps, calls }
}

describe('node stop sequence', () => {
  test('asks the API first and waits the full timeout before anything harsher', async () => {
    const { steps, calls } = harness({ exitsAfter: 'api' })
    assert.equal(await stopNodeGracefully(steps), 'api')
    assert.deepEqual(calls, ['api', `wait ${NODE_STOP_TIMEOUT_MS}`])
  })

  test('the default wait is at least 2 minutes', () => {
    assert.ok(NODE_STOP_TIMEOUT_MS >= 120_000)
  })

  test('a failed API request falls back to an interrupt, not a kill', async () => {
    const { steps, calls } = harness({ apiFails: true, exitsAfter: 'interrupt' })
    assert.equal(await stopNodeGracefully(steps), 'interrupt')
    assert.deepEqual(calls, ['api', 'interrupt', 'wait 30000'])
    assert.ok(!calls.includes('kill'))
  })

  test('without an API key the interrupt gets the full timeout', async () => {
    const { steps, calls } = harness({ noApi: true, exitsAfter: 'interrupt' })
    assert.equal(await stopNodeGracefully(steps), 'interrupt')
    assert.deepEqual(calls, ['interrupt', `wait ${NODE_STOP_TIMEOUT_MS}`])
  })

  test('only kills after the API and the interrupt both ran out of time', async () => {
    const { steps, calls } = harness({ exitsAfter: 'never' })
    assert.equal(await stopNodeGracefully({ ...steps, timeoutMs: 1000, killWaitMs: 5 }), 'killed')
    assert.deepEqual(calls, ['api', 'wait 1000', 'interrupt', 'wait 1000', 'kill', 'wait 5'])
  })

  test('an undeliverable interrupt goes straight to the kill', async () => {
    const { steps, calls } = harness({ apiFails: true, interruptOk: false, exitsAfter: 'never' })
    assert.equal(await stopNodeGracefully({ ...steps, killWaitMs: 5 }), 'killed')
    assert.deepEqual(calls, ['api', 'interrupt', 'kill', 'wait 5'])
  })
})
