// SOAT miner: types and pure helpers shared by the main process supervisor and the renderer.
// This file must stay free of Node and DOM imports.

/**
 * Command a rig runs to mine with SOAT into a Lithos stratum.
 * `--pool` is `host:port` (the dialog's stratum link without the `stratum+tcp://` prefix).
 * SOAT's `--lithos` flag does not take a wallet address.
 * The worker name is a label in the client log; payouts follow the committed difficulty.
 */
export function soatMinerCommand(poolHostPort: string, worker = '$(hostname -s)'): string {
  return `soat-miner --lithos --pool ${poolHostPort} --worker ${worker}`
}

/** soat-miner is the CUDA build, soat-miner-vk the Vulkan one (AMD, Intel, NVIDIA Blackwell). */
export type MinerBackend = 'cuda' | 'vulkan'

/**
 * `waiting`: wanted, but held back (stratum not listening yet, no work from the client yet, another
 * miner on this GPU, no binary).
 * `restarting`: exited or stalled, and starts again after a backoff.
 */
export type MinerStatus = 'stopped' | 'waiting' | 'starting' | 'running' | 'restarting' | 'stopping'

export interface StratumTarget {
  host: string
  port: number
}

/** The latest stats line SOAT prints every --interval seconds. */
export interface MinerSample {
  mhs: number
  mhsAvg: number | null
  accepted: number | null
  rejected: number | null
  tempC: number | null
  watts: number | null
  backend: string | null
}

export interface MinerState {
  status: MinerStatus
  detail: string | null
  /** Start by itself and keep running. Persisted in launcher.json; absent there means on. */
  autoStart: boolean
  target: StratumTarget | null
  /** The target is another launcher on the LAN, not this computer's own client. */
  remote: boolean
  worker: string
  backend: MinerBackend | null
  /** GPU the backend was picked for, e.g. "NVIDIA GeForce RTX 2070". */
  gpu: string | null
  /** Where the binary came from: the launcher's own download, or an install already on this machine. */
  source: 'launcher' | 'existing' | null
  version: string | null
  pid: number | null
  /** Unplanned restarts since the launcher started (crashes, stalls). Retargets are not counted. */
  restarts: number
  /** The last stats line, shortened for display. */
  lastHashLine: string | null
  sample: MinerSample | null
  lastSampleAt: number | null
  /** Newest last. */
  logTail: string[]
  /** Download progress while the miner is being installed. */
  install: { received: number; total: number } | null
}

export const INITIAL_MINER_STATE: MinerState = {
  status: 'stopped',
  detail: null,
  autoStart: true,
  target: null,
  remote: false,
  worker: '',
  backend: null,
  gpu: null,
  source: null,
  version: null,
  pid: null,
  restarts: 0,
  lastHashLine: null,
  sample: null,
  lastSampleAt: null,
  logTail: [],
  install: null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * SOAT's --plain output is one JSON object per line. Stats lines carry `rate`/`mhs`; events carry
 * `event` and `msg`. Returns the hashrate sample, or null for anything else.
 */
export function parseMinerSample(line: string): MinerSample | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let row: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    row = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const mhs = num(row.mhs) ?? num(row.rate) ?? num(row.hashrate)
  if (mhs === null) return null
  return {
    mhs,
    mhsAvg: num(row.mhs_avg) ?? num(row.rate_avg),
    accepted: num(row.accepted),
    rejected: num(row.rejected),
    tempC: num(row.temp_c),
    watts: num(row.watts),
    backend: typeof row.backend === 'string' ? row.backend : null
  }
}

/** A JSON event line as plain text (`error: no Lithos client is answering…`), or the line itself. */
export function minerLineText(line: string): string {
  const text = line.trim()
  if (!text.startsWith('{')) return text
  try {
    const row = JSON.parse(text) as Record<string, unknown>
    if (typeof row.msg === 'string') return typeof row.event === 'string' ? `${row.event}: ${row.msg}` : row.msg
  } catch {
    // not JSON after all
  }
  return text
}

export function sampleText(s: MinerSample): string {
  const parts = [`${s.mhs.toFixed(2)} MH/s`]
  if (s.mhsAvg !== null) parts.push(`avg ${s.mhsAvg.toFixed(2)}`)
  if (s.accepted !== null) parts.push(`${s.accepted} accepted${s.rejected ? ` / ${s.rejected} rejected` : ''}`)
  if (s.tempC !== null) parts.push(`${s.tempC}°C`)
  if (s.watts !== null) parts.push(`${Math.round(s.watts)} W`)
  return parts.join(' · ')
}

const HOST_PORT_RE = /^[A-Za-z0-9._-]+:[0-9]+$/

/** First line of miner-pool.txt as `host:port`, or null. Same rule as soat-reconnect-lithos-mainnet.sh. */
export function parsePoolLine(text: string): StratumTarget | null {
  const line = (text.split('\n')[0] ?? '').replace(/\s+/g, '')
  if (!HOST_PORT_RE.test(line)) return null
  const at = line.lastIndexOf(':')
  const port = Number(line.slice(at + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: line.slice(0, at), port }
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

export function sameTarget(a: StratumTarget | null, b: StratumTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.host === b.host && a.port === b.port)
}

export interface GpuProbe {
  /** `nvidia-smi` answered. Null when it is missing or the driver is not loaded. */
  nvidia: { name: string; computeCap: number | null; vramMb: number | null } | null
  /** A non-NVIDIA GPU seen in sysfs (AMD 0x1002, Intel 0x8086), with VRAM when amdgpu reports it. */
  other: { vendor: 'amd' | 'intel'; vramMb: number | null } | null
  hasCuda: boolean
  hasVulkan: boolean
}

export interface BackendChoice {
  backend: MinerBackend
  gpu: string
  vramMb: number | null
}

/**
 * soat-miner.sh's rule, per GPU architecture rather than vendor: NVIDIA before Blackwell gets CUDA
 * (34% faster on Ada), Blackwell (compute capability 12+) gets Vulkan (22% faster), and AMD/Intel get
 * Vulkan. Falls back to whichever binary exists.
 */
export function pickBackend(p: GpuProbe): BackendChoice | null {
  if (!p.hasCuda && !p.hasVulkan) return null
  if (p.nvidia) {
    const blackwell = p.nvidia.computeCap !== null && p.nvidia.computeCap >= 12
    const want: MinerBackend = blackwell ? 'vulkan' : 'cuda'
    const backend = want === 'cuda' ? (p.hasCuda ? 'cuda' : 'vulkan') : p.hasVulkan ? 'vulkan' : 'cuda'
    return { backend, gpu: p.nvidia.name, vramMb: p.nvidia.vramMb }
  }
  if (p.hasVulkan) {
    const gpu = p.other ? (p.other.vendor === 'amd' ? 'AMD GPU' : 'Intel GPU') : 'GPU (Vulkan)'
    return { backend: 'vulkan', gpu, vramMb: p.other?.vramMb ?? null }
  }
  return { backend: 'cuda', gpu: 'GPU (CUDA)', vramMb: null }
}

/** Cards at or under this keep the Autolykos dataset (~7.3 GB) plus a desktop on one card. */
const SMALL_VRAM_MB = 10 * 1024

/**
 * Arguments for Lithos mining. On 8 GB cards the CUDA build would OOM with a second (build-ahead)
 * dataset, so --cache-dag off and a half-size batch, as soat-reconnect-lithos-mainnet.sh runs it.
 */
export function minerArgs(opts: {
  target: StratumTarget
  worker: string
  backend: MinerBackend
  vramMb: number | null
}): string[] {
  const args = ['--lithos', '--pool', `${opts.target.host}:${opts.target.port}`, '--worker', opts.worker]
  args.push('--device', '0', '--interval', '5', '--mclk-offset', '0', '--plain')
  const small = opts.vramMb !== null && opts.vramMb <= SMALL_VRAM_MB
  if (small) args.push('--batch', '2097152')
  if (opts.backend === 'cuda') args.push('--cache-dag', small ? 'off' : 'auto')
  return args
}

/**
 * The bash loops waited 2 s after a run that hashed and 5 s after one that did not. Repeated
 * failures here back off further (5, 10, 20, 40, 60 s) so a dead pool is not hammered.
 */
export function restartDelayMs(failures: number, hashed: boolean): number {
  if (hashed) return 2000
  return Math.min(60_000, 5000 * 2 ** Math.max(0, failures - 1))
}

/**
 * After a run that ended with "sent no job", the client is up but its node has no mining candidate
 * yet (an Ergo node starts its candidate generator only after it applies a new block). Waits
 * 10, 20, 40, then 60 s.
 */
export function noWorkRetryMs(failures: number): number {
  return Math.min(60_000, 10_000 * 2 ** Math.max(0, failures - 1))
}

/** SOAT's exit message when the stratum accepted the connection but never sent mining.notify. */
export function isNoJobError(text: string | null): boolean {
  return text !== null && /sent no job/i.test(text)
}

/**
 * Whether a Lithos stratum has a job to hand out, from the panel's `GET /stats`:
 * `ready` when `local.stratum.activeJob` is set, `none` when the stratum says `waiting` with no job
 * (e.g. the node answers /mining/candidate with "Miner has not started yet"), `unknown` otherwise.
 */
export type StratumWork = 'ready' | 'none' | 'unknown'

export function stratumWorkFromStats(body: unknown): StratumWork {
  if (typeof body !== 'object' || body === null) return 'unknown'
  const local = (body as Record<string, unknown>).local
  if (typeof local !== 'object' || local === null) return 'unknown'
  const stratum = (local as Record<string, unknown>).stratum
  if (typeof stratum !== 'object' || stratum === null) return 'unknown'
  const s = stratum as Record<string, unknown>
  if (typeof s.activeJob === 'object' && s.activeJob !== null) return 'ready'
  if (s.status === 'active') return 'ready'
  if (s.status === 'waiting') return 'none'
  return 'unknown'
}

/** Port numbers in LISTEN state from /proc/net/tcp or tcp6. Reads the kernel table; never connects. */
export function listeningPortsFromProcNet(text: string): Set<number> {
  const ports = new Set<number>()
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4 || parts[3] !== '0A') continue
    const port = parseInt(parts[1].slice(parts[1].lastIndexOf(':') + 1), 16)
    if (Number.isInteger(port)) ports.add(port)
  }
  return ports
}

/** Ports in LISTENING state from Windows `netstat -ano -p TCP` output. */
export function listeningPortsFromNetstat(text: string): Set<number> {
  const ports = new Set<number>()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4 || parts[0] !== 'TCP' || !/^LISTEN/i.test(parts[3])) continue
    const port = Number(parts[1].slice(parts[1].lastIndexOf(':') + 1))
    if (Number.isInteger(port)) ports.add(port)
  }
  return ports
}
