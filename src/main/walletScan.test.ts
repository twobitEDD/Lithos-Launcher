import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstScannableHeight } from '../shared/walletScan.ts'

function has(present: ReadonlySet<number>): (height: number) => Promise<boolean> {
  return async (height) => present.has(height)
}

test('a chain that has block 2 scans from block 1', async () => {
  const present = new Set([1, 2, 3, 4, 5])
  assert.equal(await firstScannableHeight(5, has(present)), 1)
})

test('a tip-only chain scans from the first stored block, not block 1', async () => {
  const present = new Set([1, 100, 101, 102, 103])
  assert.equal(await firstScannableHeight(103, has(present)), 100)
})

test('a missing tip does not invent a scan start', async () => {
  const present = new Set([1])
  assert.equal(await firstScannableHeight(50, has(present)), null)
})
