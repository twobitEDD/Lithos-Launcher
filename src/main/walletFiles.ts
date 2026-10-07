import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WalletFileInfo } from '@shared/types'
import { renameWithRetry } from './util.ts'

/** The one keystore directory the Ergo node reads. */
export const ACTIVE_DIR = 'keystore'
/** Wallets kept on disk that are not the active one. */
export const KEPT_DIR = 'previous-keystore'
/** Taken off the list. The file is still on disk; nothing here is deleted. */
export const REMOVED_DIR = 'removed-keystore'

const STAMP = /^\d{8}T\d{6}Z-/
const SAFE_FILE = /^[\w.-]+\.json$/i

export interface MovedKeystore {
  /** Basename it had in keystore/. */
  active: string
  /** Basename it now has in previous-keystore/. */
  kept: string
}

export interface WalletSlotNode {
  isInitialized: () => Promise<boolean>
  stop: () => Promise<void>
  start: () => Promise<void>
}

/**
 * File moves for the node's single active wallet. This module never calls the
 * node API and never unlinks a keystore: a wallet leaves a directory only by rename.
 */

export function walletFileLabel(file: string): string {
  const stripped = file.replace(STAMP, '').replace(/\.json$/i, '')
  return stripped || file
}

export function asideFileName(originalName: string, now: Date): string {
  const base = originalName.replace(STAMP, '')
  const safe = base.replace(/[^\w.-]/g, '_')
  const file = safe.toLowerCase().endsWith('.json') ? safe : `${safe}.json`
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  return `${stamp}-${file}`
}

export function assertWalletFileName(file: string): void {
  if (!SAFE_FILE.test(file)) throw new Error('Unknown wallet file')
}

async function jsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.filter((name) => name.toLowerCase().endsWith('.json') && SAFE_FILE.test(name))
}

async function uniqueName(dir: string, name: string): Promise<string> {
  const taken = new Set(await readdir(dir).catch(() => [] as string[]))
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot === -1 ? name : name.slice(0, dot)
  const ext = dot === -1 ? '' : name.slice(dot)
  for (let i = 2; i < 1000; i++) {
    const next = `${stem}-${i}${ext}`
    if (!taken.has(next)) return next
  }
  throw new Error('Could not choose a file name for the wallet copy')
}

/** Renames only when the destination is empty, so a keystore is never overwritten. */
async function renameNoReplace(from: string, to: string): Promise<void> {
  try {
    await stat(to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await renameWithRetry(from, to)
      return
    }
    throw err
  }
  throw new Error('A wallet file is already at the destination, so nothing was replaced')
}

export async function listWalletFiles(walletDir: string): Promise<WalletFileInfo[]> {
  const records: WalletFileInfo[] = []
  for (const role of ['active', 'kept'] as const) {
    const folder = role === 'active' ? ACTIVE_DIR : KEPT_DIR
    for (const file of await jsonFiles(join(walletDir, folder))) {
      const info = await stat(join(walletDir, folder, file))
      records.push({ file, role, label: walletFileLabel(file), savedAt: info.mtimeMs })
    }
  }
  records.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'active' ? -1 : 1
    return b.savedAt - a.savedAt
  })
  return records
}

/** Moves every active keystore JSON into previous-keystore. The bytes stay on disk. */
export async function setAsideActiveKeystore(walletDir: string, now: Date): Promise<MovedKeystore[]> {
  const activeDir = join(walletDir, ACTIVE_DIR)
  const files = await jsonFiles(activeDir)
  if (!files.length) return []
  const keptDir = join(walletDir, KEPT_DIR)
  await mkdir(keptDir, { recursive: true })
  const moved: MovedKeystore[] = []
  for (const file of files) {
    const kept = await uniqueName(keptDir, asideFileName(file, now))
    await renameNoReplace(join(activeDir, file), join(keptDir, kept))
    moved.push({ active: file, kept })
  }
  return moved
}

/** Puts set-aside files back. Used when creating the new wallet did not succeed. */
export async function restoreActiveKeystore(walletDir: string, moved: MovedKeystore[]): Promise<void> {
  const activeDir = join(walletDir, ACTIVE_DIR)
  await mkdir(activeDir, { recursive: true })
  for (const item of [...moved].reverse()) {
    assertWalletFileName(item.active)
    assertWalletFileName(item.kept)
    await renameNoReplace(join(walletDir, KEPT_DIR, item.kept), join(activeDir, item.active))
  }
}

/** Copies bytes onto the kept list. The source file is not moved or removed. */
export async function addKeptKeystore(
  walletDir: string,
  sourceName: string,
  contents: string,
  now: Date
): Promise<string> {
  const keptDir = join(walletDir, KEPT_DIR)
  await mkdir(keptDir, { recursive: true })
  const name = await uniqueName(keptDir, asideFileName(sourceName, now))
  await writeFile(join(keptDir, name), contents, { flag: 'wx', mode: 0o600 })
  return name
}

/**
 * Takes a listed wallet off the active or kept list by renaming it into removed-keystore.
 * The only copy is that renamed file. It is not deleted.
 */
export async function archiveWalletFile(
  walletDir: string,
  file: string,
  role: 'active' | 'kept',
  now: Date
): Promise<string> {
  assertWalletFileName(file)
  const folder = role === 'active' ? ACTIVE_DIR : KEPT_DIR
  const source = join(walletDir, folder, file)
  await stat(source)
  const removedDir = join(walletDir, REMOVED_DIR)
  await mkdir(removedDir, { recursive: true })
  const destName = await uniqueName(removedDir, asideFileName(file, now))
  await renameNoReplace(source, join(removedDir, destName))
  return destName
}

async function placeKeptAsActive(walletDir: string, file: string): Promise<void> {
  assertWalletFileName(file)
  const activeDir = join(walletDir, ACTIVE_DIR)
  await mkdir(activeDir, { recursive: true })
  await renameNoReplace(join(walletDir, KEPT_DIR, file), join(activeDir, file))
}

/**
 * Stops the node when it is using this wallet, sets any active keystore aside, then runs
 * `run` (wallet init or restore). If `run` fails, the previous keystore is renamed back.
 * `run`'s result is returned and never written to `log`.
 */
export async function withActiveWalletSlot<T>(opts: {
  walletDir: string
  replaceExisting: boolean
  now: Date
  doneLog: string
  replacedLog: string
  log?: (line: string) => void
  node: WalletSlotNode
  run: () => Promise<T>
}): Promise<{ value: T; replaced: boolean }> {
  const hasActive = (await listWalletFiles(opts.walletDir)).some((w) => w.role === 'active')
  const initialized = await opts.node.isInitialized()
  if (!hasActive && !initialized) {
    const value = await opts.run()
    opts.log?.(opts.doneLog)
    return { value, replaced: false }
  }
  if (!opts.replaceExisting) {
    throw new Error('Confirm that the current wallet should be set aside before creating a new one.')
  }
  await opts.node.stop()
  const moved = await setAsideActiveKeystore(opts.walletDir, opts.now)
  try {
    await opts.node.start()
    const value = await opts.run()
    opts.log?.(opts.replacedLog)
    return { value, replaced: true }
  } catch (err) {
    await opts.node.stop().catch(() => undefined)
    if (moved.length) await restoreActiveKeystore(opts.walletDir, moved)
    await opts.node.start().catch(() => undefined)
    throw err
  }
}

export async function removeWalletOnNode(opts: {
  walletDir: string
  file: string
  now: Date
  nodeRunning: boolean
  stop: () => Promise<void>
  start: () => Promise<void>
  afterActiveRemoved?: () => Promise<void>
}): Promise<'active' | 'kept'> {
  const record = (await listWalletFiles(opts.walletDir)).find((w) => w.file === opts.file)
  if (!record) throw new Error('That wallet is not in the list')
  const restart = record.role === 'active' && opts.nodeRunning
  if (restart) await opts.stop()
  try {
    await archiveWalletFile(opts.walletDir, opts.file, record.role, opts.now)
    if (record.role === 'active') await opts.afterActiveRemoved?.()
    if (restart) await opts.start()
  } catch (err) {
    if (restart) await opts.start().catch(() => undefined)
    throw err
  }
  return record.role
}

export async function activateKeptWallet(opts: {
  walletDir: string
  file: string
  now: Date
  nodeRunning: boolean
  stop: () => Promise<void>
  start: () => Promise<void>
  beforeStart: () => Promise<void>
}): Promise<void> {
  assertWalletFileName(opts.file)
  const record = (await listWalletFiles(opts.walletDir)).find((w) => w.file === opts.file)
  if (!record || record.role !== 'kept') throw new Error('Choose a wallet that is kept on disk')
  if (opts.nodeRunning) await opts.stop()
  const moved = await setAsideActiveKeystore(opts.walletDir, opts.now)
  let placed = false
  try {
    await placeKeptAsActive(opts.walletDir, opts.file)
    placed = true
    await opts.beforeStart()
    if (opts.nodeRunning) await opts.start()
  } catch (err) {
    if (placed) {
      await renameNoReplace(join(opts.walletDir, ACTIVE_DIR, opts.file), join(opts.walletDir, KEPT_DIR, opts.file)).catch(
        () => undefined
      )
    }
    if (moved.length) await restoreActiveKeystore(opts.walletDir, moved).catch(() => undefined)
    if (opts.nodeRunning) await opts.start().catch(() => undefined)
    throw err
  }
}
