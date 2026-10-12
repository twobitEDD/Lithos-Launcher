// SOAT miner: types and pure helpers shared by the main process supervisor and the renderer.
// This file must stay free of Node and DOM imports.
import { parseWorkWith, type LanLauncher, type WorkWith } from './workWith.ts'

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

/** Which SOAT binary to run. Auto is today's detect; CUDA / Vulkan force that build. */
export type MinerBackendPreference = 'auto' | MinerBackend

export const DEFAULT_BACKEND_PREFERENCE: MinerBackendPreference = 'auto'

export function parseMinerBackendPreference(value: unknown): MinerBackendPreference | null {
  return value === 'auto' || value === 'cuda' || value === 'vulkan' ? value : null
}

export function backendName(backend: MinerBackend): string {
  return backend === 'cuda' ? 'CUDA' : 'Vulkan'
}

export function preferenceName(preference: MinerBackendPreference): string {
  return preference === 'auto' ? 'Auto' : backendName(preference)
}

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

/** What the supervisor last saw while deciding whether this computer's Lithos stack can hand out work. */
export interface ReadinessChecks {
  /** Null while the node API does not answer. */
  node: { fullHeight: number | null; headersHeight: number | null; peers: number | null } | null
  /** headersHeight - fullHeight, or null while either is unknown. */
  gap: number | null
  panelUp: boolean
  stratumListening: boolean
  work: StratumWork
  checkedAt: number
}

/**
 * The background service that owns the miner, as the windows see it. The windows never run the
 * miner themselves; they read this and send Start/Stop to the service.
 */
export interface SoatServiceInfo {
  /** `systemd`: a systemd --user unit. `detached`: a background process with a lock file (no systemd, Windows, macOS). */
  mode: 'systemd' | 'detached' | 'none'
  installed: boolean
  /** The service answered on its control socket within the last poll. */
  reachable: boolean
  /** The old lithos-testnet stack (soat-launcher.py, soat-*.service, reconnect loops) is running or enabled. */
  legacy: LegacySoat | null
  /** Why installing, starting or reaching the service failed, if it did. */
  error: string | null
}

export interface LegacySoat {
  /** soat-*.service units that are active. */
  activeUnits: string[]
  /** soat-*.service units enabled at login. */
  enabledUnits: string[]
  /** soat-launcher.py windows. */
  launcherPids: number[]
  /** soat-reconnect-*.sh loops. */
  loopPids: number[]
}

export interface MinerState {
  status: MinerStatus
  detail: string | null
  /** Start by itself and keep running. Persisted in launcher.json; absent there means on. */
  autoStart: boolean
  target: StratumTarget | null
  /** The target is another launcher on the LAN, not this computer's own client. */
  remote: boolean
  /**
   * Mining through a LAN launcher while this computer's own node or Lithos Client can't hand out
   * work. Shares then go to that launcher's Lithos Client and wallet. Switches back by itself.
   */
  lanFallback: boolean
  /** Why this computer's own stack is not used right now (while `lanFallback`). */
  localWaiting: string | null
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
  /** Node, panel, stratum and job checks for a local target; null for a LAN target or before the first check. */
  checks: ReadinessChecks | null
  /** Filled in by the windows; the service itself leaves it null. */
  service: SoatServiceInfo | null
  /** The "Work with" choice. Absent from services older than 0.2.1-twobit.8. */
  workWith?: WorkWith
  /** LAN launchers the service knows, with live details and why each can't be used (null when it can). */
  lanLaunchers?: (LanLauncher & { skip: string | null })[]
  /** Whose Lithos Client gets the shares now: a LAN host, or null for this computer. */
  via?: string | null
  /** Why the miner is not doing what was picked, when it is not. */
  workNote?: string | null
  /** "Your wallet will scan once this node syncs…", while this computer's wallet is not ready. */
  walletWaiting?: string | null
  /** GPU backend picker. Absent from services older than 0.2.1-twobit.9; those always Auto-detect. */
  backendPreference?: MinerBackendPreference
  /** What Auto would pick on this computer (even while CUDA or Vulkan is forced). */
  autoBackend?: MinerBackend | null
  /** Why the chosen backend cannot start, or a warning (missing binary, no NVIDIA for CUDA). */
  backendNote?: string | null
  /**
   * Protocol the running SOAT service speaks. Absent before 0.2.1-twobit.11. The window upgrades
   * any reachable service that does not send this exact revision, including a .9/.10 that already
   * has backendPreference (those still used the old parser and `--device 0`).
   */
  serviceRevision?: number
  /** Vulkan GPUs from `soat-miner-vk --list-devices`. */
  vulkanDevices?: VulkanGpu[]
  /** Which Vulkan index to run, or undefined for “largest discrete”. */
  vulkanDevice?: number
}

export const INITIAL_MINER_STATE: MinerState = {
  status: 'stopped',
  detail: null,
  autoStart: true,
  target: null,
  remote: false,
  lanFallback: false,
  localWaiting: null,
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
  install: null,
  checks: null,
  service: null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A single Autolykos card never hashes this fast; 20–30k MH is nonce/batch math labeled as MH/s. */
export const PLAUSIBLE_MINER_MHS_MAX = 500

export function isPlausibleMinerMhs(mhs: number): boolean {
  return Number.isFinite(mhs) && mhs >= 0 && mhs < PLAUSIBLE_MINER_MHS_MAX
}

/** Drop a sample or lastHashLine the old service computed from batch/nonces (20971.52 MH/s, …). */
export function sanitizeMinerHashrate<T extends Pick<MinerState, 'sample' | 'lastHashLine'>>(state: T): T {
  const sample = state.sample
  const shown = state.lastHashLine ? /^(\d+(?:\.\d+)?)\s*MH/i.exec(state.lastHashLine) : null
  const fakeSample = sample !== null && !isPlausibleMinerMhs(sample.mhs)
  const fakeLine = shown !== null && !isPlausibleMinerMhs(Number(shown[1]))
  if (!fakeSample && !fakeLine) return state
  return { ...state, sample: fakeSample ? null : sample, lastHashLine: fakeSample || fakeLine ? null : state.lastHashLine }
}

/**
 * Same rule as lithos-testnet `soat-launcher.py` `read_hash_sample()` + `poll()`:
 * last JSON object that has `mhs` / `accepted` / `rate` / `hashrate`, then
 * `mhs = row.mhs or row.rate or row.hashrate`, shown as `{mhs} MH/s`.
 * Never `nonces` or `batch`. Never divide (2097152/100 is the 20k fake MH/s).
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
  // soat-launcher.py only keeps a line that has one of these keys.
  if (!('mhs' in row || 'accepted' in row || 'rate' in row || 'hashrate' in row)) return null
  // Events (`{"event":"ok","msg":"dataset ready"}`) are not stats even if they mention a rate.
  if (typeof row.event === 'string') return null
  const unit = typeof row.unit === 'string' ? row.unit : null
  if (unit && unit.toLowerCase() !== 'mh/s') return null
  // Prefer mhs, then rate, then hashrate — same order as soat-launcher.py poll().
  const mhs = num(row.mhs) ?? num(row.rate) ?? num(row.hashrate)
  if (mhs === null) return null
  const batch = num(row.batch)
  const nonces = num(row.nonces)
  // `nonces`/`batch` (2097152 on 8 GB) are not MH/s. soat-launcher.py never reads them.
  if ((batch !== null && mhs === batch) || (nonces !== null && mhs === nonces)) return null
  if (!isPlausibleMinerMhs(mhs)) return null
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

/**
 * miner-pool.txt: the first line is where this computer mines (its own stratum, or the launcher it
 * defers its node to). Later `lan host:port` lines are LAN launchers to mine through while this
 * computer's own stack has no work. Older services read only the first line.
 */
export interface PoolFile {
  primary: StratumTarget
  fallbacks: StratumTarget[]
  /**
   * `peer host:port` lines: every LAN stratum found, also while "mine through a LAN launcher" is
   * off, so the "Work with" picker can offer them. Services older than 0.2.1-twobit.8 skip these lines.
   */
  peers: StratumTarget[]
}

export function parsePoolFile(text: string): PoolFile | null {
  const primary = parsePoolLine(text)
  if (!primary) return null
  const fallbacks: StratumTarget[] = []
  const peers: StratumTarget[] = []
  for (const raw of text.split('\n').slice(1)) {
    const m = /^\s*(lan|peer)\s+(\S+)\s*$/.exec(raw)
    const target = m ? parsePoolLine(m[2]) : null
    if (!target || isLoopback(target.host)) continue
    const list = m![1] === 'lan' ? fallbacks : peers
    if (!list.some((f) => sameTarget(f, target))) list.push(target)
  }
  return { primary, fallbacks, peers }
}

export function formatPoolFile(primary: string, fallbacks: readonly StratumTarget[], peers: readonly StratumTarget[] = []): string {
  return [primary, ...fallbacks.map((f) => `lan ${f.host}:${f.port}`), ...peers.map((p) => `peer ${p.host}:${p.port}`)].join('\n') + '\n'
}

/** This computer's own stack can hand SOAT a job now: node synced enough, panel and stratum up, a current job. */
export function localStackReady(c: Omit<ReadinessChecks, 'checkedAt'> | null): boolean {
  return c !== null && notReadyReason(c) === null && c.work === 'ready'
}

export const NO_LOCAL_WORK_TEXT = "This computer's Lithos Client has no mining job yet."

/** Mining locally and the local stack stops reporting a job: wait this long before moving to a LAN launcher. */
export const LOCAL_GRACE_MS = 60_000

/**
 * Where to mine when the first line of miner-pool.txt is this computer's own stratum. The local
 * stratum only once its client has a current job; until then a LAN launcher that has work, keeping
 * the one already mined through so the miner is not bounced between launchers.
 */
export function chooseMiningTarget(input: {
  primary: StratumTarget
  fallbacks: readonly StratumTarget[]
  localReady: boolean
  /** How long the local stack has not been ready (0 when it is). */
  localDownForMs: number
  /** What the miner is connected to now, or null when it is not running. */
  current: StratumTarget | null
}): { target: StratumTarget; lanFallback: boolean } {
  const { primary, fallbacks, current } = input
  if (input.localReady || !fallbacks.length) return { target: primary, lanFallback: false }
  if (current && sameTarget(current, primary) && input.localDownForMs < LOCAL_GRACE_MS) {
    return { target: primary, lanFallback: false }
  }
  const keep = current ? fallbacks.find((f) => sameTarget(f, current)) : undefined
  return { target: keep ?? fallbacks[0], lanFallback: true }
}

/** The miner card's line while mining through another launcher. */
export function lanFallbackText(target: StratumTarget): string {
  return (
    `Mining through ${target.host} while this computer's node and Lithos Client are not ready. ` +
    `Shares go to the Lithos Client on ${target.host} and are paid to that launcher's wallet, not this computer's. ` +
    'The miner moves back to this computer once its own client has a job.'
  )
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

export const CUDA_NO_BINARY = 'CUDA is selected, but soat-miner (the CUDA build) is not installed.'
export const CUDA_NO_NVIDIA =
  'CUDA is selected, but no NVIDIA GPU was found (nvidia-smi did not answer). The miner will stay waiting rather than crash-loop.'
export const VULKAN_NO_BINARY = 'Vulkan is selected, but soat-miner-vk is not installed.'
export const VULKAN_NO_GPU =
  'Vulkan is selected, but no GPU was detected. The miner will stay waiting rather than crash-loop.'

export interface BackendDecision {
  /** Binary to run. Null when Auto found nothing, or a forced backend cannot start. */
  choice: BackendChoice | null
  /** What Auto would pick with the same probe (binaries + GPU). */
  auto: BackendChoice | null
  /** Why a forced backend must not start. Null for Auto. */
  blocked: string | null
}

/**
 * Auto uses `pickBackend`. Forced CUDA needs the CUDA binary and nvidia-smi; forced Vulkan needs
 * soat-miner-vk and a detected GPU. Missing those stay Waiting instead of starting a binary that
 * would exit immediately.
 */
export function pickBackendFor(p: GpuProbe, preference: MinerBackendPreference = 'auto'): BackendDecision {
  const auto = pickBackend(p)
  if (preference === 'auto') return { choice: auto, auto, blocked: null }
  if (preference === 'cuda') {
    if (!p.hasCuda) return { choice: null, auto, blocked: CUDA_NO_BINARY }
    if (!p.nvidia) return { choice: null, auto, blocked: CUDA_NO_NVIDIA }
    return { choice: { backend: 'cuda', gpu: p.nvidia.name, vramMb: p.nvidia.vramMb }, auto, blocked: null }
  }
  if (!p.hasVulkan) return { choice: null, auto, blocked: VULKAN_NO_BINARY }
  if (!p.nvidia && !p.other) return { choice: null, auto, blocked: VULKAN_NO_GPU }
  const gpu = p.nvidia?.name ?? (p.other!.vendor === 'amd' ? 'AMD GPU' : 'Intel GPU')
  const vramMb = p.nvidia?.vramMb ?? p.other?.vramMb ?? null
  return { choice: { backend: 'vulkan', gpu, vramMb }, auto, blocked: null }
}

/** One line under the GPU backend picker: detected card and what Auto would run. */
export function gpuBackendHint(opts: {
  preference: MinerBackendPreference
  gpu: string | null
  autoBackend: MinerBackend | null
}): string {
  const card = opts.gpu ?? 'No GPU detected yet'
  if (!opts.autoBackend) return `Detected: ${card}`
  const verb = opts.preference === 'auto' ? 'uses' : 'would use'
  return `Detected: ${card} — Auto ${verb} ${backendName(opts.autoBackend)}`
}

/** Cards at or under this keep the Autolykos dataset (~7.3 GB) plus a desktop on one card. */
const SMALL_VRAM_MB = 10 * 1024

/**
 * Arguments for Lithos mining. Matches soat-miner.sh / soat-reconnect-lithos-mainnet.sh:
 * no --device (SOAT picks the largest-VRAM GPU; --device 0 is often the Intel iGPU next to an
 * RX 570), --plain for JSON stats, --cache-dag CUDA-only. On 8 GB cards the CUDA build would OOM
 * with a second (build-ahead) dataset, so --cache-dag off and a half-size batch.
 */
export function minerArgs(opts: {
  target: StratumTarget
  worker: string
  backend: MinerBackend
  vramMb: number | null
  /** Vulkan index from --list-devices. Omit to let SOAT pick largest VRAM; never default to 0. */
  device?: number | null
}): string[] {
  const args = ['--lithos', '--pool', `${opts.target.host}:${opts.target.port}`, '--worker', opts.worker]
  args.push('--interval', '5', '--mclk-offset', '0', '--plain')
  if (opts.backend === 'vulkan' && opts.device !== undefined && opts.device !== null) {
    args.push('--device', String(opts.device))
  }
  const small = opts.vramMb !== null && opts.vramMb <= SMALL_VRAM_MB
  if (small) args.push('--batch', '2097152')
  if (opts.backend === 'cuda') args.push('--cache-dag', small ? 'off' : 'auto')
  return args
}

export interface VulkanGpu {
  index: number | null
  name: string
  vramGb: number
  maxBufferGb: number | null
  note: string
  skipped: string | null
}

/** `soat-miner-vk --list-devices`: `  [0] Name  8.0 GB  max buffer  4.3 GB  (discrete GPU)` */
export function parseVulkanDeviceList(text: string): VulkanGpu[] {
  const out: VulkanGpu[] = []
  for (const line of text.split('\n')) {
    const usable =
      /^\s*\[(\d+)\]\s+(.+?)\s+(\d+(?:\.\d+)?)\s*GB\s+max buffer\s+(\d+(?:\.\d+)?)\s*GB\s+\((.+)\)\s*$/.exec(line)
    if (usable) {
      out.push({
        index: Number(usable[1]),
        name: usable[2].trim(),
        vramGb: Number(usable[3]),
        maxBufferGb: Number(usable[4]),
        note: usable[5].trim(),
        skipped: null
      })
      continue
    }
    const skip = /^\s*-\s+(.+?)\s+(\d+(?:\.\d+)?)\s*GB\s+\(skipped:\s*(.+)\)\s*$/.exec(line)
    if (skip) {
      out.push({
        index: null,
        name: skip[1].trim(),
        vramGb: Number(skip[2]),
        maxBufferGb: null,
        note: skip[3].trim(),
        skipped: skip[3].trim()
      })
    }
  }
  return out
}

const IGPU_RE = /intel|llvmpipe|lavapipe|swiftshader|uhd graphics|hd graphics/i

/** Largest discrete GPU. Never index 0 just because it is first (that is often the Intel iGPU). */
export function pickVulkanDevice(devices: readonly VulkanGpu[], preferIndex?: number | null): VulkanGpu | null {
  const usable = devices.filter((d): d is VulkanGpu & { index: number } => d.index !== null && d.skipped === null)
  if (!usable.length) return null
  if (preferIndex !== undefined && preferIndex !== null) {
    const hit = usable.find((d) => d.index === preferIndex)
    if (hit) return hit
  }
  const discrete = usable.filter((d) => /discrete/i.test(d.note) && !IGPU_RE.test(d.name))
  const pool = discrete.length ? discrete : usable.filter((d) => !IGPU_RE.test(d.name))
  return (pool.length ? pool : usable).slice().sort((a, b) => (b.maxBufferGb ?? b.vramGb) - (a.maxBufferGb ?? a.vramGb))[0]
}

/** Autolykos dataset is ~7.27 GB; cards whose max buffer is below that cannot start soat-miner-vk. */
export const AUTOLYKOS_DATASET_GB = 7.2

export function vulkanDeviceBlocked(d: VulkanGpu): string | null {
  const buf = d.maxBufferGb ?? d.vramGb
  if (buf + 0.05 < AUTOLYKOS_DATASET_GB) {
    return (
      `${d.name} cannot hold the Autolykos dataset (~7.3 GB). Vulkan reports a max buffer of ${buf.toFixed(1)} GB` +
      ` (RX 570-class cards are often ~4.3 GB / a small BAR). Mining on Vulkan will not start on this GPU.`
    )
  }
  return null
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
 * GPU / Vulkan failures that will happen again on the next launch (dataset bigger than the card,
 * missing ICD, BAR too small). The supervisor should show the text and back off, not spin.
 */
export function isFatalMinerError(text: string | null): boolean {
  if (!text) return false
  return /VK_ERROR|out of memory|failed to allocate|cannot allocate|no ICD|ICD not found|buffer too large|max buffer|incomplete Vulkan|BAR (size|too small)|dataset.*(fail|error|alloc)|vulkan.*(fail|error|init)/i.test(
    text
  )
}

/** The human line from a miner log, when it is an error the supervisor should keep. */
export function minerErrorText(line: string): string | null {
  const text = minerLineText(line)
  if (!text) return null
  if (text.startsWith('error:')) return text.slice('error:'.length).trim()
  if (/^error[:\s]/i.test(text)) return text.replace(/^error[:\s]+/i, '').trim()
  if (isFatalMinerError(text)) return text
  return null
}

/**
 * A reachable service that does not send `serviceRevision` (everything before 0.2.1-twobit.11),
 * or sends an older one, must be replaced with this launcher's binary. .9/.10 already send
 * backendPreference, so that field alone must not skip the upgrade. Leave soat-launcher.py alone.
 */
export type ServiceUpgradePlan = 'none' | 'upgrade' | 'leave-legacy'

/** Bump when the running supervisor must be replaced (parser, Vulkan device pick, …). */
export const SOAT_SERVICE_REVISION = 11

export function planServiceUpgrade(opts: {
  legacyRunning: boolean
  reachable: boolean
  backendPreference?: MinerBackendPreference
  serviceRevision?: number
}): ServiceUpgradePlan {
  if (opts.legacyRunning) return 'leave-legacy'
  if (!opts.reachable) return 'none'
  if (opts.serviceRevision !== SOAT_SERVICE_REVISION) return 'upgrade'
  return 'none'
}

export const UPDATING_SERVICE = 'Updating the miner service…'

export function isUnrecoverableGpuError(text: string | null): boolean {
  if (!text) return false
  return /dataset|max buffer|buffer too large|BAR|OUT_OF_DEVICE_MEMORY|cannot hold the Autolykos/i.test(text)
}

export function explainMinerFailure(text: string | null): string | null {
  if (!text) return null
  if (isUnrecoverableGpuError(text) && /dataset|buffer|BAR|memory/i.test(text)) {
    return (
      'This GPU cannot hold the Autolykos dataset (~7.3 GB). RX 570-class cards often fail here ' +
      '(Vulkan max buffer ~4.3 GB / a small BAR). Vulkan will not start on this card.'
    )
  }
  if (/no ICD|ICD not found|no usable Vulkan|no Vulkan GPU/i.test(text)) {
    return 'Vulkan cannot see a GPU. Install the vendor driver (Mesa RADV or AMDVLK on AMD), then try again.'
  }
  if (isFatalMinerError(text)) return text
  return null
}

/**
 * Whether a Lithos stratum has a job to hand out, from the panel's `GET /stats`:
 * `ready` when `local.stratum.activeJob` is set, `none` when the stratum says `waiting` with no job
 * (e.g. the node answers /mining/candidate with "Miner has not started yet"), `unknown` otherwise.
 */
export type StratumWork = 'ready' | 'none' | 'unknown'

export function stratumWorkFromStats(body: unknown, nodeFullHeight: number | null = null): StratumWork {
  if (typeof body !== 'object' || body === null) return 'unknown'
  const local = (body as Record<string, unknown>).local
  if (typeof local !== 'object' || local === null) return 'unknown'
  const stratum = (local as Record<string, unknown>).stratum
  if (typeof stratum !== 'object' || stratum === null) return 'unknown'
  const s = stratum as Record<string, unknown>
  if (typeof s.activeJob === 'object' && s.activeJob !== null) {
    // A job for a block the node is already past is left over from before a restart; SOAT gets nothing new.
    const height = Number((s.activeJob as Record<string, unknown>).height)
    if (nodeFullHeight !== null && Number.isFinite(height) && height > 0 && height < nodeFullHeight) return 'none'
    return 'ready'
  }
  // Clients that report activeJob send null while the node has no mining candidate, even with status "active".
  if ('activeJob' in s) return 'none'
  if (s.status === 'active') return 'ready'
  if (s.status === 'waiting') return 'none'
  return 'unknown'
}

/** soat-launcher.py's limit: the Lithos client keeps 16384 headers, so it can't follow a node further behind. */
export const GAP_MAX = 16000

/** `/info` from the Ergo node, or null when it is not an object. */
export function nodeInfoFrom(body: unknown): ReadinessChecks['node'] {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  return { fullHeight: num(b.fullHeight), headersHeight: num(b.headersHeight), peers: num(b.peersCount) }
}

export function gapOf(node: ReadinessChecks['node']): number | null {
  if (!node || node.fullHeight === null || node.headersHeight === null) return null
  return Math.max(node.headersHeight - node.fullHeight, 0)
}

/**
 * Why a local Lithos stack can't hand SOAT a job yet, or null when it can (or might: `work` unknown).
 * Same order as soat-launcher.py (node, gap, stratum), plus the panel and the client actually having
 * a job: the stratum accepts connections minutes before the node has a mining candidate after a
 * restart, and SOAT then quits with "sent no job in 20s".
 */
export function notReadyReason(c: Omit<ReadinessChecks, 'checkedAt'>): string | null {
  if (!c.node) return 'Waiting for the Ergo node API to answer (start the node in Lithos Launcher).'
  if (c.node.fullHeight === null) {
    return 'Waiting for the node to download blocks: headers are in, fullHeight is not ready yet.'
  }
  if (c.gap !== null && c.gap > GAP_MAX) {
    return `Waiting for the node to sync: ${c.gap.toLocaleString('en-US')} blocks behind (the Lithos Client needs ${GAP_MAX.toLocaleString('en-US')} or fewer).`
  }
  if (!c.panelUp) return 'Waiting for the Lithos Client panel to answer (start the Lithos Client).'
  if (!c.stratumListening) return 'Waiting for the Lithos Client stratum to open.'
  return null
}

/** Which of the old lithos-testnet SOAT pieces this process list and these unit states show. */
export const LEGACY_UNITS = ['soat-lithos-mainnet.service', 'soat-ergo-mainnet-pool.service', 'soat-lithos-testnet.service']
const LEGACY_LAUNCHER_RE = /(?:^|\/)soat-launcher\.py$/
const LEGACY_LOOP_RE = /(?:^|\/)soat-reconnect-[^/]+\.sh$/
const INTERPRETER_RE = /(?:^|\/)(?:python3?(?:\.\d+)?|bash|sh|dash)$/

export function legacyFromScan(scan: {
  procs: { pid: number; argv: string[] }[]
  units: { name: string; active: boolean; enabled: boolean }[]
}): LegacySoat | null {
  const launcherPids: number[] = []
  const loopPids: number[] = []
  for (const p of scan.procs) {
    // python3 soat-launcher.py, bash soat-reconnect-….sh, or either run directly; not `grep soat-launcher.py`.
    const script = INTERPRETER_RE.test(p.argv[0] ?? '') ? p.argv.slice(1).find((a) => !a.startsWith('-')) : p.argv[0]
    if (!script || !(LEGACY_LAUNCHER_RE.test(script) || LEGACY_LOOP_RE.test(script))) continue
    if (LEGACY_LAUNCHER_RE.test(script)) launcherPids.push(p.pid)
    else loopPids.push(p.pid)
  }
  const legacyUnits = scan.units.filter((u) => LEGACY_UNITS.includes(u.name))
  const activeUnits = legacyUnits.filter((u) => u.active).map((u) => u.name)
  const enabledUnits = legacyUnits.filter((u) => u.enabled).map((u) => u.name)
  if (!launcherPids.length && !loopPids.length && !activeUnits.length && !enabledUnits.length) return null
  return { activeUnits, enabledUnits, launcherPids, loopPids }
}

/** Running now (not just enabled for next login): then the Lithos service must not start a miner. */
export function legacyRunning(l: LegacySoat | null): boolean {
  return l !== null && (l.activeUnits.length > 0 || l.launcherPids.length > 0 || l.loopPids.length > 0)
}

/** One JSON line from a window to the service's control socket. */
export type SoatRequest =
  | { cmd: 'status' }
  | { cmd: 'start' }
  | { cmd: 'stop' }
  | { cmd: 'setAutoStart'; on: boolean }
  | { cmd: 'configure'; network: 'mainnet' | 'testnet' }
  | { cmd: 'setWorkWith'; workWith: WorkWith }
  | { cmd: 'setMinerBackend'; backend: MinerBackendPreference }
  | { cmd: 'setVulkanDevice'; device: number | null }

export type SoatResponse = { ok: true; state: MinerState } | { ok: false; error: string }

/** Validates a request line; anything else is rejected, so the socket can't be used to run other commands. */
export function parseSoatRequest(line: string): SoatRequest | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  switch (r.cmd) {
    case 'status':
    case 'start':
    case 'stop':
      return { cmd: r.cmd }
    case 'setAutoStart':
      return typeof r.on === 'boolean' ? { cmd: 'setAutoStart', on: r.on } : null
    case 'configure':
      return r.network === 'mainnet' || r.network === 'testnet' ? { cmd: 'configure', network: r.network } : null
    case 'setWorkWith': {
      const workWith = parseWorkWith(r.workWith)
      return workWith ? { cmd: 'setWorkWith', workWith } : null
    }
    case 'setMinerBackend': {
      const backend = parseMinerBackendPreference(r.backend)
      return backend ? { cmd: 'setMinerBackend', backend } : null
    }
    case 'setVulkanDevice':
      return r.device === null || (typeof r.device === 'number' && Number.isInteger(r.device) && r.device >= 0)
        ? { cmd: 'setVulkanDevice', device: r.device as number | null }
        : null
    default:
      return null
  }
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
