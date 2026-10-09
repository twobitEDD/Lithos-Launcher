import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { autoHeapFor, HEAP_RAM_SHARE, NODE_HEAP_MAX_MB } from '../shared/heap.ts'

const GiB = 2 ** 30

describe('autoHeapFor', () => {
  test('16 GB: the node gets 6.5 GB during sync, the client keeps 3 GB', () => {
    assert.deepEqual(autoHeapFor(16 * GiB), { nodeMb: 6656, clientMb: 3072 })
  })

  test('a Windows "16 GB" machine that reports a little less still gets 6.5 GB', () => {
    assert.deepEqual(autoHeapFor(15.9 * GiB), { nodeMb: 6656, clientMb: 3072 })
  })

  test('small machines keep the old sizes', () => {
    assert.deepEqual(autoHeapFor(8 * GiB), { nodeMb: 3072, clientMb: 2048 })
  })

  test('12 GB and large machines', () => {
    assert.deepEqual(autoHeapFor(12 * GiB), { nodeMb: 4096, clientMb: 3072 })
    assert.deepEqual(autoHeapFor(32 * GiB), { nodeMb: NODE_HEAP_MAX_MB, clientMb: 4096 })
    assert.deepEqual(autoHeapFor(128 * GiB), { nodeMb: NODE_HEAP_MAX_MB, clientMb: 4096 })
  })

  test('from 12 GB up, node + client never exceed the RAM share', () => {
    for (let gb = 12; gb <= 128; gb += 0.5) {
      const { nodeMb, clientMb } = autoHeapFor(gb * GiB)
      assert.ok(nodeMb + clientMb <= gb * 1024 * HEAP_RAM_SHARE, `${gb} GB: ${nodeMb} + ${clientMb}`)
      assert.equal(nodeMb % 256, 0)
    }
  })
})
