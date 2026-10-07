import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_PASSWORD_LENGTH } from '../shared/types.ts'
import {
  canSubmitCreateWallet,
  createWalletPasswordProblem,
  canInvokeCreateWallet,
  createWalletNodeProblem,
  existingWalletCreateNote,
  replaceWalletBlocked,
  showCreateWalletPrompt
} from '../shared/walletPrompt.ts'

test('create prompt is shown when there is no wallet yet', () => {
  assert.equal(showCreateWalletPrompt('unavailable'), true)
  assert.equal(showCreateWalletPrompt('uninitialized'), true)
})

test('create prompt stays available when a wallet already exists', () => {
  assert.equal(showCreateWalletPrompt('unlocking'), true)
  assert.equal(showCreateWalletPrompt('locked'), true)
  assert.equal(showCreateWalletPrompt('unlocked'), true)
})

test('create wallet submit stays disabled until the password is valid and repeated', () => {
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
  const ok = 'a'.repeat(MIN_PASSWORD_LENGTH)
  assert.equal(canSubmitCreateWallet({ busy: false, password: '', confirmPassword: '' }), false)
  assert.equal(canSubmitCreateWallet({ busy: false, password: short, confirmPassword: short }), false)
  assert.equal(createWalletPasswordProblem(short, short), `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  assert.equal(canSubmitCreateWallet({ busy: false, password: ok, confirmPassword: '' }), false)
  assert.equal(createWalletPasswordProblem(ok, ''), 'Repeat the password')
  assert.equal(canSubmitCreateWallet({ busy: false, password: ok, confirmPassword: `${ok}x` }), false)
  assert.equal(createWalletPasswordProblem(ok, `${ok}x`), 'The passwords do not match')
  assert.equal(canSubmitCreateWallet({ busy: true, password: ok, confirmPassword: ok }), false)
})

test('a valid repeated password enables create even if the node is down or already has a wallet', () => {
  const ok = 'a'.repeat(MIN_PASSWORD_LENGTH)
  assert.equal(canSubmitCreateWallet({ busy: false, password: ok, confirmPassword: ok }), true)
  assert.equal(createWalletPasswordProblem(ok, ok), null)
  // Node status is not an input: a stopped node must not leave the button disabled.
  assert.equal(existingWalletCreateNote('unavailable'), null)
  assert.equal(existingWalletCreateNote('uninitialized'), null)
  assert.match(existingWalletCreateNote('locked') ?? '', /set aside/)
  assert.match(existingWalletCreateNote('locked') ?? '', /kept on disk/)
  assert.match(existingWalletCreateNote('unlocked') ?? '', /Mining will use the new wallet/)
  assert.match(existingWalletCreateNote('unlocking') ?? '', /kept on disk/)
  assert.match(replaceWalletBlocked('locked', false) ?? '', /Check the box/)
  assert.equal(replaceWalletBlocked('locked', true), null)
  assert.equal(replaceWalletBlocked('uninitialized', false), null)
  // The confirm box is not what enables the button.
  assert.equal(canSubmitCreateWallet({ busy: false, password: ok, confirmPassword: ok }), true)
})

test('create talks to the node only once it is running, including an adopted node', () => {
  const ok = 'a'.repeat(MIN_PASSWORD_LENGTH)
  const ready = { busy: false, password: ok, confirmPassword: ok }
  assert.equal(canSubmitCreateWallet(ready), true)
  assert.match(createWalletNodeProblem(false) ?? '', /Start the node/)
  assert.equal(
    canInvokeCreateWallet({ ...ready, nodeRunning: false, phase: 'uninitialized', replaceConfirmed: false }),
    false
  )
  assert.equal(createWalletNodeProblem(true), null)
  assert.equal(
    canInvokeCreateWallet({ ...ready, nodeRunning: true, phase: 'uninitialized', replaceConfirmed: false }),
    true
  )
  assert.equal(
    canInvokeCreateWallet({ ...ready, nodeRunning: true, phase: 'unlocked', replaceConfirmed: false }),
    false
  )
  assert.equal(
    canInvokeCreateWallet({ ...ready, nodeRunning: true, phase: 'locked', replaceConfirmed: true }),
    true
  )
})
