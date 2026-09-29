import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blake2b } from '@noble/hashes/blake2.js'
import { addressForNetwork, p2pkContent } from '../shared/address.ts'

/** Documented Ergo mainnet P2PK address (sigma-rust). Not a secret. */
const MAINNET = '9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA'

test('blake2b256 matches the Ergo node hello hash', () => {
  const hash = Buffer.from(blake2b(new TextEncoder().encode('hello'), { dkLen: 32 })).toString('hex')
  assert.equal(hash, '324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf')
})

test('one P2PK key encodes as 9 on mainnet and 3 on testnet', () => {
  const testnet = addressForNetwork(MAINNET, 'testnet')
  assert.equal(addressForNetwork(MAINNET, 'mainnet'), MAINNET)
  assert.equal(testnet.startsWith('3'), true)
  assert.equal(MAINNET.startsWith('9'), true)
  assert.notEqual(testnet, MAINNET)
  assert.equal(addressForNetwork(testnet, 'mainnet'), MAINNET)
  assert.deepEqual(p2pkContent(testnet), p2pkContent(MAINNET))
  // Locked so a checksum or prefix bug cannot pass with a different 3-address.
  assert.equal(testnet, '3WwWK6U2khXfCuoREuafbMBjpXJXMN6Y9M8Sj1wrUNfQBvaF4gBo')
})
