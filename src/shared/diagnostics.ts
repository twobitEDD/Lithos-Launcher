// The "Copy all diagnostics" bundle: what a remote helper needs to see why a node is not syncing,
// with every secret masked. No Node or DOM imports; main gathers the inputs.

export const REDACTED = '«redacted»'

/** Lines of each log in the bundle. */
export const DIAGNOSTIC_LOG_LINES = 500

/** Keys whose value is secret wherever the key appears inside a longer name. */
const SECRET_KEY_PARTS = [
  'apikey',
  'api_key',
  'api-key',
  'password',
  'passwd',
  'passphrase',
  'mnemonic',
  'secret',
  'token',
  'privatekey',
  'private_key',
  'authorization',
  'cookie'
]

/** Short keys that are only secret as the whole name (keystore JSON, seed phrases). */
const SECRET_KEY_EXACT = new Set([
  'pass',
  'pwd',
  'seed',
  'seedphrase',
  'seed_phrase',
  'words',
  'ciphertext',
  'salt',
  'iv',
  'authtag',
  'cipherparams',
  'key'
])

/** True when a settings or JSON key names a secret. */
export function isSecretKey(name: string): boolean {
  const lower = name.toLowerCase()
  const last = lower.split('.').pop() ?? lower
  if (SECRET_KEY_EXACT.has(last)) return true
  return SECRET_KEY_PARTS.some((part) => lower.includes(part))
}

/**
 * Unquoted booleans, numbers and null say nothing secret, and keep "apiKeySet: true" readable.
 * A quoted value is a string and may be a hex salt or a numeric password, so only "" passes.
 */
function harmless(value: string): boolean {
  if (/^(""|'')$/.test(value)) return true
  return /^(true|false|null|undefined|-?\d+(\.\d+)?)$/i.test(value.trim())
}

// key = value, key: value, "key": "value", api_key: value (HTTP header). The key may be dotted.
const KEY_VALUE_RE = /(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;}\]\[{"']+)/g

// Twelve to twenty-four short lowercase words in a row reads like a seed phrase.
const MNEMONIC_RE = /\b(?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8}\b/g

/** Words that never appear in a BIP-39 phrase but fill ordinary log sentences. */
const PROSE_WORDS = new Set([
  'the', 'and', 'not', 'from', 'this', 'that', 'for', 'with', 'are', 'was', 'has', 'have', 'will', 'but',
  'its', 'been', 'into', 'when', 'than', 'then', 'them', 'they', 'does', 'did', 'yet', 'our', 'you',
  'your', 'any', 'node', 'block', 'blocks', 'peer', 'peers', 'which', 'there', 'were', 'what', 'some'
])

/** Masks each stretch of 12+ words in `run` that contains no ordinary prose word. */
function maskMnemonics(run: string): string {
  const out: string[] = []
  let stretch: string[] = []
  const flush = (): void => {
    if (stretch.length >= 12) out.push(`${REDACTED} (word list)`)
    else out.push(...stretch)
    stretch = []
  }
  for (const word of run.split(/[ \t]+/)) {
    if (PROSE_WORDS.has(word)) {
      flush()
      out.push(word)
    } else {
      stretch.push(word)
    }
  }
  flush()
  return out.join(' ')
}

/**
 * Masks secrets in free text: every exact `secrets` value, values of secret-named keys, PEM blocks,
 * bearer tokens, and anything shaped like a seed phrase.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  const exact = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length)
  for (const secret of exact) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`)
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
  out = out.replace(KEY_VALUE_RE, (match, quote: string, key: string, sep: string, value: string) => {
    // A password may be all digits; other secret-named keys (tokenAccessCost) often hold plain numbers.
    const keep = /pass|pwd/i.test(key) ? /^(""|''|true|false|null)$/i.test(value) : harmless(value)
    if (!isSecretKey(key) || keep || value.includes(REDACTED)) return match
    const wrapped = value.startsWith('"') ? `"${REDACTED}"` : value.startsWith("'") ? `'${REDACTED}'` : REDACTED
    return `${quote}${key}${quote}${sep}${wrapped}`
  })
  out = out.replace(MNEMONIC_RE, maskMnemonics)
  return out
}

/** Deep copy with secret-named keys masked and every string run through redactText. */
export function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return '…'
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // A secret-named object (e.g. chain copy's `seed` status) is walked instead, so its own secret keys still mask.
    if (isSecretKey(key) && (typeof item === 'string' || Array.isArray(item))) {
      out[key] = typeof item === 'string' && harmless(item) ? item : REDACTED
    } else {
      out[key] = redactValue(item, secrets, depth + 1)
    }
  }
  return out
}

/** The last `count` lines. */
export function tailLines(lines: readonly string[], count = DIAGNOSTIC_LOG_LINES): string[] {
  return lines.length <= count ? [...lines] : lines.slice(lines.length - count)
}

export interface DiagnosticLog {
  name: string
  lines: readonly string[]
  /** Where the full log lives, for the reader. */
  source?: string | null
}

export interface DiagnosticsInput {
  generatedAt: string
  launcher: { version: string; electron?: string | null; packaged?: boolean }
  os: Record<string, unknown>
  /** A one-line node phase, as the node card shows it. */
  nodePhase?: string | null
  settings?: unknown
  install?: unknown
  node?: { state?: unknown; info?: unknown; health?: unknown; ergoConf?: string | null }
  client?: { state?: unknown; stats?: unknown }
  miner?: unknown
  lanPeers?: unknown
  chainCopy?: unknown
  remoteLauncher?: unknown
  logs: readonly DiagnosticLog[]
  /** Exact secret values to mask anywhere they appear. Never printed. */
  secrets: readonly string[]
  /** Facts that failed to load, so a missing section is explained. */
  errors?: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function numText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
}

/** Plain summary of /info so the reader does not have to dig through JSON. */
export function nodeInfoSummary(info: unknown): string[] {
  const r = asRecord(info)
  if (!r) return ['The node has not answered /info in this launcher session.']
  const lines = [
    `Ergo version: ${typeof r.appVersion === 'string' ? r.appVersion : '—'}`,
    `Headers height: ${numText(r.headersHeight)}`,
    `Full height: ${numText(r.fullHeight)}`,
    `Max peer height: ${numText(r.maxPeerHeight)}`,
    `Peers: ${numText(r.peersCount)}`,
    `Indexed height: ${numText(r.indexedHeight)}`
  ]
  if (typeof r.apiError === 'string' && r.apiError) lines.push(`Node API error: ${r.apiError}`)
  if (typeof r.answeredAt === 'number') lines.push(`Last /info answer: ${new Date(r.answeredAt).toISOString()}`)
  return lines
}

/** Sync details as readable lines: one per peer. */
export function syncDetailsSummary(info: unknown): string[] {
  const details = asRecord(asRecord(info)?.syncDetails)
  if (!details) return ['No sync details yet.']
  const lines = [
    `Blocks still to download: ${numText(details.blocksRemaining)}`,
    `Peer list read: ${details.peersKnown === true ? 'yes' : 'no'}; peer sync status read: ${details.syncInfoKnown === false ? 'no' : 'yes'}; block traffic read: ${details.trackKnown === true ? 'yes' : 'no'}`
  ]
  if (typeof details.lanNote === 'string') lines.push(`LAN note: ${details.lanNote}`)
  const peers = Array.isArray(details.peers) ? details.peers : []
  lines.push(`Connected peers: ${peers.length}`)
  for (const raw of peers) {
    const p = asRecord(raw)
    if (!p) continue
    lines.push(
      `  ${String(p.address)} ${p.lan ? 'LAN' : 'public'} ${p.direction ?? 'direction?'} height ${numText(p.remoteHeight)} ` +
        `suffix ${p.fullBlocksSuffix ?? '—'} sending ${p.sendingBlocks === null ? '?' : String(p.sendingBlocks)}`
    )
  }
  return lines
}

function section(title: string, body: string): string {
  return `===== ${title} =====\n${body.trimEnd()}\n`
}

function json(value: unknown, secrets: readonly string[]): string {
  if (value === undefined) return '(not available)'
  try {
    return JSON.stringify(redactValue(value, secrets), null, 2)
  } catch {
    return '(could not be shown)'
  }
}

/** The whole bundle as one plain-text document. Every part is redacted. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const s = input.secrets
  const parts: string[] = []
  parts.push(
    section(
      'Lithos Launcher diagnostics',
      [
        `Generated: ${input.generatedAt}`,
        `Launcher: ${input.launcher.version}${input.launcher.packaged === false ? ' (unpackaged)' : ''}`,
        input.launcher.electron ? `Electron: ${input.launcher.electron}` : null,
        'Secrets (API keys, passwords, seed words, keystore contents) are replaced with ' + REDACTED + '.'
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
    )
  )
  parts.push(section('System', json(input.os, s)))
  if (input.nodePhase) parts.push(section('Node phase', redactText(input.nodePhase, s)))
  parts.push(section('Node /info summary', nodeInfoSummary(input.node?.info).join('\n')))
  parts.push(section('Node process state', json(input.node?.state, s)))
  if (input.node?.health !== undefined) parts.push(section('Node API health', json(input.node.health, s)))
  parts.push(section('Sync details', syncDetailsSummary(input.node?.info).join('\n')))
  parts.push(section('LAN chain copy', json(input.chainCopy, s)))
  parts.push(section('LAN peers', json(input.lanPeers, s)))
  if (input.remoteLauncher !== undefined) parts.push(section('Other launcher on the LAN', json(input.remoteLauncher, s)))
  parts.push(section('Install state', json(input.install, s)))
  parts.push(section('Launcher settings', json(input.settings, s)))
  parts.push(
    section(
      'ergo.conf',
      input.node?.ergoConf === undefined || input.node.ergoConf === null
        ? '(not written yet)'
        : redactText(input.node.ergoConf, s)
    )
  )
  parts.push(section('Lithos Client state', json(input.client, s)))
  parts.push(section('SOAT miner state', json(input.miner, s)))
  if (input.errors?.length) parts.push(section('Could not collect', input.errors.map((e) => redactText(e, s)).join('\n')))
  for (const log of input.logs) {
    const lines = tailLines(log.lines)
    const head = `${lines.length} of ${log.lines.length} buffered lines${log.source ? ` (full log: ${log.source})` : ''}`
    parts.push(section(`${log.name} log`, `${head}\n${lines.map((line) => redactText(line, s)).join('\n')}`))
  }
  return parts.join('\n')
}

/** File name for "Save diagnostics": no colons, so it is valid on Windows too. */
export function diagnosticsFileName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
  return `lithos-diagnostics-${stamp}.txt`
}
