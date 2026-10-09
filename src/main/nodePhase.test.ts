import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { HEIGHT_STALL_MS, nodePhase, waitingForPeerHeight, type NodePhaseInput } from '../shared/nodePhase.ts'
import type { NodeInfo } from '../shared/types.ts'

const NOW = 1_800_000_000_000

function info(patch: Partial<NodeInfo>): NodeInfo {
  return {
    appVersion: '6.0.7',
    fullHeight: null,
    headersHeight: 0,
    maxPeerHeight: null,
    peersCount: 15,
    indexedHeight: null,
    syncDetails: {
      headersHeight: 0,
      fullHeight: null,
      blocksRemaining: null,
      peers: [],
      lanNote: null,
      etaIsNodeSync: false,
      peersKnown: true,
      syncInfoKnown: true,
      peersWithHeight: 0,
      trackKnown: true
    },
    ...patch
  }
}

function input(patch: Partial<NodePhaseInput>): NodePhaseInput {
  return {
    status: 'running',
    detail: null,
    info: null,
    installed: true,
    remote: false,
    copying: false,
    noHeightSince: null,
    now: NOW,
    ...patch
  }
}

describe('nodePhase', () => {
  test('explains a node that is not running', () => {
    assert.equal(nodePhase(input({ status: 'stopped', installed: false }))?.text, 'Node not running: install Java and the Ergo node first')
    assert.deepEqual(nodePhase(input({ status: 'crashed', detail: 'Java is not installed yet' })), {
      tone: 'error',
      text: 'Node not running: Java is not installed yet'
    })
    assert.match(nodePhase(input({ status: 'stopped', remote: true }))!.text, /another machine/)
    assert.equal(nodePhase(input({ status: 'starting', detail: 'Waiting for the node API' }))?.text, 'Starting the node: Waiting for the node API')
  })

  test('says when the API is silent', () => {
    assert.match(nodePhase(input({ info: null }))!.text, /^Node API not responding yet/)
    const stale = nodePhase(input({ info: info({ apiError: 'This operation was aborted', answeredAt: NOW - 5 * 60_000 }) }))
    assert.equal(stale?.tone, 'error')
    assert.match(stale!.text, /Node API not responding \(last answer 5 min ago\): This operation was aborted/)
  })

  test('walks the sync stages', () => {
    assert.equal(nodePhase(input({ info: info({ peersCount: 0 }) }))?.text, 'Looking for peers (none connected yet)')
    assert.equal(
      nodePhase(input({ info: info({}) }))?.text,
      'Connected to 15 peers, waiting for them to report the chain height'
    )
    assert.match(nodePhase(input({ info: info({ headersHeight: 4200 }) }))!.text, /Downloading headers: 4,200 so far/)
    assert.equal(
      nodePhase(input({ info: info({ headersHeight: 100_000, maxPeerHeight: 1_891_013 }) }))?.text,
      'Downloading headers 100,000 of 1,891,013'
    )
    assert.equal(
      nodePhase(input({ info: info({ headersHeight: 1_891_013, fullHeight: 5000, maxPeerHeight: 1_891_013 }) }))?.text,
      'Downloading blocks 5,000 of 1,891,013'
    )
    assert.equal(
      nodePhase(
        input({ info: info({ headersHeight: 1_891_013, fullHeight: 1_891_013, indexedHeight: 10, maxPeerHeight: 1_891_013 }) })
      )?.text,
      'Indexing 10 of 1,891,013'
    )
    assert.deepEqual(
      nodePhase(
        input({
          info: info({ headersHeight: 1_891_013, fullHeight: 1_891_013, indexedHeight: 1_891_013, maxPeerHeight: 1_891_013 })
        })
      ),
      { tone: 'ok', text: 'Synced at height 1,891,013' }
    )
  })

  test('flags peers that never report a height', () => {
    const stalled = nodePhase(input({ info: info({}), noHeightSince: NOW - HEIGHT_STALL_MS - 1000 }))
    assert.equal(stalled?.tone, 'warn')
    assert.match(stalled!.text, /none has reported the chain height in 3 min\. Headers are not downloading/)
  })

  test('leaves the line to the chain copy while it runs', () => {
    assert.equal(nodePhase(input({ copying: true, info: info({}) })), null)
  })

  test('waitingForPeerHeight', () => {
    assert.equal(waitingForPeerHeight(null), false)
    assert.equal(waitingForPeerHeight(info({})), true)
    assert.equal(waitingForPeerHeight(info({ peersCount: 0 })), false)
    assert.equal(waitingForPeerHeight(info({ maxPeerHeight: 10 })), false)
    assert.equal(waitingForPeerHeight(info({ headersHeight: 10 })), false)
  })
})
