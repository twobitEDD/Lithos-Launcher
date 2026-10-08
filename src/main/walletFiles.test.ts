import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ACTIVE_DIR,
  KEPT_DIR,
  REMOVED_DIR,
  activateKeptWallet,
  addKeptKeystore,
  asideFileName,
  listWalletFiles,
  rememberPublicAddress,
  removeWalletOnNode,
  setAsideActiveKeystore,
  walletFileLabel,
  withActiveWalletSlot
} from './walletFiles.ts'

const NOW = new Date('2026-10-07T03:52:12.000Z')
const MARKER = 'only-copy-bytes'
const SECRET = 'SEED-WORD-ONE'

/** Temp directories only. These tests never open a node or a real keystore. */
async function tempWallet(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lithos-wallet-files-'))
  if (!dir.startsWith(tmpdir()) || !dir.includes('lithos-wallet-files-')) {
    throw new Error('refusing to use this directory')
  }
  await mkdir(join(dir, ACTIVE_DIR), { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  if (!dir.startsWith(tmpdir()) || !dir.includes('lithos-wallet-files-')) return
  await rm(dir, { recursive: true, force: true })
}

test('a set-aside keystore keeps its bytes under previous-keystore', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'only.json'), MARKER)
    const moved = await setAsideActiveKeystore(dir, NOW)
    assert.equal(moved.length, 1)
    assert.equal(moved[0].active, 'only.json')
    assert.equal(moved[0].kept, asideFileName('only.json', NOW))
    assert.equal(await readFile(join(dir, KEPT_DIR, moved[0].kept), 'utf8'), MARKER)
    await assert.rejects(stat(join(dir, ACTIVE_DIR, 'only.json')))
    const listed = await listWalletFiles(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].role, 'kept')
    assert.equal(listed[0].label, 'only')
    assert.equal(walletFileLabel(moved[0].kept), 'only')
  } finally {
    await cleanup(dir)
  }
})

test('removing the only wallet renames it and does not delete the bytes', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'only.json'), MARKER)
    const calls: string[] = []
    const role = await removeWalletOnNode({
      walletDir: dir,
      file: 'only.json',
      now: NOW,
      nodeRunning: true,
      stop: async () => {
        calls.push('stop')
      },
      start: async () => {
        calls.push('start')
      },
      afterActiveRemoved: async () => {
        calls.push('forget')
      }
    })
    assert.equal(role, 'active')
    assert.deepEqual(calls, ['stop', 'forget', 'start'])
    const dest = asideFileName('only.json', NOW)
    assert.equal(await readFile(join(dir, REMOVED_DIR, dest), 'utf8'), MARKER)
    await assert.rejects(stat(join(dir, ACTIVE_DIR, 'only.json')))
    assert.equal((await listWalletFiles(dir)).length, 0)
  } finally {
    await cleanup(dir)
  }
})

test('removing a kept wallet does not stop the node', async () => {
  const dir = await tempWallet()
  try {
    await mkdir(join(dir, KEPT_DIR), { recursive: true })
    await writeFile(join(dir, KEPT_DIR, 'kept.json'), MARKER)
    const calls: string[] = []
    const role = await removeWalletOnNode({
      walletDir: dir,
      file: 'kept.json',
      now: NOW,
      nodeRunning: true,
      stop: async () => {
        calls.push('stop')
      },
      start: async () => {
        calls.push('start')
      }
    })
    assert.equal(role, 'kept')
    assert.deepEqual(calls, [])
    assert.equal(await readFile(join(dir, REMOVED_DIR, asideFileName('kept.json', NOW)), 'utf8'), MARKER)
  } finally {
    await cleanup(dir)
  }
})

test('adding a wallet copies it and leaves the source file in place', async () => {
  const dir = await tempWallet()
  try {
    const source = join(dir, 'incoming.json')
    await writeFile(source, MARKER)
    const name = await addKeptKeystore(dir, 'incoming.json', MARKER, NOW)
    assert.equal(await readFile(source, 'utf8'), MARKER)
    assert.equal(await readFile(join(dir, KEPT_DIR, name), 'utf8'), MARKER)
    const listed = await listWalletFiles(dir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].role, 'kept')
  } finally {
    await cleanup(dir)
  }
})

test('using a kept wallet sets the active one aside and keeps both copies', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'active.json'), 'active-bytes')
    await mkdir(join(dir, KEPT_DIR), { recursive: true })
    await writeFile(join(dir, KEPT_DIR, 'kept.json'), 'kept-bytes')
    await activateKeptWallet({
      walletDir: dir,
      file: 'kept.json',
      now: NOW,
      nodeRunning: false,
      stop: async () => {
        throw new Error('stop')
      },
      start: async () => {
        throw new Error('start')
      },
      beforeStart: async () => undefined
    })
    assert.equal(await readFile(join(dir, ACTIVE_DIR, 'kept.json'), 'utf8'), 'kept-bytes')
    assert.equal(
      await readFile(join(dir, KEPT_DIR, asideFileName('active.json', NOW)), 'utf8'),
      'active-bytes'
    )
    const listed = await listWalletFiles(dir)
    assert.equal(listed.filter((w) => w.role === 'active').length, 1)
    assert.equal(listed.filter((w) => w.role === 'kept').length, 1)
  } finally {
    await cleanup(dir)
  }
})

test('a failed switch puts both wallet files back', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'active.json'), 'active-bytes')
    await mkdir(join(dir, KEPT_DIR), { recursive: true })
    await writeFile(join(dir, KEPT_DIR, 'kept.json'), 'kept-bytes')
    let starts = 0
    await assert.rejects(
      () =>
        activateKeptWallet({
          walletDir: dir,
          file: 'kept.json',
          now: NOW,
          nodeRunning: true,
          stop: async () => undefined,
          start: async () => {
            starts++
            if (starts === 1) throw new Error('node did not come back')
          },
          beforeStart: async () => undefined
        }),
      /node did not come back/
    )
    assert.equal(await readFile(join(dir, ACTIVE_DIR, 'active.json'), 'utf8'), 'active-bytes')
    assert.equal(await readFile(join(dir, KEPT_DIR, 'kept.json'), 'utf8'), 'kept-bytes')
  } finally {
    await cleanup(dir)
  }
})

test('creating without confirm does not move the keystore or stop the node', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'only.json'), MARKER)
    const calls: string[] = []
    await assert.rejects(
      () =>
        withActiveWalletSlot({
          walletDir: dir,
          replaceExisting: false,
          now: NOW,
          doneLog: 'Wallet created',
          replacedLog: 'Wallet created. The previous wallet is kept on disk in previous-keystore.',
          log: (line) => calls.push(line),
          node: {
            isInitialized: async () => true,
            stop: async () => {
              calls.push('stop')
            },
            start: async () => {
              calls.push('start')
            }
          },
          run: async () => SECRET
        }),
      /Confirm that the current wallet/
    )
    assert.deepEqual(calls, [])
    assert.equal(await readFile(join(dir, ACTIVE_DIR, 'only.json'), 'utf8'), MARKER)
  } finally {
    await cleanup(dir)
  }
})

test('a confirmed create sets the keystore aside and does not log the seed', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'only.json'), MARKER)
    const calls: string[] = []
    const logs: string[] = []
    const result = await withActiveWalletSlot({
      walletDir: dir,
      replaceExisting: true,
      now: NOW,
      doneLog: 'Wallet created',
      replacedLog: 'Wallet created. The previous wallet is kept on disk in previous-keystore.',
      log: (line) => logs.push(line),
      node: {
        isInitialized: async () => true,
        stop: async () => {
          calls.push('stop')
        },
        start: async () => {
          calls.push('start')
        }
      },
      run: async () => {
        calls.push('init')
        return SECRET
      }
    })
    assert.equal(result.replaced, true)
    assert.equal(result.value, SECRET)
    assert.deepEqual(calls, ['stop', 'start', 'init'])
    assert.match(logs.join('\n'), /previous-keystore/)
    assert.equal(logs.join('\n').includes(SECRET), false)
    assert.equal(logs.join('\n').includes(MARKER), false)
    assert.equal(await readFile(join(dir, KEPT_DIR, asideFileName('only.json', NOW)), 'utf8'), MARKER)
    await assert.rejects(stat(join(dir, ACTIVE_DIR, 'only.json')))
  } finally {
    await cleanup(dir)
  }
})

test('a failed create puts the previous keystore back', async () => {
  const dir = await tempWallet()
  try {
    await writeFile(join(dir, ACTIVE_DIR, 'only.json'), MARKER)
    const calls: string[] = []
    const logs: string[] = []
    await assert.rejects(
      () =>
        withActiveWalletSlot({
          walletDir: dir,
          replaceExisting: true,
          now: NOW,
          doneLog: 'Wallet created',
          replacedLog: 'Wallet created. The previous wallet is kept on disk in previous-keystore.',
          log: (line) => logs.push(line),
          node: {
            isInitialized: async () => false,
            stop: async () => {
              calls.push('stop')
            },
            start: async () => {
              calls.push('start')
            }
          },
          run: async () => {
            calls.push('init')
            throw new Error('init failed')
          }
        }),
      /init failed/
    )
    assert.deepEqual(calls, ['stop', 'start', 'init', 'stop', 'start'])
    assert.deepEqual(logs, [])
    assert.equal(await readFile(join(dir, ACTIVE_DIR, 'only.json'), 'utf8'), MARKER)
    assert.equal((await listWalletFiles(dir)).some((w) => w.role === 'kept'), false)
  } finally {
    await cleanup(dir)
  }
})

test('wallet file moves do not unlink keystores', async () => {
  const source = await readFile(new URL('./walletFiles.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ mkdir, readFile, readdir, stat, writeFile \} from 'node:fs\/promises'/)
  assert.equal(/\bunlink\s*\(/.test(source), false)
  assert.equal(/\brm\s*\(/.test(source), false)
})

/** Documented Ergo P2PK addresses (sigma-rust). Not secrets. */
const MAINNET = '9fRAWhdxEsTcdb8PhGNrZfwqa65zfkuYHAMmkQLcic1gdLSV5vA'
const TESTNET = '3WwWK6U2khXfCuoREuafbMBjpXJXMN6Y9M8Sj1wrUNfQBvaF4gBo'

test('two wallet files keep two different public addresses', async () => {
  const dir = await tempWallet()
  try {
    const active = join(dir, ACTIVE_DIR, 'first.json')
    await mkdir(join(dir, KEPT_DIR), { recursive: true })
    const kept = join(dir, KEPT_DIR, 'second.json')
    await writeFile(active, 'keystore-first')
    await writeFile(kept, 'keystore-second')
    assert.equal(await rememberPublicAddress(dir, active, MAINNET), true)
    assert.equal(await rememberPublicAddress(dir, kept, TESTNET), true)
    assert.equal(await rememberPublicAddress(dir, active, 'alpha bravo charlie delta echo foxtrot golf hotel'), false)
    assert.equal(await readFile(active, 'utf8'), 'keystore-first')
    assert.equal(await readFile(kept, 'utf8'), 'keystore-second')
    const book = await readFile(join(dir, 'public-addresses.json'), 'utf8')
    assert.equal(book.includes('alpha'), false)
    assert.equal(book.includes('keystore-first'), false)
    const listed = await listWalletFiles(dir)
    assert.equal(listed.find((w) => w.file === 'first.json')?.address, MAINNET)
    assert.equal(listed.find((w) => w.file === 'second.json')?.address, TESTNET)
    await setAsideActiveKeystore(dir, NOW)
    const after = await listWalletFiles(dir)
    const moved = after.find((w) => w.label === 'first')
    assert.equal(moved?.role, 'kept')
    assert.equal(moved?.address, MAINNET)
    assert.equal(after.find((w) => w.file === 'second.json')?.address, TESTNET)
    assert.notEqual(moved?.address, after.find((w) => w.file === 'second.json')?.address)
  } finally {
    await cleanup(dir)
  }
})
