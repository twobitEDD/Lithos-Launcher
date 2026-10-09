import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  CHAIN_COPY_DISK_MARGIN,
  chainCopyLabel,
  decideChainCopy,
  fullHistoryVerdict,
  historyCheckHeights,
  isChainFile,
  isPrivateIpv4,
  parseAdvert,
  parseHistoryConf,
  parseManifest,
  seedSkipReason,
  type ChainManifest,
  type ChainSeedAdvert,
  type CopyContext
} from '../shared/chainCopy.ts'
import { makeSnapshot, receiveSnapshot, replaceChain, walkChainFiles, writeSnapshotTar } from './chainSnapshot.ts'
import { extractTar, tarEnd, tarHeader, tarPadding } from './chainTar.ts'

const GB = 2 ** 30
const TIP = 1_890_980

function advert(patch: Partial<ChainSeedAdvert> = {}): ChainSeedAdvert {
  return {
    v: 1,
    app: 'lithos-launcher',
    available: true,
    network: 'mainnet',
    nodeVersion: '6.0.1',
    db: 'leveldb',
    stateType: 'utxo',
    fullHeight: TIP,
    headersHeight: TIP,
    fullHistory: true,
    historyNote: null,
    chainBytes: 60 * GB,
    busy: false,
    ...patch
  }
}

function ctx(patch: Partial<CopyContext> = {}): CopyContext {
  return {
    copyEnabled: true,
    nodeOwned: true,
    network: 'mainnet',
    localFullHeight: 875_541,
    localDb: 'leveldb',
    freeBytes: 200 * GB,
    own: new Set(['127.0.0.1', '192.168.86.40']),
    avoid: new Set(),
    busy: false,
    clientRunning: false,
    ...patch
  }
}

/** The machine at .25: says blocksToKeep = -1 but was bootstrapped, so early blocks are missing. */
const SNAPSHOT_BOOTSTRAPPED = advert({ fullHistory: false, historyNote: 'no full block at height 500,000', chainBytes: null })

describe('decideChainCopy', () => {
  test('copies from a verified seed far ahead on the same network', () => {
    const decision = decideChainCopy([{ host: '192.168.86.28', advert: advert() }], ctx())
    assert.equal(decision.action, 'copy')
    assert.equal(decision.action === 'copy' && decision.host, '192.168.86.28')
  })

  test('a fresh node (no full height yet) copies too', () => {
    assert.equal(decideChainCopy([{ host: '192.168.86.28', advert: advert() }], ctx({ localFullHeight: null })).action, 'copy')
  })

  test('never copies from a peer without early history (the .25 case)', () => {
    const decision = decideChainCopy(
      [
        { host: '192.168.86.25', advert: SNAPSHOT_BOOTSTRAPPED },
        { host: '192.168.86.28', advert: advert({ fullHeight: TIP - 50 }) }
      ],
      ctx()
    )
    assert.equal(decision.action === 'copy' && decision.host, '192.168.86.28')
    assert.match(seedSkipReason('192.168.86.25', SNAPSHOT_BOOTSTRAPPED, ctx()) ?? '', /no full history/)
    assert.equal(decideChainCopy([{ host: '192.168.86.25', advert: SNAPSHOT_BOOTSTRAPPED }], ctx()).action, 'skip')
  })

  test('skips this computer, another network, and a db this node cannot read', () => {
    assert.equal(seedSkipReason('192.168.86.40', advert(), ctx()), 'this computer')
    assert.match(seedSkipReason('192.168.86.28', advert({ network: 'testnet' }), ctx()) ?? '', /testnet/)
    assert.match(seedSkipReason('192.168.86.28', advert({ db: 'rocksdb' }), ctx()) ?? '', /rocksdb/)
    assert.match(seedSkipReason('8.8.8.8', advert(), ctx()) ?? '', /private/)
  })

  test('skips when there is not enough free disk', () => {
    const tight = ctx({ freeBytes: 60 * GB + CHAIN_COPY_DISK_MARGIN - 1 })
    assert.match(seedSkipReason('192.168.86.28', advert(), tight) ?? '', /disk/)
    assert.equal(decideChainCopy([{ host: '192.168.86.28', advert: advert() }], tight).action, 'skip')
    assert.equal(seedSkipReason('192.168.86.28', advert(), ctx({ freeBytes: 60 * GB + CHAIN_COPY_DISK_MARGIN })), null)
  })

  test('skips when this node is not far behind', () => {
    assert.match(seedSkipReason('192.168.86.28', advert(), ctx({ localFullHeight: TIP - 99_999 })) ?? '', /not far enough/)
    assert.match(seedSkipReason('192.168.86.28', advert(), ctx({ localFullHeight: TIP + 10 })) ?? '', /not far enough/)
  })

  test('never stops a node this launcher did not start, or one the client needs', () => {
    const seeds = [{ host: '192.168.86.28', advert: advert() }]
    assert.equal(decideChainCopy(seeds, ctx({ nodeOwned: false })).action, 'skip')
    assert.equal(decideChainCopy(seeds, ctx({ clientRunning: true })).action, 'skip')
    assert.equal(decideChainCopy(seeds, ctx({ copyEnabled: false })).action, 'skip')
    assert.equal(decideChainCopy(seeds, ctx({ busy: true })).action, 'skip')
  })

  test('skips a busy seed, an unavailable one, and one that failed earlier', () => {
    assert.match(seedSkipReason('192.168.86.28', advert({ busy: true }), ctx()) ?? '', /busy/)
    assert.match(seedSkipReason('192.168.86.28', advert({ available: false }), ctx()) ?? '', /not running/)
    assert.match(seedSkipReason('192.168.86.28', advert(), ctx({ avoid: new Set(['192.168.86.28']) })) ?? '', /earlier/)
  })

  test('picks the highest seed, then the lowest address', () => {
    const decision = decideChainCopy(
      [
        { host: '192.168.86.30', advert: advert({ fullHeight: TIP - 5 }) },
        { host: '192.168.86.29', advert: advert() },
        { host: '192.168.86.28', advert: advert() }
      ],
      ctx()
    )
    assert.equal(decision.action === 'copy' && decision.host, '192.168.86.28')
  })
})

describe('full history check', () => {
  test('reads blocksToKeep, utxoBootstrap, and stateType; comments and earlier values do not count', () => {
    const conf = parseHistoryConf(
      ['ergo {', '  node {', '    blocksToKeep = 1440', '    # blocksToKeep = 5', '  }', '}', 'ergo.node.blocksToKeep = -1', 'ergo.node.utxoBootstrap = false'].join('\n')
    )
    assert.deepEqual(conf, { blocksToKeep: -1, utxoBootstrap: false, stateType: null })
  })

  test('verdicts', () => {
    const blank = { blocksToKeep: null, utxoBootstrap: null, stateType: null }
    const ok = [
      { height: 1, hasBlock: true },
      { height: 500_000, hasBlock: true }
    ]
    assert.deepEqual(fullHistoryVerdict({ conf: blank, stateType: 'utxo', checks: ok }), { full: true, note: null })
    assert.equal(fullHistoryVerdict({ conf: { ...blank, blocksToKeep: 1440 }, stateType: 'utxo', checks: ok }).full, false)
    assert.equal(fullHistoryVerdict({ conf: { ...blank, utxoBootstrap: true }, stateType: 'utxo', checks: ok }).full, false)
    assert.equal(fullHistoryVerdict({ conf: blank, stateType: 'digest', checks: ok }).full, false)
    assert.equal(fullHistoryVerdict({ conf: blank, stateType: 'utxo', checks: [] }).full, false)
    // .25: blocksToKeep = -1 in ergo.conf, but /blocks/at/500000 has no body.
    const bootstrapped = fullHistoryVerdict({
      conf: { ...blank, blocksToKeep: -1 },
      stateType: 'utxo',
      checks: [
        { height: 1, hasBlock: false },
        { height: 500_000, hasBlock: false }
      ]
    })
    assert.equal(bootstrapped.full, false)
    assert.match(bootstrapped.note ?? '', /height 1/)
  })

  test('check heights', () => {
    assert.deepEqual(historyCheckHeights(TIP), [1, 500_000])
    assert.deepEqual(historyCheckHeights(300_000), [1, 150_000])
    assert.deepEqual(historyCheckHeights(1), [])
    assert.deepEqual(historyCheckHeights(null), [])
  })
})

describe('isPrivateIpv4', () => {
  test('RFC 1918 only', () => {
    for (const ok of ['192.168.86.28', '10.0.0.5', '172.16.0.1', '172.31.255.254', '::ffff:192.168.1.5']) {
      assert.equal(isPrivateIpv4(ok), true, ok)
    }
    for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', '', undefined, null, '192.168.1']) {
      assert.equal(isPrivateIpv4(bad), false, String(bad))
    }
  })
})

describe('which files travel', () => {
  test('chain files only: no wallet, keystore, config, locks, info logs, or aside folders', () => {
    for (const ok of ['history/objects/000123.ldb', 'history/objects/000124.log', 'history/objects/MANIFEST-000120', 'history/objects/CURRENT', 'state/ldb_main/000010.sst', 'snapshots/OPTIONS-000005']) {
      assert.equal(isChainFile(ok), true, ok)
    }
    for (const bad of [
      'wallet/keystore/secret.json',
      'wallet/storage/000001.ldb',
      'history/wallet/000001.ldb',
      'state/keystore/a.ldb',
      'ergo.conf',
      'history/ergo.conf',
      'history/objects/LOCK',
      'history/objects/LOG',
      'history/objects/LOG.old',
      'history/objects/LOG.old.1700000000',
      'history/logs/x',
      'history.corrupt-20261002/objects/000001.ldb',
      'peers/000001.ldb',
      'history/../wallet/keystore/a.json',
      '/history/objects/000001.ldb',
      'history\\objects\\000001.ldb',
      'history'
    ]) {
      assert.equal(isChainFile(bad), false, bad)
    }
  })

  test('walking a data dir lists chain files and skips the wallet folder', async () => {
    const dir = await tempDir()
    await fakeDataDir(dir)
    const paths = (await walkChainFiles(dir)).map((file) => file.path)
    assert.deepEqual(paths, [
      'history/objects/000005.ldb',
      'history/objects/000006.log',
      'history/objects/CURRENT',
      'history/objects/MANIFEST-000004',
      'snapshots/000003.log',
      'state/ldb_main/000009.ldb'
    ])
    assert.ok(paths.every((path) => !/wallet|keystore|LOCK|LOG$|conf/.test(path)))
  })
})

describe('snapshot and tar stream', () => {
  test('hardlinks tables, round-trips through tar, and never carries the wallet', async () => {
    const base = await tempDir()
    const dataDir = join(base, 'seed', '.ergo')
    await fakeDataDir(dataDir)
    const snap = join(base, 'snap')
    const files = await makeSnapshot(dataDir, snap)
    const original = await stat(join(dataDir, 'history/objects/000005.ldb'))
    const linked = await stat(join(snap, 'history/objects/000005.ldb'))
    assert.equal(linked.ino, original.ino, 'tables are hardlinks')
    const manifestCopy = await stat(join(snap, 'history/objects/MANIFEST-000004'))
    assert.notEqual(manifestCopy.ino, (await stat(join(dataDir, 'history/objects/MANIFEST-000004'))).ino, 'MANIFEST is copied')

    const tar = await tarOf(snap, manifestOf(files))
    const out = join(base, 'out')
    await mkdir(out)
    const manifest = await receiveSnapshot(chunks(tar, 777), out)
    assert.equal(manifest.files.length, files.length)
    assert.equal(await readFile(join(out, 'state/ldb_main/000009.ldb'), 'utf8'), 'state table')
    await assert.rejects(stat(join(out, 'wallet')))
  })

  test('a changed byte fails the checksum', async () => {
    const base = await tempDir()
    await fakeDataDir(join(base, 'd'))
    const files = await makeSnapshot(join(base, 'd'), join(base, 's'))
    const tar = await tarOf(join(base, 's'), manifestOf(files))
    const at = tar.indexOf(Buffer.from('state table'))
    assert.ok(at > 0)
    tar[at] ^= 0x01
    await mkdir(join(base, 'o'))
    await assert.rejects(receiveSnapshot(chunks(tar, 4096), join(base, 'o')), /checksum/)
  })

  test('a stream that stops early is refused', async () => {
    const base = await tempDir()
    await fakeDataDir(join(base, 'd'))
    const files = await makeSnapshot(join(base, 'd'), join(base, 's'))
    const tar = await tarOf(join(base, 's'), manifestOf(files))
    await mkdir(join(base, 'o'))
    await assert.rejects(receiveSnapshot(chunks(tar.subarray(0, tar.length - 2048), 4096), join(base, 'o')))
  })

  test('a seed cannot push wallet files, even if its manifest lists them', async () => {
    const evil = { v: 1, network: 'mainnet', fullHeight: 1, totalBytes: 3, files: [{ path: 'wallet/keystore/k.json', size: 3 }] }
    assert.equal(parseManifest(evil), null)
    const base = await tempDir()
    const good = { v: 1, network: 'mainnet', nodeVersion: null, db: null, fullHeight: 1, headersHeight: null, totalBytes: 3, files: [{ path: 'history/objects/000001.ldb', size: 3 }] }
    const parts = [
      entry('.lithos-chain-manifest.json', Buffer.from(JSON.stringify(good))),
      entry('wallet/keystore/k.json', Buffer.from('abc')),
      tarEnd()
    ]
    await assert.rejects(receiveSnapshot(chunks(Buffer.concat(parts), 512), base), /not chain data/)
    await assert.rejects(stat(join(base, 'wallet')))
  })

  test('tar headers read back, including long paths', async () => {
    const long = `history/${'a'.repeat(90)}/${'b'.repeat(60)}.ldb`
    const body = Buffer.from('x'.repeat(1000))
    const seen: { path: string; size: number; data: string }[] = []
    let current: { path: string; size: number; data: string } | null = null
    await extractTar(chunks(Buffer.concat([entry(long, body), tarEnd()]), 100), {
      begin: (path, size) => {
        current = { path, size, data: '' }
      },
      data: (chunk) => {
        current!.data += chunk.toString()
      },
      end: () => {
        seen.push(current!)
      }
    })
    assert.deepEqual(seen, [{ path: long, size: 1000, data: body.toString() }])
  })
})

describe('replaceChain', () => {
  test('a node that fails on the copy gets the old chain back; the wallet never moves', async () => {
    const base = await tempDir()
    const dataDir = join(base, '.ergo')
    await fakeDataDir(dataDir)
    await writeFile(join(dataDir, 'history/objects/000005.ldb'), 'old history')
    const newDir = join(base, 'new')
    await mkdir(join(newDir, 'history/objects'), { recursive: true })
    await writeFile(join(newDir, 'history/objects/000777.ldb'), 'copied history')
    await mkdir(join(newDir, 'state/ldb_main'), { recursive: true })
    await writeFile(join(newDir, 'state/ldb_main/000888.ldb'), 'copied state')
    const walletBefore = await readFile(join(dataDir, 'wallet/keystore/secret.json'), 'utf8')
    const calls: string[] = []
    const result = await replaceChain({
      dataDir,
      newDir,
      asideDir: join(base, 'aside'),
      startNode: async () => {
        calls.push('start')
        assert.equal(await readFile(join(dataDir, 'wallet/keystore/secret.json'), 'utf8'), walletBefore)
      },
      stopNode: async () => {
        calls.push('stop')
      },
      confirm: async () => {
        throw new Error('height 0')
      }
    })
    assert.deepEqual(result, { ok: false, error: 'height 0', restored: true })
    assert.deepEqual(calls, ['start', 'stop', 'start'])
    assert.equal(await readFile(join(dataDir, 'history/objects/000005.ldb'), 'utf8'), 'old history')
    assert.equal(await readFile(join(dataDir, 'state/ldb_main/000009.ldb'), 'utf8'), 'state table')
    await assert.rejects(stat(join(dataDir, 'history/objects/000777.ldb')))
    assert.equal(await readFile(join(dataDir, 'wallet/keystore/secret.json'), 'utf8'), walletBefore)
    assert.deepEqual((await readdir(join(dataDir, 'wallet'))).sort(), ['keystore', 'storage'])
  })

  test('success keeps the copy and the wallet, and deletes the old chain', async () => {
    const base = await tempDir()
    const dataDir = join(base, '.ergo')
    await fakeDataDir(dataDir)
    const newDir = join(base, 'new')
    await mkdir(join(newDir, 'history/objects'), { recursive: true })
    await writeFile(join(newDir, 'history/objects/000777.ldb'), 'copied history')
    const asideDir = join(base, 'aside')
    const result = await replaceChain({
      dataDir,
      newDir,
      asideDir,
      startNode: async () => undefined,
      stopNode: async () => undefined,
      confirm: async () => undefined
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(await readFile(join(dataDir, 'history/objects/000777.ldb'), 'utf8'), 'copied history')
    await assert.rejects(stat(join(dataDir, 'state')), 'the old state went with the old chain')
    await assert.rejects(stat(asideDir))
    assert.equal(await readFile(join(dataDir, 'wallet/keystore/secret.json'), 'utf8'), 'do not send')
    assert.equal(await readFile(join(dataDir, 'peers/000001.ldb'), 'utf8'), 'peers')
  })

  test('a start that throws also restores', async () => {
    const base = await tempDir()
    const dataDir = join(base, '.ergo')
    await fakeDataDir(dataDir)
    const newDir = join(base, 'new')
    await mkdir(join(newDir, 'history/objects'), { recursive: true })
    await writeFile(join(newDir, 'history/objects/000777.ldb'), 'copied')
    let starts = 0
    const result = await replaceChain({
      dataDir,
      newDir,
      asideDir: join(base, 'aside'),
      startNode: async () => {
        starts++
        if (starts === 1) throw new Error('The node exited during startup')
      },
      stopNode: async () => undefined,
      confirm: async () => undefined
    })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.restored, true)
    assert.equal(starts, 2)
    assert.equal(await readFile(join(dataDir, 'history/objects/000005.ldb'), 'utf8'), 'history table')
  })
})

describe('parseAdvert and labels', () => {
  test('malformed adverts are null; extra fields are dropped', () => {
    assert.equal(parseAdvert(null), null)
    assert.equal(parseAdvert({ v: 2, app: 'lithos-launcher' }), null)
    assert.equal(parseAdvert({ v: 1, app: 'other' }), null)
    const parsed = parseAdvert({ ...advert(), apiKey: 'nope' })
    assert.deepEqual(parsed, advert())
  })

  test('progress line', () => {
    const line = chainCopyLabel({ phase: 'downloading', from: '192.168.86.28', bytesDone: 12 * GB, bytesTotal: 60 * GB, etaSeconds: 1800, message: null })
    assert.equal(line, 'Copying blockchain from 192.168.86.28 — 12.0 GB of 60.0 GB, about 30 min left')
    assert.equal(chainCopyLabel({ phase: 'idle', from: null, bytesDone: 0, bytesTotal: null, etaSeconds: null, message: null }), null)
  })
})

const temps: string[] = []
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lithos-chain-copy-'))
  temps.push(dir)
  return dir
}

async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), body)
}

async function fakeDataDir(root: string): Promise<void> {
  await put(root, 'history/objects/000005.ldb', 'history table')
  await put(root, 'history/objects/000006.log', 'write-ahead log')
  await put(root, 'history/objects/CURRENT', 'MANIFEST-000004\n')
  await put(root, 'history/objects/MANIFEST-000004', 'manifest')
  await put(root, 'history/objects/LOCK', '')
  await put(root, 'history/objects/LOG', 'info log')
  await put(root, 'history/objects/LOG.old', 'old info log')
  await put(root, 'state/ldb_main/000009.ldb', 'state table')
  await put(root, 'snapshots/000003.log', 'snapshots')
  await put(root, 'wallet/keystore/secret.json', 'do not send')
  await put(root, 'wallet/storage/000001.ldb', 'wallet db')
  await put(root, 'peers/000001.ldb', 'peers')
  await put(root, 'history.corrupt-20261002T212720Z/objects/000001.ldb', 'aside')
  await put(root, 'ergo.conf', 'scorex.restApi.apiKeyHash = "x"')
}

function manifestOf(files: { path: string; size: number }[]): ChainManifest {
  return {
    v: 1,
    network: 'mainnet',
    nodeVersion: '6.0.1',
    db: 'leveldb',
    fullHeight: TIP,
    headersHeight: TIP,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files
  }
}

async function tarOf(snapDir: string, manifest: ChainManifest): Promise<Buffer> {
  const parts: Buffer[] = []
  await writeSnapshotTar(snapDir, manifest, async (chunk) => {
    parts.push(Buffer.from(chunk))
  })
  return Buffer.concat(parts)
}

function entry(path: string, body: Buffer): Buffer {
  return Buffer.concat([tarHeader(path, body.length), body, tarPadding(body.length)])
}

async function* chunks(buf: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}
