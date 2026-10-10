// How the SOAT service and its windows find each other: one lock file so only one service owns the
// miner, a control socket for Start/Stop/status, and a status file for when the service is down.
// No Electron imports, so the tests run it directly.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { parseSoatRequest, type MinerState, type SoatRequest, type SoatResponse } from '../shared/soatMiner.ts'
import { isLanHost, parseWorkWith, type WalletScanInfo, type WorkWith } from '../shared/workWith.ts'

export interface SoatPaths {
  /** `<root>/miner`: binaries, log, status and service settings. */
  dir: string
  status: string
  config: string
  log: string
  lock: string
  socket: string
  /** Written by Lithos Launcher, read by the service. */
  launcherState: string
}

/**
 * Lock and socket live in XDG_RUNTIME_DIR (per user, cleared at logout) when there is one, else
 * in the miner folder. On Windows the socket is a named pipe.
 */
export function soatPaths(root: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): SoatPaths {
  const dir = join(root, 'miner')
  const runtime = env.LITHOS_SOAT_RUNTIME_DIR || (platform === 'win32' ? dir : env.XDG_RUNTIME_DIR || dir)
  const socket =
    platform === 'win32'
      ? `\\\\.\\pipe\\lithos-soat-${safeName(env.USERNAME || userInfo().username)}`
      : join(runtime, 'lithos-soat.sock')
  return {
    dir,
    status: join(dir, 'status.json'),
    config: join(dir, 'soat-service.json'),
    log: join(dir, 'soat-miner.log'),
    lock: join(runtime, 'lithos-soat.lock'),
    socket,
    launcherState: join(dir, 'launcher-state.json')
  }
}

/**
 * What Lithos Launcher tells the SOAT service besides miner-pool.txt: this computer's wallet scan
 * and the LAN launchers its chain-seed scan found. Hosts and heights only, never keys or addresses.
 */
export interface LauncherHandoff {
  writtenAt: number
  network: 'mainnet' | 'testnet' | null
  walletScan: WalletScanInfo | null
  /** LAN hosts that answered on the chain seed port; their adverts carry the stratum port. */
  hosts: string[]
}

/** The launcher writes the file at least this often while it runs; older than this, it is ignored. */
export const HANDOFF_STALE_MS = 3 * 60_000

export async function writeLauncherHandoff(file: string, state: Omit<LauncherHandoff, 'writtenAt'>, now = Date.now()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ ...state, writtenAt: now }))
  await rename(tmp, file)
}

const SCAN_STATES = new Set(['none', 'locked', 'waiting-node', 'scanning', 'done', 'unknown'])

/** The launcher's last hand-off, or null when there is none, it is malformed, or it is stale. */
export async function readLauncherHandoff(file: string, now = Date.now()): Promise<LauncherHandoff | null> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (typeof v.writtenAt !== 'number' || now - v.writtenAt > HANDOFF_STALE_MS) return null
    const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
    const scan = v.walletScan as Record<string, unknown> | null
    const walletScan: WalletScanInfo | null =
      scan && typeof scan === 'object' && SCAN_STATES.has(scan.state as string)
        ? { state: scan.state as WalletScanInfo['state'], height: n(scan.height), tip: n(scan.tip) }
        : null
    return {
      writtenAt: v.writtenAt,
      network: v.network === 'mainnet' || v.network === 'testnet' ? v.network : null,
      walletScan,
      hosts: Array.isArray(v.hosts) ? [...new Set(v.hosts.filter(isLanHost))].slice(0, 64) : []
    }
  } catch {
    return null
  }
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_')

export interface Lock {
  release(): void
}

/** Only a definite "no such process" counts as dead, so a lock is never taken from a live holder. */
const pidAlive = (pid: number): boolean => {
  if (process.platform === 'linux') return existsSync(`/proc/${pid}`)
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Takes the lock file, or returns null when a live process holds it. A lock left by a process
 * that is gone (crash, kill -9, reboot without tmpfs) is taken over.
 */
export function acquireLock(file: string, isAlive: (pid: number) => boolean = pidAlive): Lock | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return {
        release: () => {
          try {
            if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file)
          } catch {
            // already gone
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let holder = NaN
    try {
      holder = Number(readFileSync(file, 'utf8').trim())
    } catch {
      // vanished between open and read: try again
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) return null
    try {
      unlinkSync(file)
    } catch {
      // someone else cleaned it up first
    }
  }
  return null
}

/** The pid in the lock file when that process is alive, else null. */
export function lockHolder(file: string, isAlive: (pid: number) => boolean = pidAlive): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
  } catch {
    return null
  }
}

const MAX_LINE = 4096

/**
 * Serves one JSON request per line on `socket`. A stale socket file (the last service died) is
 * replaced; a live one means another service is running, and this rejects.
 */
export async function serveControl(
  socket: string,
  handle: (req: SoatRequest) => Promise<MinerState> | MinerState
): Promise<Server> {
  const server = createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.setTimeout(10_000, () => conn.destroy())
    conn.on('error', () => undefined)
    conn.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_LINE) {
        conn.destroy()
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const req = parseSoatRequest(line)
        const reply = (r: SoatResponse): void => {
          if (!conn.destroyed) conn.write(`${JSON.stringify(r)}\n`)
        }
        if (!req) {
          reply({ ok: false, error: 'Unknown request' })
          continue
        }
        Promise.resolve()
          .then(() => handle(req))
          .then(
            (state) => reply({ ok: true, state }),
            (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
          )
      }
    })
  })
  if (process.platform !== 'win32') await mkdir(dirname(socket), { recursive: true })
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.platform === 'win32') throw err
    if (await socketAnswers(socket)) throw new Error('Another SOAT service is already running')
    try {
      unlinkSync(socket)
    } catch {
      // gone already
    }
    await listen()
  }
  return server
}

function socketAnswers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(socket)
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
}

/** Sends one request to the service and waits for its answer. Rejects when nothing listens. */
export function requestControl(socket: string, req: SoatRequest, timeoutMs = 3000): Promise<MinerState> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socket)
    let buf = ''
    const timer = setTimeout(() => {
      c.destroy()
      reject(new Error('The SOAT service did not answer'))
    }, timeoutMs)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      c.destroy()
      fn()
    }
    c.setEncoding('utf8')
    c.once('connect', () => c.write(`${JSON.stringify(req)}\n`))
    c.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let res: SoatResponse
      try {
        res = JSON.parse(buf.slice(0, nl)) as SoatResponse
      } catch {
        done(() => reject(new Error('The SOAT service sent an unreadable answer')))
        return
      }
      done(() => (res.ok ? resolve(res.state) : reject(new Error(res.error))))
    })
    c.once('error', (err) => done(() => reject(err)))
  })
}

/** Written by the service; replaced atomically so a reader never sees half a file. */
export async function writeStatusFile(file: string, state: MinerState): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ ...state, writtenAt: Date.now() }))
  await rename(tmp, file)
}

export async function readStatusFile(file: string): Promise<(MinerState & { writtenAt: number }) | null> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof v !== 'object' || v === null || typeof (v as { status?: unknown }).status !== 'string') return null
    return v as MinerState & { writtenAt: number }
  } catch {
    return null
  }
}

/** The service's own settings, in `<root>/miner/soat-service.json`. */
export interface SoatServiceConfig {
  /** Start mining once the node and client are ready, and keep it running. */
  autoStart: boolean
  /** Stop was the last button pressed: stay stopped across restarts until Start or auto-start on. */
  userStopped: boolean
  network: 'mainnet' | 'testnet'
  /** The "Work with" choice; absent means Automatic. */
  workWith?: WorkWith
}

export const DEFAULT_SERVICE_CONFIG: SoatServiceConfig = { autoStart: true, userStopped: false, network: 'mainnet' }

export async function readServiceConfig(file: string): Promise<SoatServiceConfig> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as Partial<SoatServiceConfig>
    const config: SoatServiceConfig = {
      autoStart: typeof v.autoStart === 'boolean' ? v.autoStart : DEFAULT_SERVICE_CONFIG.autoStart,
      userStopped: typeof v.userStopped === 'boolean' ? v.userStopped : DEFAULT_SERVICE_CONFIG.userStopped,
      network: v.network === 'testnet' ? 'testnet' : 'mainnet'
    }
    const workWith = parseWorkWith(v.workWith)
    if (workWith) config.workWith = workWith
    return config
  } catch {
    return { ...DEFAULT_SERVICE_CONFIG }
  }
}

export async function writeServiceConfig(file: string, config: SoatServiceConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
  await rename(tmp, file)
}
