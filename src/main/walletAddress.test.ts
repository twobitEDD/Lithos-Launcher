import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { addressForSelection, addressOnWalletRow, shouldStampAddress } from '../shared/walletAddress.ts'

/** Documented Ergo P2PK addresses (sigma-rust). Not secrets. */
const MAINNET = '9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA'
const TESTNET = '3WwWK6U2khXfCuoREuafbMBjpXJXMN6Y9M8Sj1wrUNfQBvaF4gBo'

const wallets = [
  { file: 'first.json', role: 'active' as const, address: MAINNET },
  { file: 'second.json', role: 'kept' as const, address: TESTNET }
]

test('two wallets render two different addresses when selected', () => {
  const nodeAddress = MAINNET
  assert.equal(addressForSelection(wallets, 'first.json', nodeAddress), MAINNET)
  assert.equal(addressForSelection(wallets, 'second.json', nodeAddress), TESTNET)
  assert.notEqual(addressForSelection(wallets, 'first.json', nodeAddress), addressForSelection(wallets, 'second.json', nodeAddress))
  assert.equal(addressOnWalletRow(wallets[0], wallets, nodeAddress), MAINNET)
  assert.equal(addressOnWalletRow(wallets[1], wallets, nodeAddress), TESTNET)
  assert.notEqual(addressOnWalletRow(wallets[0], wallets, nodeAddress), addressOnWalletRow(wallets[1], wallets, nodeAddress))
})

test('selecting a wallet does not reuse another wallet node address', () => {
  const pending = [
    { file: 'first.json', role: 'kept' as const, address: MAINNET },
    { file: 'second.json', role: 'active' as const, address: null }
  ]
  assert.equal(addressForSelection(pending, 'second.json', MAINNET), null)
  assert.equal(addressOnWalletRow(pending[0], pending, MAINNET), MAINNET)
  assert.equal(addressOnWalletRow(pending[1], pending, MAINNET), null)
})

test('the only wallet can show the node address before it is recorded', () => {
  const only = [{ file: 'only.json', role: 'active' as const, address: null }]
  assert.equal(addressForSelection(only, 'only.json', MAINNET), MAINNET)
  assert.equal(addressForSelection([], null, MAINNET), MAINNET)
})

test('the previous node address is not stamped onto the next keystore', () => {
  assert.equal(shouldStampAddress(null, MAINNET, MAINNET), false)
  assert.equal(shouldStampAddress(null, MAINNET, TESTNET), true)
  assert.equal(shouldStampAddress(MAINNET, null, TESTNET), false)
})

test('wallet rows bind to each keystore address', async () => {
  const list = await readFile(new URL('../renderer/src/lib/WalletList.svelte', import.meta.url), 'utf8')
  const card = await readFile(new URL('../renderer/src/lib/WalletCard.svelte', import.meta.url), 'utf8')
  assert.match(list, /addressOnWalletRow/)
  assert.match(list, /Loaded in node/)
  assert.equal(list.includes('activeAddress'), false)
  assert.match(card, /addressForSelection/)
})
