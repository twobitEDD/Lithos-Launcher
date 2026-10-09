import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildDiagnostics,
  DIAGNOSTIC_LOG_LINES,
  diagnosticsFileName,
  isSecretKey,
  nodeInfoSummary,
  REDACTED,
  redactText,
  redactValue,
  tailLines
} from '../shared/diagnostics.ts'

const NODE_KEY = 'Zq3v9xY_kd82HfLw0pQm7rT2sNcB5uVjA1eGhIoK4lM'
const API_HASH = '324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf'
const WALLET_PASS = 'correct horse battery'
const MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

describe('redactText', () => {
  test('masks exact secrets wherever they appear', () => {
    const out = redactText(`curl -H "api_key: ${NODE_KEY}" http://127.0.0.1:9053/wallet/status`, [NODE_KEY])
    assert.ok(!out.includes(NODE_KEY))
    assert.ok(out.includes(REDACTED))
  })

  test('masks the values of secret-named keys in conf, JSON and headers', () => {
    const conf = `scorex.restApi.apiKeyHash = "${API_HASH}"\nergo.wallet.secretStorage.secretDir = "/x"`
    const out = redactText(conf)
    assert.ok(!out.includes(API_HASH))
    assert.match(out, /apiKeyHash = "«redacted»"/)
    assert.match(redactText('{"pass": "hunter22", "mnemonic": "a b c"}'), /"pass": "«redacted»", "mnemonic": "«redacted»"/)
    assert.equal(redactText('api_key: abcdef123456'), `api_key: ${REDACTED}`)
    assert.equal(redactText('LITHOS_API_KEY=abcdef123456'), `LITHOS_API_KEY=${REDACTED}`)
    assert.match(redactText('-Dplay.http.secret.key=s3cr3tvalue'), /secret\.key=«redacted»/)
  })

  test('keeps booleans, numbers and ordinary log text', () => {
    assert.equal(redactText('"apiKeySet": true, "tokenAccessCost" : 100'), '"apiKeySet": true, "tokenAccessCost" : 100')
    const line = '2026-10-09 INFO [ergoref-akka.actor.default-dispatcher-5] o.e.n.ErgoNodeViewSynchronizer - Got 400 headers from 1.2.3.4'
    assert.equal(redactText(line), line)
    const prose = 'the node is not receiving block bodies from them and this node still needs earlier blocks'
    assert.equal(redactText(prose), prose)
  })

  test('masks a seed-phrase-shaped run of words, a PEM key and bearer tokens', () => {
    assert.ok(!redactText(`restored with ${MNEMONIC} ok`).includes('abandon ability'))
    assert.equal(
      redactText('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'),
      REDACTED
    )
    assert.ok(!redactText('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'))
    assert.equal(redactText('sent Bearer abcdefghijklmnop'), `sent Bearer ${REDACTED}`)
    assert.equal(redactText('token ghp_abcdefghijklmnopqrstuvwxyz0123'), `token ${REDACTED}`)
  })

  test('masks keystore JSON fields', () => {
    const keystore = '{"cipherText":"9a8b7c6d5e4f","salt":"00112233","iv":"aabbccdd","authTag":"ffee","cipherParams":{"prf":"HmacSHA256"}}'
    const out = redactText(keystore)
    for (const value of ['9a8b7c6d5e4f', '00112233', 'aabbccdd', 'ffee']) assert.ok(!out.includes(value), value)
    assert.ok(out.includes('HmacSHA256'))
  })
})

describe('redactValue', () => {
  test('masks secret keys deeply and keeps the rest', () => {
    const out = redactValue(
      {
        root: '/home/u/Lithos',
        heap: { nodeMb: 4096 },
        nested: { apiKey: NODE_KEY, walletPassword: WALLET_PASS, note: `key was ${NODE_KEY}` },
        seed: { serving: true, fullHistory: false, note: 'not enough blocks yet' },
        words: ['abandon', 'ability'],
        lanChainSeed: false
      },
      [NODE_KEY]
    ) as Record<string, Record<string, unknown>>
    assert.equal(out.root as unknown, '/home/u/Lithos')
    assert.deepEqual(out.heap, { nodeMb: 4096 })
    assert.equal(out.nested.apiKey, REDACTED)
    assert.equal(out.nested.walletPassword, REDACTED)
    assert.equal(out.nested.note, `key was ${REDACTED}`)
    assert.deepEqual(out.seed, { serving: true, fullHistory: false, note: 'not enough blocks yet' })
    assert.equal(out.words as unknown, REDACTED)
    assert.equal(out.lanChainSeed as unknown, false)
  })

  test('isSecretKey covers the names the launcher and Ergo use', () => {
    for (const key of ['apiKeyHash', 'api_key', 'scorex.restApi.apiKeyHash', 'password', 'pass', 'mnemonic', 'iv', 'playSecret']) {
      assert.ok(isSecretKey(key), key)
    }
    for (const key of ['peersCount', 'fullHeight', 'seedEnabled', 'lanChainSeed', 'seeds', 'headersHeight']) {
      assert.ok(!isSecretKey(key), key)
    }
  })
})

describe('buildDiagnostics', () => {
  const longLog = Array.from({ length: 1200 }, (_, i) => `line ${i}`)
  const text = buildDiagnostics({
    generatedAt: '2026-10-09T18:00:00.000Z',
    launcher: { version: '0.2.1-twobit.6', electron: '44.4.5', packaged: true },
    os: { platform: 'linux', release: '7.0.0', arch: 'x64', freeDiskGB: 120 },
    nodePhase: 'Connected to 15 peers, waiting for them to report the chain height',
    settings: { v: 1, nodeNetwork: 'mainnet', lanChainSeed: true },
    install: { java: { installed: true }, node: { installed: true, version: '6.0.7' } },
    node: {
      state: { id: 'node', status: 'running', detail: null },
      info: {
        appVersion: '6.0.7',
        headersHeight: 0,
        fullHeight: null,
        maxPeerHeight: null,
        peersCount: 15,
        indexedHeight: null,
        syncDetails: {
          blocksRemaining: null,
          peersKnown: true,
          syncInfoKnown: true,
          trackKnown: true,
          lanNote: null,
          peers: [{ address: '5.6.7.8:9030', lan: false, direction: 'outgoing', remoteHeight: null, fullBlocksSuffix: null, sendingBlocks: false }]
        }
      },
      health: { failuresInARow: 0 },
      ergoConf: `scorex {\n  restApi {\n    apiKeyHash = "${API_HASH}"\n  }\n}`
    },
    client: { state: { status: 'stopped' } },
    miner: { status: 'waiting', detail: 'Waiting for the Lithos Client stratum' },
    lanPeers: { enabled: true, phase: 'done', found: 2, hosts: ['192.168.86.25', '192.168.86.28'] },
    chainCopy: { phase: 'idle', unreachable: [{ host: '192.168.86.28', reason: 'timeout' }] },
    logs: [
      { name: 'Ergo node', lines: [...longLog, `[launcher] key ${NODE_KEY}`], source: '/home/u/Lithos/mainnet/node' },
      { name: 'Lithos Client', lines: [`password=${WALLET_PASS}`] },
      { name: 'SOAT miner', lines: [] }
    ],
    secrets: [NODE_KEY, WALLET_PASS, API_HASH],
    errors: ['free disk space: EACCES']
  })

  test('has every section', () => {
    for (const title of [
      'Lithos Launcher diagnostics',
      'System',
      'Node phase',
      'Node /info summary',
      'Node process state',
      'Node API health',
      'Sync details',
      'LAN chain copy',
      'LAN peers',
      'Install state',
      'Launcher settings',
      'ergo.conf',
      'Lithos Client state',
      'SOAT miner state',
      'Could not collect',
      'Ergo node log',
      'Lithos Client log',
      'SOAT miner log'
    ]) {
      assert.ok(text.includes(`===== ${title} =====`), title)
    }
    assert.match(text, /Launcher: 0\.2\.1-twobit\.6/)
    assert.match(text, /Peers: 15/)
    assert.match(text, /5\.6\.7\.8:9030 public outgoing height —/)
    assert.match(text, /192\.168\.86\.28/)
  })

  test('contains no secret', () => {
    for (const secret of [NODE_KEY, WALLET_PASS, API_HASH]) assert.ok(!text.includes(secret), secret)
  })

  test('keeps only the last lines of each log', () => {
    assert.match(text, new RegExp(`${DIAGNOSTIC_LOG_LINES} of 1,?201 buffered lines`))
    assert.ok(!text.includes('line 700\n'))
    assert.ok(text.includes('line 1199'))
  })

  test('summarises a node that never answered', () => {
    assert.deepEqual(nodeInfoSummary(null), ['The node has not answered /info in this launcher session.'])
  })

  test('includes start-up progress read from the node log', () => {
    const lines = nodeInfoSummary({
      fullHeight: null,
      startup: {
        readersPending: true,
        restore: { block: 875_570, target: 875_732, blocksPerHour: 11.6, etaSeconds: 50_276, updatedAt: 0 },
        indexer: { block: 833_764, target: 875_732, updatedAt: 0 }
      }
    })
    assert.ok(lines.includes('Start-up (from the node log): database loading yes'))
    assert.ok(lines.includes('  Restoring state: block 875,570 of 875,732, 11.6 blocks/hour, ETA 838 min'))
    assert.ok(lines.includes('  Extra indexer: block 833,764 / 875,732'))
  })
})

test('tailLines and diagnosticsFileName', () => {
  assert.deepEqual(tailLines(['a', 'b', 'c'], 2), ['b', 'c'])
  assert.deepEqual(tailLines(['a'], 2), ['a'])
  assert.equal(diagnosticsFileName(new Date('2026-10-09T18:05:07.123Z')), 'lithos-diagnostics-2026-10-09T18-05-07Z.txt')
})
