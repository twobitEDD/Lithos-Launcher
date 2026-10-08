import { execFile, spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, constants, readdir, readFile, realpath, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  listeningPortsFromNetstat,
  listeningPortsFromProcNet,
  pickBackend,
  stratumWorkFromStats,
  type GpuProbe,
  type StratumWork
} from '../shared/soatMiner.ts'
import type { MinerChild, MinerLaunch, ResolvedMiner } from './soatSupervisor.ts'

const EXE = process.platform === 'win32' ? '.exe' : ''
export const CUDA_BIN = `soat-miner${EXE}`
export const VULKAN_BIN = `soat-miner-vk${EXE}`
const MINER_NAMES = new Set(['soat-miner', 'soat-miner-vk', 'soat-miner.exe', 'soat-miner-vk.exe'])
/** The lithos-testnet stack's own SOAT loops and GUI, which restart their miner by themselves. */
const SUPERVISOR_RE = /^(?:soat-reconnect-.+\.sh|soat-launcher\.py)$/
/** Release folders as they unpack: soat-miner_v0.2.18_Lin64/. */
export const RELEASE_DIR_RE = /^soat-miner_v(.+)_(?:Lin64|Win64)$/
const LOG_ROTATE_BYTES = 50 * 2 ** 20

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 2 ** 20 }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

/**
 * Whether this machine has `port` in LISTEN state, from the kernel's socket table (Linux) or
 * netstat (Windows, macOS). Never connects: the Lithos Client counts every TCP connection to its
 * stratum port as a rig, which is how a connect-based probe showed "4 rigs connected".
 */
export async function isListeningLocal(port: number): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const text = await readFile(file, 'ascii').catch(() => '')
      if (listeningPortsFromProcNet(text).has(port)) return true
    }
    return false
  }
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP'])
    return out !== null && listeningPortsFromNetstat(out).has(port)
  }
  const out = await run('netstat', ['-an', '-p', 'tcp'])
  return out !== null && out.split('\n').some((l) => /LISTEN/.test(l) && new RegExp(`[.:]${port}\\s`).test(l))
}

/**
 * Whether the Lithos Client on this computer has a stratum job, from its panel's `/stats`.
 * Asks the panel, not the stratum port, so it is not counted as a rig.
 */
export async function lithosStratumWork(panelPort: number, timeoutMs = 3000): Promise<StratumWork> {
  try {
    const res = await fetch(`http://127.0.0.1:${panelPort}/stats`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return 'unknown'
    return stratumWorkFromStats(await res.json())
  } catch {
    return 'unknown'
  }
}

/** SOAT miners running on this computer that are not in `own` (any user's, any launcher's). */
export async function otherSoatMiners(own: ReadonlySet<number>): Promise<number[]> {
  const found: number[] = []
  if (process.platform === 'linux') {
    const entries = await readdir('/proc').catch(() => [] as string[])
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      if (own.has(pid) || pid === process.pid) continue
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')
      const argv = cmdline.split('\0').filter(Boolean)
      // The reconnect loops sit between miner runs for 2-5 s; seeing only the miner would let a
      // second one start in that gap.
      if (argv.some((a, i) => (i === 0 && MINER_NAMES.has(basename(a))) || SUPERVISOR_RE.test(basename(a)))) {
        found.push(pid)
      }
    }
    return found
  }
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FO', 'CSV', '/NH'])
    for (const line of out?.split('\n') ?? []) {
      const cols = line.split('","').map((c) => c.replace(/^"|"\s*$/g, ''))
      const pid = Number(cols[1])
      if (MINER_NAMES.has((cols[0] ?? '').toLowerCase()) && Number.isInteger(pid) && !own.has(pid)) found.push(pid)
    }
    return found
  }
  const out = await run('ps', ['-axo', 'pid=,comm='])
  for (const line of out?.split('\n') ?? []) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (m && MINER_NAMES.has(basename(m[2].trim())) && !own.has(Number(m[1]))) found.push(Number(m[1]))
  }
  return found
}

/** Parses `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(out: string): GpuProbe['nvidia'] {
  const line = out.split('\n').find((l) => l.trim())
  if (!line) return null
  const [name, mem, cap] = line.split(',').map((c) => c.trim())
  if (!name) return null
  const vram = Number(mem)
  const cc = Number(cap)
  return {
    name: /nvidia/i.test(name) ? name : `NVIDIA ${name}`,
    vramMb: Number.isFinite(vram) && vram > 0 ? vram : null,
    computeCap: cap !== undefined && Number.isFinite(cc) && cc > 0 ? cc : null
  }
}

async function probeNvidia(): Promise<GpuProbe['nvidia']> {
  const fields = '--format=csv,noheader,nounits'
  // compute_cap is a newer field; older drivers reject the whole query, so ask again without it.
  const out =
    (await run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', fields])) ??
    (await run('nvidia-smi', ['--query-gpu=name,memory.total', fields]))
  return out ? parseNvidiaSmi(out) : null
}

async function probeSysfs(): Promise<GpuProbe['other']> {
  if (process.platform !== 'linux') return null
  const cards = (await readdir('/sys/class/drm').catch(() => [] as string[])).filter((c) => /^card\d+$/.test(c))
  let intel: GpuProbe['other'] = null
  for (const card of cards) {
    const dev = `/sys/class/drm/${card}/device`
    const vendor = (await readFile(`${dev}/vendor`, 'ascii').catch(() => '')).trim()
    if (vendor === '0x1002') {
      const bytes = Number((await readFile(`${dev}/mem_info_vram_total`, 'ascii').catch(() => '')).trim())
      return { vendor: 'amd', vramMb: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 2 ** 20) : null }
    }
    if (vendor === '0x8086') intel ??= { vendor: 'intel', vramMb: null }
  }
  return intel
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (process.platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Version from a path like …/soat-miner_v0.2.18_Lin64/soat-miner, following symlinks. */
async function versionOf(binary: string): Promise<string | null> {
  const real = await realpath(binary).catch(() => binary)
  return RELEASE_DIR_RE.exec(basename(dirname(real)))?.[1] ?? null
}

/** Release folders under the launcher's miner folder, newest first. */
export async function launcherReleaseDirs(minerDir: string): Promise<string[]> {
  const entries = await readdir(minerDir).catch(() => [] as string[])
  const num = (v: string): number[] => v.split(/[.-]/).map((p) => Number(p) || 0)
  return entries
    .filter((e) => RELEASE_DIR_RE.test(e))
    .sort((a, b) => {
      const va = num(RELEASE_DIR_RE.exec(a)![1])
      const vb = num(RELEASE_DIR_RE.exec(b)![1])
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] ?? 0) - (va[i] ?? 0)
        if (d) return d
      }
      return 0
    })
    .map((e) => join(minerDir, e))
}

/**
 * Installs already on this computer: LITHOS_SOAT_DIR, the lithos-testnet stack layout, then PATH.
 * The launcher's own download is checked before any of these.
 */
export async function existingMinerDirs(): Promise<string[]> {
  const dirs: string[] = []
  if (process.env.LITHOS_SOAT_DIR) dirs.push(process.env.LITHOS_SOAT_DIR)
  const stack = join(homedir(), 'dev', 'lithos-testnet')
  dirs.push(join(stack, 'stack', 'bin'))
  dirs.push(...(await launcherReleaseDirs(join(stack, 'vendor', 'soat-miner'))))
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean))
  return dirs
}

/** The first folder holding a SOAT binary, with the backend picked for this computer's GPU. */
export async function resolveMiner(
  candidates: { dir: string; source: ResolvedMiner['source'] }[],
  probe: () => Promise<Pick<GpuProbe, 'nvidia' | 'other'>> = probeGpu
): Promise<ResolvedMiner | null> {
  for (const { dir, source } of candidates) {
    const cuda = join(dir, CUDA_BIN)
    const vulkan = join(dir, VULKAN_BIN)
    const hasCuda = await isExecutable(cuda)
    const hasVulkan = await isExecutable(vulkan)
    if (!hasCuda && !hasVulkan) continue
    const choice = pickBackend({ ...(await probe()), hasCuda, hasVulkan })
    if (!choice) continue
    const binary = choice.backend === 'cuda' ? cuda : vulkan
    return {
      binary,
      cwd: dir,
      backend: choice.backend,
      gpu: choice.gpu,
      vramMb: choice.vramMb,
      source,
      version: await versionOf(binary)
    }
  }
  return null
}

export async function probeGpu(): Promise<Pick<GpuProbe, 'nvidia' | 'other'>> {
  const [nvidia, other] = await Promise.all([probeNvidia(), probeSysfs()])
  return { nvidia, other }
}

/** Keeps one old log beside the current one once it passes 50 MB. */
export async function openMinerLog(file: string): Promise<WriteStream> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0
  )
  if (size > LOG_ROTATE_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
  return createWriteStream(file, { flags: 'a' })
}

/** Starts the miner with stdout and stderr split into lines, also appended to `log` when given. */
export function spawnMiner(
  launch: MinerLaunch,
  onLine: (line: string) => void,
  onExit: (code: number | null) => void,
  log: WriteStream | null
): MinerChild {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const attach = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    let carry = ''
    stream.on('data', (buf: Buffer) => {
      log?.write(buf)
      const parts = (carry + decoder.write(buf)).split(/\r?\n/)
      carry = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) onLine(line)
    })
    stream.on('end', () => {
      const rest = carry + decoder.end()
      if (rest.trim()) onLine(rest)
    })
  }
  attach(child.stdout)
  attach(child.stderr)
  let exited = false
  const finish = (code: number | null): void => {
    if (exited) return
    exited = true
    onExit(code)
  }
  child.once('error', (err) => {
    onLine(JSON.stringify({ event: 'error', msg: err.message }))
    if (child.pid === undefined) finish(null)
  })
  child.once('close', (code) => finish(code))
  return {
    get pid() {
      return child.pid ?? null
    },
    kill: (signal) => {
      child.kill(signal)
    }
  }
}
