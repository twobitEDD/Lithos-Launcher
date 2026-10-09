// Copying the blockchain from another Lithos launcher on this LAN. No sockets or files here:
// the seed's advert shape, which files may travel, who may connect, and when to copy.

/** The seed service port on every launcher. Not an Ergo or Lithos Client port. */
export const CHAIN_SEED_PORT = 9077
export const CHAIN_SEED_PATH = '/lithos/chain-seed/v1'
export const CHAIN_SEED_DOWNLOAD_PATH = `${CHAIN_SEED_PATH}/download`

/** Copy only when a LAN seed is at least this many full blocks ahead. */
export const CHAIN_COPY_MIN_GAP = 100_000

/** Room left on the disk after the copy, on top of the chain itself. */
export const CHAIN_COPY_DISK_MARGIN = 2 * 2 ** 30

/** Folders in the node data directory that make up the chain. Everything else stays home. */
export const CHAIN_DIRS = ['history', 'state', 'snapshots'] as const

/** First and last entries of the tar stream. */
export const MANIFEST_ENTRY = '.lithos-chain-manifest.json'
export const SUMS_ENTRY = '.lithos-chain-sums.json'

export type ChainNetwork = 'mainnet' | 'testnet'
export type ChainDb = 'leveldb' | 'rocksdb'

/** What GET CHAIN_SEED_PATH returns. Heights and versions only, never keys or paths. */
export interface ChainSeedAdvert {
  v: 1
  app: 'lithos-launcher'
  /** False while this launcher's own node is not running (or it adopted someone else's). */
  available: boolean
  network: ChainNetwork | null
  nodeVersion: string | null
  db: ChainDb | null
  stateType: string | null
  fullHeight: number | null
  headersHeight: number | null
  /** True only after the node returned full blocks at height 1 and a mid height. */
  fullHistory: boolean
  /** Why fullHistory is false, in a few words. */
  historyNote: string | null
  /** Bytes of the chain folders, for the receiver's disk check. */
  chainBytes: number | null
  /** A transfer is running; try later. */
  busy: boolean
}

/** First tar entry: the files that follow. */
export interface ChainManifest {
  v: 1
  network: ChainNetwork
  nodeVersion: string | null
  db: ChainDb | null
  fullHeight: number
  headersHeight: number | null
  totalBytes: number
  files: { path: string; size: number }[]
}

/** One LAN launcher as the receiver sees it. */
export interface ChainSeedRow {
  host: string
  advert: ChainSeedAdvert
  /** Null when this launcher would copy from it now; otherwise why not. */
  skip: string | null
}

export type ChainCopyPhase =
  | 'idle'
  | 'stopping'
  | 'waiting-seed'
  | 'downloading'
  | 'verifying'
  | 'swapping'
  | 'starting'
  | 'restoring'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface ChainCopyStatus {
  /** lanChainCopy: copy from a LAN launcher when far behind. */
  copyEnabled: boolean
  /** lanChainSeed: offer this computer's chain to other launchers. */
  seedEnabled: boolean
  phase: ChainCopyPhase
  from: string | null
  bytesDone: number
  bytesTotal: number | null
  etaSeconds: number | null
  message: string | null
  /** Launchers found on the last LAN scan. */
  seeds: ChainSeedRow[]
  scanning: boolean
  /** This computer as a seed. */
  seed: { serving: boolean; fullHistory: boolean; note: string | null; sendingTo: string | null }
}

export const ACTIVE_COPY_PHASES: readonly ChainCopyPhase[] = [
  'stopping',
  'waiting-seed',
  'downloading',
  'verifying',
  'swapping',
  'starting',
  'restoring'
]

/** Cancel is possible until the old chain has been moved aside. */
export const CANCELLABLE_PHASES: readonly ChainCopyPhase[] = ['stopping', 'waiting-seed', 'downloading', 'verifying']

export function copyActive(phase: ChainCopyPhase): boolean {
  return ACTIVE_COPY_PHASES.includes(phase)
}

/** Absent or true means on. */
export function chainSeedAllowed(flag: boolean | undefined): boolean {
  return flag !== false
}

export function chainCopyAllowed(flag: boolean | undefined): boolean {
  return flag !== false
}

function ipv4Parts(ip: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  return parts.some((n) => n > 255) ? null : parts
}

/** Socket remote addresses can be IPv4-mapped IPv6 ("::ffff:192.168.1.5"). */
export function plainIpv4(address: string | undefined | null): string | null {
  if (!address) return null
  const text = address.trim().toLowerCase().replace(/^::ffff:/, '')
  return ipv4Parts(text) ? text : null
}

/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. Loopback, link-local, public, and IPv6 are refused. */
export function isPrivateIpv4(address: string | undefined | null): boolean {
  const ip = plainIpv4(address)
  if (!ip) return false
  const [a, b] = ipv4Parts(ip)!
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const SKIPPED_NAMES = new Set(['lock', 'log', 'log.old', 'logs'])
const SECRET_RE = /wallet|keystore|secret|mnemonic|passw|seed|key|\.conf$|\.json$/i

/**
 * True for a file that belongs to the chain and may be sent: under history/, state/ or
 * snapshots/, not a database LOCK or info LOG, and nothing that looks like a key, wallet, or config.
 * LevelDB "NNNNNN.log" files are write-ahead logs with chain data, so they are kept.
 */
export function isChainFile(path: string): boolean {
  if (!safeRelativePath(path)) return false
  const parts = path.split('/')
  if (parts.length < 2) return false
  if (!(CHAIN_DIRS as readonly string[]).includes(parts[0])) return false
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (SKIPPED_NAMES.has(lower) || /^log\.old\.\d+$/.test(lower) || part.startsWith('.')) return false
    if (SECRET_RE.test(part)) return false
  }
  return true
}

/** Filters a walked file list down to what a seed sends. Order is kept. */
export function selectChainFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => isChainFile(file.path))
}

/** Forward-slash relative path with no "..", empty, absolute, or drive parts. */
export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 255 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (/^[a-z]:/i.test(path)) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** SST/LDB tables never change after they are written, so the snapshot can hardlink them. */
export function hardlinkable(path: string): boolean {
  return /\.(sst|ldb)$/i.test(path)
}

/** What ergo.conf says about pruning and bootstrap. Last setting wins, as in HOCON. */
export interface HistoryConf {
  blocksToKeep: number | null
  utxoBootstrap: boolean | null
  stateType: string | null
}

export function parseHistoryConf(text: string): HistoryConf {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n')
  const last = (re: RegExp): string | null => {
    let found: string | null = null
    for (const match of body.matchAll(re)) found = match[1]
    return found
  }
  const keep = last(/\bblocksToKeep\s*[=:]\s*(-?\d+)/g)
  const bootstrap = last(/\butxoBootstrap\s*[=:]\s*(true|false)\b/g)
  const state = last(/\bstateType\s*[=:]\s*"?(utxo|digest)"?/g)
  return {
    blocksToKeep: keep === null ? null : Number(keep),
    utxoBootstrap: bootstrap === null ? null : bootstrap === 'true',
    stateType: state
  }
}

/** Heights a seed checks on its own node: the first block and one in the middle. */
export function historyCheckHeights(fullHeight: number | null): number[] {
  if (fullHeight === null || fullHeight < 2) return []
  return [1, Math.min(500_000, Math.floor(fullHeight / 2))]
}

/** Whether a seed really holds every full block, from its config and its own node's answers. */
export function fullHistoryVerdict(input: {
  conf: HistoryConf
  stateType: string | null
  checks: readonly { height: number; hasBlock: boolean }[]
}): { full: boolean; note: string | null } {
  const { conf } = input
  if (conf.blocksToKeep !== null && conf.blocksToKeep !== -1) {
    return { full: false, note: `keeps only the last ${conf.blocksToKeep} blocks` }
  }
  if (conf.utxoBootstrap === true) return { full: false, note: 'started from a UTXO snapshot' }
  const state = (input.stateType ?? conf.stateType ?? 'utxo').toLowerCase()
  if (state !== 'utxo') return { full: false, note: `${state} state, not utxo` }
  if (input.checks.length === 0) return { full: false, note: 'not enough blocks yet' }
  const missing = input.checks.find((check) => !check.hasBlock)
  if (missing) return { full: false, note: `no full block at height ${missing.height.toLocaleString('en-US')}` }
  return { full: true, note: null }
}

export interface CopyContext {
  copyEnabled: boolean
  /** The node runs and this launcher started it. An adopted node is never stopped. */
  nodeOwned: boolean
  network: ChainNetwork | null
  /** Null on a fresh node that has not reported any full block. */
  localFullHeight: number | null
  /** The database the installed node reads; null if unknown. */
  localDb: ChainDb | null
  freeBytes: number | null
  own: ReadonlySet<string>
  /** Hosts not to try again for now (a failure or a cancel). */
  avoid: ReadonlySet<string>
  busy: boolean
  /** The Lithos Client needs the node; a copy waits until it is stopped. */
  clientRunning: boolean
}

/** Null when `host` is a usable seed under `ctx`; otherwise a short reason. */
export function seedSkipReason(host: string, advert: ChainSeedAdvert, ctx: CopyContext): string | null {
  if (ctx.own.has(host)) return 'this computer'
  if (!isPrivateIpv4(host)) return 'not a private LAN address'
  if (!advert.available) return 'its node is not running in that launcher'
  if (!advert.network || advert.network !== ctx.network) return `on ${advert.network ?? 'no network'}, not ${ctx.network ?? 'this network'}`
  if (!advert.fullHistory) return `no full history${advert.historyNote ? ` (${advert.historyNote})` : ''}`
  if (advert.fullHeight === null) return 'height not reported'
  if (advert.db && ctx.localDb && advert.db !== ctx.localDb) return `stores ${advert.db}, this node reads ${ctx.localDb}`
  if (ctx.avoid.has(host)) return 'a copy from it failed or was cancelled earlier'
  const gap = advert.fullHeight - (ctx.localFullHeight ?? 0)
  if (gap < CHAIN_COPY_MIN_GAP) return 'not far enough ahead to be worth copying'
  if (advert.busy) return 'busy sending to another computer'
  if (advert.chainBytes !== null && ctx.freeBytes !== null && ctx.freeBytes < advert.chainBytes + CHAIN_COPY_DISK_MARGIN) {
    return 'not enough free disk space here'
  }
  return null
}

export type CopyDecision = { action: 'copy'; host: string; advert: ChainSeedAdvert } | { action: 'skip'; reason: string }

/** The seed to copy from now, or why not. The highest verified seed wins; ties go to the lowest address. */
export function decideChainCopy(seeds: readonly { host: string; advert: ChainSeedAdvert }[], ctx: CopyContext): CopyDecision {
  if (!ctx.copyEnabled) return { action: 'skip', reason: 'copying from the LAN is off' }
  if (ctx.busy) return { action: 'skip', reason: 'a copy is already running' }
  if (ctx.clientRunning) return { action: 'skip', reason: 'the Lithos Client is running on this node' }
  if (!ctx.nodeOwned) return { action: 'skip', reason: 'the node is not one this launcher started' }
  const usable = seeds
    .filter((seed) => seedSkipReason(seed.host, seed.advert, ctx) === null)
    .sort(
      (a, b) =>
        (b.advert.fullHeight ?? 0) - (a.advert.fullHeight ?? 0) ||
        a.host.localeCompare(b.host, 'en', { numeric: true })
    )
  const best = usable[0]
  if (!best) return { action: 'skip', reason: seeds.length ? 'no LAN launcher can seed this node' : 'no LAN launcher found' }
  return { action: 'copy', host: best.host, advert: best.advert }
}

/** Parses an advert from the network. Anything malformed is null. */
export function parseAdvert(body: unknown): ChainSeedAdvert | null {
  if (!body || typeof body !== 'object') return null
  const r = body as Record<string, unknown>
  if (r.v !== 1 || r.app !== 'lithos-launcher') return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 64 ? v : null)
  const network = r.network === 'mainnet' || r.network === 'testnet' ? r.network : null
  const db = r.db === 'leveldb' || r.db === 'rocksdb' ? r.db : null
  return {
    v: 1,
    app: 'lithos-launcher',
    available: r.available === true,
    network,
    nodeVersion: str(r.nodeVersion),
    db,
    stateType: str(r.stateType),
    fullHeight: num(r.fullHeight),
    headersHeight: num(r.headersHeight),
    fullHistory: r.fullHistory === true,
    historyNote: typeof r.historyNote === 'string' ? r.historyNote.slice(0, 120) : null,
    chainBytes: num(r.chainBytes),
    busy: r.busy === true
  }
}

/** Checks the manifest a seed sends first. Every path must be a chain file. */
export function parseManifest(body: unknown): ChainManifest | null {
  if (!body || typeof body !== 'object') return null
  const r = body as Record<string, unknown>
  if (r.v !== 1 || (r.network !== 'mainnet' && r.network !== 'testnet')) return null
  if (typeof r.fullHeight !== 'number' || !Array.isArray(r.files)) return null
  const files: { path: string; size: number }[] = []
  const seen = new Set<string>()
  let total = 0
  for (const f of r.files as unknown[]) {
    const entry = f as Record<string, unknown> | null
    if (!entry || typeof entry.path !== 'string' || typeof entry.size !== 'number') return null
    if (!isChainFile(entry.path) || !Number.isInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) return null
    seen.add(entry.path)
    files.push({ path: entry.path, size: entry.size })
    total += entry.size
  }
  if (files.length === 0 || total !== r.totalBytes) return null
  return {
    v: 1,
    network: r.network,
    nodeVersion: typeof r.nodeVersion === 'string' ? r.nodeVersion : null,
    db: r.db === 'leveldb' || r.db === 'rocksdb' ? r.db : null,
    fullHeight: r.fullHeight,
    headersHeight: typeof r.headersHeight === 'number' ? r.headersHeight : null,
    totalBytes: total,
    files
  }
}

function gb(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GB`
}

function eta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  if (seconds < 60) return ', under a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `, about ${minutes} min left`
  return `, about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`
}

/** One line for the node card, or null when nothing is happening. */
export function chainCopyLabel(status: Pick<ChainCopyStatus, 'phase' | 'from' | 'bytesDone' | 'bytesTotal' | 'etaSeconds' | 'message'>): string | null {
  const from = status.from ?? 'a LAN launcher'
  switch (status.phase) {
    case 'stopping':
      return `Copying blockchain from ${from}: stopping the node here`
    case 'waiting-seed':
      return `Copying blockchain from ${from}: waiting for it to take a snapshot`
    case 'downloading':
      return status.bytesTotal
        ? `Copying blockchain from ${from} — ${gb(status.bytesDone)} of ${gb(status.bytesTotal)}${eta(status.etaSeconds)}`
        : `Copying blockchain from ${from} — ${gb(status.bytesDone)}`
    case 'verifying':
      return `Copying blockchain from ${from}: checking the copy`
    case 'swapping':
      return `Copying blockchain from ${from}: putting the new chain in place`
    case 'starting':
      return `Copying blockchain from ${from}: starting the node on the copied chain`
    case 'restoring':
      return 'The copy did not work. Putting the old chain back.'
    case 'done':
    case 'failed':
    case 'cancelled':
      return status.message
    default:
      return null
  }
}
