import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RESTORE_STALE_MS, NodeStartupTracker } from '../shared/nodeStartup.ts'
import { durationText, nodePhase, type NodePhaseInput } from '../shared/nodePhase.ts'
import type { NodeInfo } from '../shared/types.ts'

const T0 = 1_800_000_000_000
const MIN = 60_000

// Lines as a Windows rig on 6.0.7 logged them during start-up state recovery.
const READERS = '12:01:02.345 WARN  [ergoref-akka.actor.default-dispatcher-7] o.e.n.ErgoReadersHolder - Readers are not initialized yet : (None,None,None,None)'
const UNDEFINED = '12:01:02.346 WARN  [ergoref-akka.actor.default-dispatcher-7] o.e.h.a.ErgoBaseApiRoute - Trying to get data from undefined history reader'
const apply = (n: number): string =>
  `12:01:03.000 INFO  [ergoref-akka.actor.default-dispatcher-5] o.e.n.UtxoNodeViewHolder - Applying block ${n} during node start-up to restore consistent state`
const applied = (n: number): string =>
  `12:01:04.000 INFO  [ergoref-akka.actor.default-dispatcher-5] o.e.n.s.UtxoState - Persistent modifier abc applied to UtxoState at height ${n}`
const INDEXER = '12:01:05.000 INFO  [ergoref-akka.actor.default-dispatcher-9] o.e.n.ExtraIndexer - Buffered block 833764 / 875732 [95.20%] (buffer: 13612 / 20000)'

function info(patch: Partial<NodeInfo>): NodeInfo {
  return {
    appVersion: '6.0.7',
    fullHeight: null,
    headersHeight: null,
    maxPeerHeight: null,
    peersCount: 32,
    indexedHeight: null,
    syncDetails: {
      headersHeight: null,
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

function phaseOf(i: NodeInfo): string | undefined {
  const input: NodePhaseInput = {
    status: 'running',
    detail: null,
    info: i,
    installed: true,
    remote: false,
    copying: false,
    noHeightSince: null,
    now: T0
  }
  return nodePhase(input)?.text
}

describe('node start-up from the log', () => {
  test('nothing to say for an ordinary log', () => {
    const t = new NodeStartupTracker()
    t.feed(['Starting Ergo node', 'Connected to peer 1.2.3.4'], T0)
    assert.equal(t.snapshot(T0, { headersHeight: null, fullHeight: null }), null)
  })

  test('readers not initialized means the database is still loading, for a short while', () => {
    const t = new NodeStartupTracker()
    t.feed([READERS, UNDEFINED], T0)
    assert.equal(t.readersPending(T0 + 1000), true)
    assert.equal(t.readersPending(T0 + MIN), false)
    assert.equal(t.readersPending(T0 + MIN, 5 * MIN), true)
    const st = t.snapshot(T0, { headersHeight: null, fullHeight: null })
    assert.equal(st?.readersPending, true)
    assert.equal(st?.restore, null)
  })

  test('restoring state: block, target from the indexer, rate and ETA', () => {
    const t = new NodeStartupTracker()
    t.feed([READERS, INDEXER, apply(875_541)], T0)
    t.feed([applied(875_541)], T0 + 5 * MIN)
    t.feed([apply(875_570)], T0 + 150 * MIN)
    const st = t.snapshot(T0 + 150 * MIN, { headersHeight: null, fullHeight: null })
    assert.ok(st?.restore)
    assert.equal(st.restore.block, 875_570)
    assert.equal(st.restore.target, 875_732)
    // 29 blocks in 2.5 h
    assert.ok(Math.abs(st.restore.blocksPerHour! - 11.6) < 0.01)
    assert.ok(Math.abs(st.restore.etaSeconds! - (162 / 11.6) * 3600) < 1)
    assert.deepEqual(st.indexer, { block: 833_764, target: 875_732, updatedAt: T0 })
  })

  test('a lower "applied" line does not restart the rate', () => {
    const t = new NodeStartupTracker()
    t.feed([apply(100)], T0)
    t.feed([apply(110)], T0 + 10 * MIN)
    t.feed([applied(109)], T0 + 11 * MIN)
    const st = t.snapshot(T0 + 11 * MIN, { headersHeight: 200, fullHeight: null })
    assert.equal(st?.restore?.block, 110)
    assert.equal(st?.restore?.target, 200)
    assert.equal(Math.round(st!.restore!.blocksPerHour!), 60)
  })

  test('the restore ends when /info reports a full height, or goes stale', () => {
    const t = new NodeStartupTracker()
    t.feed([apply(100)], T0)
    assert.equal(t.snapshot(T0 + MIN, { headersHeight: 500, fullHeight: 120 }), null)
    assert.equal(t.snapshot(T0 + RESTORE_STALE_MS + 1, { headersHeight: null, fullHeight: null }), null)
  })

  test('reset forgets a previous process', () => {
    const t = new NodeStartupTracker()
    t.feed([READERS, apply(100), INDEXER], T0)
    t.reset()
    assert.equal(t.snapshot(T0, { headersHeight: null, fullHeight: null }), null)
  })

  test('the node card line during state recovery', () => {
    const t = new NodeStartupTracker()
    t.feed([READERS, INDEXER, apply(875_541)], T0)
    t.feed([apply(875_570)], T0 + 150 * MIN)
    const startup = t.snapshot(T0 + 150 * MIN, { headersHeight: null, fullHeight: null })
    assert.equal(
      phaseOf(info({ startup })),
      "Node is starting up: restoring state, block 875,570 of 875,732 (don't close the launcher). About 12 blocks/hour, 14 h left. " +
        'Indexing block 833,764 / 875,732.'
    )
  })

  test('the node card line before the first restored block', () => {
    const t = new NodeStartupTracker()
    t.feed([READERS], T0)
    const startup = t.snapshot(T0, { headersHeight: null, fullHeight: null })
    assert.match(phaseOf(info({ startup }))!, /^Node is starting up: loading its database/)
  })

  test('without start-up lines the old peer-height line stays', () => {
    assert.equal(phaseOf(info({})), 'Connected to 32 peers, waiting for them to report the chain height')
  })

  test('indexing uses the log when the API has no indexed height', () => {
    const t = new NodeStartupTracker()
    t.feed([INDEXER], T0)
    const startup = t.snapshot(T0, { headersHeight: 875_732, fullHeight: 875_732 })
    assert.equal(
      phaseOf(info({ startup, headersHeight: 875_732, fullHeight: 875_732, maxPeerHeight: 875_732 })),
      'Indexing 833,764 of 875,732'
    )
  })

  test('durationText', () => {
    assert.equal(durationText(30), '1 min')
    assert.equal(durationText(45 * 60), '45 min')
    assert.equal(durationText(14 * 3600), '14 h')
    assert.equal(durationText(5 * 86400), '5 days')
  })
})
