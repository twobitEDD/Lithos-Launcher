import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cycleActiveWallet, walletSwitchRestartsNode } from '../shared/walletCycle.ts'

const files = [
  { file: 'current.json', role: 'active' as const },
  { file: 'other.json', role: 'kept' as const },
  { file: 'third.json', role: 'kept' as const }
]

test('cycling to the next wallet updates the active file, not only the cursor', () => {
  const next = cycleActiveWallet(files, 1)
  assert.ok(next)
  assert.equal(next.cursor, 'other.json')
  assert.equal(next.activeFile, 'other.json')
  assert.notEqual(next.activeFile, 'current.json')
})

test('cycling backward updates the active file to the last wallet', () => {
  const prev = cycleActiveWallet(files, -1)
  assert.ok(prev)
  assert.equal(prev.activeFile, 'third.json')
  assert.equal(prev.cursor, prev.activeFile)
})

test('a single wallet has nothing to cycle to', () => {
  assert.equal(cycleActiveWallet([{ file: 'only.json', role: 'active' }], 1), null)
})

test('an adopted running node must reload when the wallet changes', () => {
  assert.equal(
    walletSwitchRestartsNode({ status: 'running', ownsProcess: false, network: 'mainnet' }, 'mainnet'),
    true
  )
  assert.equal(
    walletSwitchRestartsNode({ status: 'stopped', ownsProcess: false, network: null }, 'mainnet'),
    false
  )
  assert.equal(
    walletSwitchRestartsNode({ status: 'running', ownsProcess: true, network: 'testnet' }, 'mainnet'),
    false
  )
})
