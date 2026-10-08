import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PAYOUT_DELAY_BLOCKS,
  blocksRemaining,
  countdownSeconds,
  lithosBlocksFromLog,
  nextPayout,
  payoutHeightFor,
  proofsFromPayments
} from '../shared/payout.ts'

test('payout height is the Lithos block plus 720', () => {
  assert.equal(PAYOUT_DELAY_BLOCKS, 720)
  assert.equal(payoutHeightFor(1_889_643), 1_890_363)
  assert.equal(payoutHeightFor(1_889_725), 1_890_445)
})

test('blocks remaining is the payout height minus the chain height', () => {
  assert.equal(blocksRemaining(1_890_363, 1_890_244), 119)
  assert.equal(blocksRemaining(1_890_363, 1_890_363), 0)
  assert.equal(blocksRemaining(1_890_363, 1_890_400), 0)
})

test('countdown seconds are blocks remaining times the block interval', () => {
  assert.equal(countdownSeconds(119, 120), 119 * 120)
  assert.equal(countdownSeconds(0, 120), 0)
  assert.equal(countdownSeconds(40, 45), 1_800)
})

test('the soonest of several proofs is the lowest payout height', () => {
  const proofs = [1_889_725, 1_889_643, 1_890_235].map((lithosBlock) => ({
    lithosBlock,
    payoutHeight: payoutHeightFor(lithosBlock)
  }))
  const next = nextPayout(proofs, 1_890_244, { dropSettled: true })
  assert.ok(next)
  assert.equal(next.lithosBlock, 1_889_643)
  assert.equal(next.payoutHeight, 1_890_363)
  assert.equal(next.blocksRemaining, 119)
  assert.equal(next.laterCount, 2)
})

test('no outstanding proofs means nothing is scheduled', () => {
  assert.equal(nextPayout([], 1_890_244), null)
  assert.equal(
    nextPayout([{ lithosBlock: 1_889_643, payoutHeight: 1_890_363 }], 1_890_364, { dropSettled: true }),
    null
  )
})

test('a proof whose payout height is the current block is due, not dropped', () => {
  const next = nextPayout([{ lithosBlock: 1_889_643, payoutHeight: 1_890_363 }], 1_890_363, {
    dropSettled: true
  })
  assert.ok(next)
  assert.equal(next.blocksRemaining, 0)
  assert.equal(next.laterCount, 0)
})

test('payments API claims use payoutReadyFrom and skip slashed proofs', () => {
  const proofs = proofsFromPayments({
    claims: [
      { phase: 'evaluation', minedHeight: 1_889_725, payoutReadyFrom: 1_890_445 },
      { phase: 'holding', minedHeight: 1_889_643, payoutReadyFrom: 1_890_363 },
      { phase: 'slashed', minedHeight: 1, payoutReadyFrom: 721 }
    ]
  })
  assert.ok(proofs)
  const next = nextPayout(proofs, 1_890_244)
  assert.ok(next)
  assert.equal(next.payoutHeight, 1_890_363)
  assert.equal(next.laterCount, 1)
})

test('a claim without payoutReadyFrom pays at mined height plus 720', () => {
  const proofs = proofsFromPayments({
    claims: [{ phase: 'holding', minedHeight: 1_889_643 }]
  })
  assert.deepEqual(proofs, [{ lithosBlock: 1_889_643, payoutHeight: 1_890_363 }])
})

test('a body that is not the payments page is unknown, not an empty schedule', () => {
  assert.equal(proofsFromPayments({ error: 503, reason: 'Statistics history unavailable' }), null)
  assert.deepEqual(proofsFromPayments({ claims: [] }), [])
})

test('log lines yield each Lithos block once', () => {
  const text = [
    'Got valid NISP for lithos-mined block 1889725 with score 2400000',
    'Got valid NISP for lithos-mined block 1889643 with score 2400000',
    'Got valid NISP for lithos-mined block 1889643 with score 2400000'
  ].join('\n')
  assert.deepEqual(lithosBlocksFromLog(text), [1_889_643, 1_889_725])
})
