// Files on disk for a LAN chain copy: the seed's hardlink snapshot and tar stream, the receiver's
// download, and the swap that keeps the old chain until the node runs on the new one.
// No Electron here, so tests can run it against temp folders.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, statfs, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CHAIN_DIRS,
  hardlinkable,
  isChainFile,
  MANIFEST_ENTRY,
  parseManifest,
  selectChainFiles,
  SUMS_ENTRY,
  type ChainManifest
} from '../shared/chainCopy.ts'
import { extractTar, tarEnd, tarHeader, tarPadding } from './chainTar.ts'

export interface ChainFile {
  path: string
  size: number
}

/** Leftover folders next to the data dir use these prefixes. */
export const SNAPSHOT_PREFIX = '.lithos-chain-seed-'
export const DOWNLOAD_PREFIX = '.lithos-chain-copy-'
export const ASIDE_PREFIX = '.lithos-chain-aside-'

/** Regular files under the chain folders, as forward-slash paths. Symlinks are not followed. */
export async function walkChainFiles(root: string): Promise<ChainFile[]> {
  const out: ChainFile[] = []
  const stack: string[] = [...CHAIN_DIRS]
  while (stack.length) {
    const rel = stack.pop()!
    let entries
    try {
      entries = await readdir(join(root, ...rel.split('/')), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) {
        const info = await lstat(join(root, ...child.split('/'))).catch(() => null)
        if (info?.isFile()) out.push({ path: child, size: info.size })
      }
    }
  }
  return selectChainFiles(out).sort((a, b) => a.path.localeCompare(b.path))
}

export async function chainBytes(root: string): Promise<number> {
  return (await walkChainFiles(root)).reduce((sum, file) => sum + file.size, 0)
}

/**
 * Hardlinks SST/LDB tables and copies the small files that change in place (MANIFEST, CURRENT,
 * write-ahead logs). Run only while the node is stopped; takes seconds for a full chain.
 */
export async function makeSnapshot(dataDir: string, snapDir: string): Promise<ChainFile[]> {
  const files = await walkChainFiles(dataDir)
  await mkdir(snapDir, { recursive: true })
  const made = new Set<string>()
  for (const file of files) {
    const from = join(dataDir, ...file.path.split('/'))
    const to = join(snapDir, ...file.path.split('/'))
    const dir = dirname(to)
    if (!made.has(dir)) {
      await mkdir(dir, { recursive: true })
      made.add(dir)
    }
    if (hardlinkable(file.path)) await link(from, to)
    else await copyFile(from, to)
  }
  return walkChainFiles(snapDir)
}

/**
 * Writes the snapshot as tar into `sink`: the manifest first, every file, then a sums entry with
 * each file's SHA-256 as it was read. `sink` must resolve once the bytes may be written again.
 */
export async function writeSnapshotTar(
  snapDir: string,
  manifest: ChainManifest,
  sink: (chunk: Buffer) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const writeEntry = async (path: string, body: Buffer): Promise<void> => {
    await sink(tarHeader(path, body.length, Date.now() / 1000))
    await sink(body)
    await sink(tarPadding(body.length))
  }
  await writeEntry(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest)))
  const sums: Record<string, string> = {}
  for (const file of manifest.files) {
    if (signal?.aborted) throw new Error('Transfer cancelled')
    await sink(tarHeader(file.path, file.size))
    const hash = createHash('sha256')
    let sent = 0
    for await (const chunk of createReadStream(join(snapDir, ...file.path.split('/')), { highWaterMark: 1 << 20 })) {
      const buf = chunk as Buffer
      if (sent + buf.length > file.size) throw new Error(`${file.path} grew during the transfer`)
      hash.update(buf)
      sent += buf.length
      await sink(buf)
    }
    if (sent !== file.size) throw new Error(`${file.path} shrank during the transfer`)
    await sink(tarPadding(file.size))
    sums[file.path] = hash.digest('hex')
  }
  await writeEntry(SUMS_ENTRY, Buffer.from(JSON.stringify({ v: 1, sha256: sums })))
  await sink(tarEnd())
}

/**
 * Unpacks a seed's tar into `dir` and checks it: the manifest comes first, every path is a chain
 * file listed there, sizes match, and every SHA-256 matches the sums entry at the end.
 * Wallet, keystore, config, and anything else is refused before a byte is written.
 */
export async function receiveSnapshot(
  source: AsyncIterable<Uint8Array>,
  dir: string,
  onProgress: (bytesDone: number, manifest: ChainManifest) => void = () => undefined
): Promise<ChainManifest> {
  let manifest: ChainManifest | null = null
  let expected = new Map<string, number>()
  const hashes = new Map<string, string>()
  let sums: Record<string, string> | null = null
  let done = 0

  let current: { path: string; size: number; got: number; hash: ReturnType<typeof createHash>; fh: FileHandle | null; meta: Buffer[] | null } | null = null

  await extractTar(source, {
    begin: async (path, size) => {
      if (sums) throw new Error('The copy has files after its checksum list')
      if (path === MANIFEST_ENTRY || path === SUMS_ENTRY) {
        if (path === MANIFEST_ENTRY && manifest) throw new Error('The copy has two manifests')
        if (path === SUMS_ENTRY && !manifest) throw new Error('The copy has no manifest')
        if (size > 64 * 2 ** 20) throw new Error('The copy manifest is too large')
        current = { path, size, got: 0, hash: createHash('sha256'), fh: null, meta: [] }
        return
      }
      if (!manifest) throw new Error('The copy has no manifest')
      if (!isChainFile(path)) throw new Error(`The copy contains a file that is not chain data: ${path}`)
      if (expected.get(path) !== size) throw new Error(`The copy contains an unexpected file: ${path}`)
      if (hashes.has(path)) throw new Error(`The copy repeats ${path}`)
      const target = join(dir, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      current = { path, size, got: 0, hash: createHash('sha256'), fh: await open(target, 'wx'), meta: null }
    },
    data: async (chunk) => {
      const entry = current!
      entry.got += chunk.length
      if (entry.meta) {
        entry.meta.push(Buffer.from(chunk))
        return
      }
      entry.hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await entry.fh!.write(chunk, offset, chunk.length - offset)
        offset += bytesWritten
      }
      done += chunk.length
      onProgress(done, manifest!)
    },
    end: async () => {
      const entry = current!
      current = null
      if (entry.meta) {
        const body = JSON.parse(Buffer.concat(entry.meta).toString('utf8')) as unknown
        if (entry.path === MANIFEST_ENTRY) {
          manifest = parseManifest(body)
          if (!manifest) throw new Error('The copy manifest is not valid')
          expected = new Map(manifest.files.map((file) => [file.path, file.size]))
          onProgress(0, manifest)
        } else {
          const record = body as { sha256?: unknown } | null
          if (!record || typeof record.sha256 !== 'object' || record.sha256 === null) {
            throw new Error('The copy checksum list is not valid')
          }
          sums = record.sha256 as Record<string, string>
        }
        return
      }
      await entry.fh!.close()
      if (entry.got !== entry.size) throw new Error(`${entry.path} is incomplete`)
      hashes.set(entry.path, entry.hash.digest('hex'))
    }
  }).finally(async () => {
    const left = current as { fh: FileHandle | null } | null
    await left?.fh?.close().catch(() => undefined)
  })

  const m = manifest as ChainManifest | null
  if (!m) throw new Error('The copy has no manifest')
  if (!sums) throw new Error('The copy has no checksum list')
  const list: Record<string, string> = sums
  for (const file of m.files) {
    const got = hashes.get(file.path)
    if (!got) throw new Error(`The copy is missing ${file.path}`)
    if (list[file.path] !== got) throw new Error(`${file.path} does not match its checksum`)
  }
  return m
}

/** Bytes free for this user on the disk that holds `dir`. Null when it cannot be read. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Moves the chain folders of `dataDir` into `asideDir` and the downloaded ones from `newDir` into
 * `dataDir`. Only history/, state/ and snapshots/ move; wallet/ and everything else stay in place.
 * Returns which folders moved each way, for restoreChainDirs.
 */
export interface ChainSwap {
  /** Old folders now in asideDir. */
  aside: string[]
  /** Copied folders now in dataDir. */
  placed: string[]
}

export async function swapChainDirs(dataDir: string, newDir: string, asideDir: string): Promise<ChainSwap> {
  await mkdir(asideDir, { recursive: true })
  const swap: ChainSwap = { aside: [], placed: [] }
  try {
    for (const name of CHAIN_DIRS) {
      if (await exists(join(dataDir, name))) {
        await rename(join(dataDir, name), join(asideDir, name))
        swap.aside.push(name)
      }
    }
    for (const name of CHAIN_DIRS) {
      if (await exists(join(newDir, name))) {
        await rename(join(newDir, name), join(dataDir, name))
        swap.placed.push(name)
      }
    }
  } catch (err) {
    try {
      await restoreChainDirs(dataDir, asideDir, swap, newDir)
    } catch {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { restoreFailed: true })
    }
    throw err
  }
  return swap
}

/**
 * Puts the old chain folders back. Only folders that came from the copy are moved out (into
 * `rejectDir`, deleted by the caller), so an old folder is never thrown away. wallet/ is not touched.
 */
export async function restoreChainDirs(dataDir: string, asideDir: string, swap: ChainSwap, rejectDir: string): Promise<void> {
  await mkdir(rejectDir, { recursive: true })
  for (const name of swap.placed) {
    const live = join(dataDir, name)
    if (!(await exists(live))) continue
    const reject = join(rejectDir, name)
    if (await exists(reject)) await rm(reject, { recursive: true, force: true })
    await rename(live, reject)
  }
  for (const name of swap.aside) {
    if (!(await exists(join(asideDir, name)))) continue
    if (await exists(join(dataDir, name))) throw new Error(`${name} is in the way of the old chain`)
    await rename(join(asideDir, name), join(dataDir, name))
  }
}

export interface ReplaceChainSteps {
  dataDir: string
  newDir: string
  asideDir: string
  /** Starts the node on whatever chain is in dataDir now. */
  startNode: () => Promise<void>
  stopNode: () => Promise<void>
  /** Resolves when the running node reports the copied height; rejects otherwise. */
  confirm: () => Promise<void>
  log?: (line: string) => void
}

export type ReplaceChainResult = { ok: true } | { ok: false; error: string; restored: boolean }

/**
 * Swap, start, confirm. On any failure the node is stopped, the old chain is put back, and the
 * node is started again on it. The old chain is deleted only after the node confirmed the copy.
 */
export async function replaceChain(steps: ReplaceChainSteps): Promise<ReplaceChainResult> {
  const log = steps.log ?? (() => undefined)
  let moved: ChainSwap
  try {
    moved = await swapChainDirs(steps.dataDir, steps.newDir, steps.asideDir)
  } catch (err) {
    const restored = (err as { restoreFailed?: boolean }).restoreFailed !== true
    if (restored) await steps.startNode().catch(() => undefined)
    return { ok: false, error: `Could not move the chain folders: ${message(err)}`, restored }
  }
  try {
    await steps.startNode()
    await steps.confirm()
  } catch (err) {
    const error = message(err)
    log(`The node did not run on the copied chain (${error}). Putting the old chain back.`)
    let restored = false
    try {
      await steps.stopNode().catch(() => undefined)
      await restoreChainDirs(steps.dataDir, steps.asideDir, moved, steps.newDir)
      restored = true
      await steps.startNode()
    } catch (restoreErr) {
      log(`Restarting on the old chain failed: ${message(restoreErr)}`)
    }
    return { ok: false, error, restored }
  }
  await rm(steps.asideDir, { recursive: true, force: true }).catch((err: unknown) =>
    log(`The old chain could not be deleted from ${steps.asideDir}: ${message(err)}`)
  )
  return { ok: true }
}

/** Removes leftover snapshot or download folders next to the data dir. Aside folders are kept. */
export async function removeLeftovers(parent: string, prefixes: readonly string[]): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(parent)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue
    await rm(join(parent, name), { recursive: true, force: true }).catch(() => undefined)
    removed.push(name)
  }
  return removed
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
