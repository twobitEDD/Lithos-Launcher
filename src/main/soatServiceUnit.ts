// Installing and controlling the background SOAT service from outside it: the systemd --user unit,
// the "SOAT Miner" desktop entry, the detached fallback, and the old lithos-testnet SOAT stack.
// No Electron imports, so the tests run it directly.
import { execFile, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_UNITS, legacyFromScan, type LegacySoat } from '../shared/soatMiner.ts'

export const SERVICE_UNIT = 'lithos-soat.service'
export const DESKTOP_FILE = 'lithos-soat-miner.desktop'

export const userUnitDir = (home = homedir()): string => join(home, '.config', 'systemd', 'user')
export const applicationsDir = (home = homedir()): string => join(home, '.local', 'share', 'applications')

/** One ExecStart word: quoted when it has spaces or quotes, with systemd's % and $ specifiers escaped. */
export function systemdWord(arg: string): string {
  const escaped = arg.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return /[\s"'\\;]/.test(escaped) ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : escaped
}

/**
 * The unit that owns the miner. Restart=always keeps the service (not the miner: the service
 * restarts that itself) alive. Conflicts= with the old soat-*.service units means systemd never runs
 * both: starting one stops the other.
 */
export function serviceUnitText(exec: string[]): string {
  return [
    '# Written by Lithos Launcher. It is rewritten when the launcher updates, so edit the launcher instead.',
    '[Unit]',
    'Description=Lithos SOAT miner (waits for the node and Lithos Client, keeps soat-miner running)',
    'After=network-online.target',
    'Wants=network-online.target',
    `Conflicts=${LEGACY_UNITS.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec.map(systemdWord).join(' ')}`,
    'Restart=always',
    'RestartSec=5',
    'KillMode=control-group',
    'TimeoutStopSec=20',
    'Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

/** One Exec= word in a .desktop file (Desktop Entry spec quoting, % doubled). */
export function desktopWord(arg: string): string {
  const escaped = arg.replace(/%/g, '%%')
  return /[\s"'\\`$<>~|&;*?#()]/.test(escaped) ? `"${escaped.replace(/(["`$\\])/g, '\\$1')}"` : escaped
}

export function desktopEntryText(exec: string[], icon: string): string {
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=SOAT Miner',
    'GenericName=Lithos SOAT miner',
    'Comment=Status, hashrate and Start/Stop for the background SOAT miner. Closing this window does not stop mining.',
    `Exec=${exec.map(desktopWord).join(' ')}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;',
    'StartupWMClass=SOAT Miner',
    ''
  ].join('\n')
}

function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid()}`
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${env.XDG_RUNTIME_DIR}/bus`
  }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}`.trim() })
    })
  })
}

export const systemctlUser = (...args: string[]): Promise<{ code: number; out: string }> =>
  run('systemctl', ['--user', ...args])

/** Whether a systemd user manager answers (not in containers, WSL without systemd, or other init systems). */
export async function systemdUserAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  return (await systemctlUser('show-environment')).code === 0
}

export async function unitState(name: string): Promise<{ name: string; active: boolean; enabled: boolean }> {
  const [active, enabled] = await Promise.all([systemctlUser('is-active', name), systemctlUser('is-enabled', name)])
  return { name, active: active.out.split('\n')[0] === 'active', enabled: enabled.out.split('\n')[0] === 'enabled' }
}

export interface ProcInfo {
  pid: number
  ppid: number
  argv: string[]
}

/** Every process's argv and parent, from /proc. Empty off Linux. */
export async function scanProcs(): Promise<ProcInfo[]> {
  if (process.platform !== 'linux') return []
  const out: ProcInfo[] = []
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue
    const [cmdline, stat] = await Promise.all([
      readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => ''),
      readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '')
    ])
    const argv = cmdline.split('\0').filter(Boolean)
    if (!argv.length) continue
    // Fields after the parenthesised command name: state, ppid, …
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    out.push({ pid: Number(entry), ppid: Number.isInteger(ppid) ? ppid : 0, argv })
  }
  return out
}

/** The old stack on this computer, or null. Never stops anything. */
export async function detectLegacy(): Promise<LegacySoat | null> {
  if (process.platform !== 'linux') return null
  const units = (await systemdUserAvailable()) ? await Promise.all(LEGACY_UNITS.map(unitState)) : []
  return legacyFromScan({ procs: await scanProcs(), units })
}

const MINER_RE = /(?:^|\/)soat-miner(?:-vk)?$/

/**
 * The "Switch to Lithos service" button: stops and disables the old soat-*.service units, closes
 * soat-launcher.py (it would start its unit again within 4 s), and ends reconnect loops that run
 * outside systemd together with their miners. Only runs when the user asks.
 */
export async function stopLegacy(legacy: LegacySoat, log: (line: string) => void): Promise<void> {
  for (const pid of legacy.launcherPids) signal(pid, 'SIGTERM', log, 'soat-launcher.py')
  const units = [...new Set([...legacy.activeUnits, ...legacy.enabledUnits])]
  for (const unit of units) {
    const stop = await systemctlUser('stop', unit)
    if (stop.code !== 0) throw new Error(`Could not stop ${unit}: ${stop.out || `exit ${stop.code}`}`)
    const disable = await systemctlUser('disable', unit)
    if (disable.code !== 0) throw new Error(`Could not disable ${unit}: ${disable.out || `exit ${disable.code}`}`)
    log(`Stopped and disabled ${unit}`)
  }
  const procs = await scanProcs()
  const loops = new Set(procs.filter((p) => legacyFromScan({ procs: [p], units: [] })?.loopPids.length).map((p) => p.pid))
  for (const pid of loops) signal(pid, 'SIGTERM', log, 'SOAT reconnect loop')
  for (const p of procs) if (loops.has(p.ppid) && MINER_RE.test(p.argv[0] ?? '')) signal(p.pid, 'SIGTERM', log, 'its soat-miner')
  // Let the GPU go before the new service starts its own miner.
  for (let i = 0; i < 20; i++) {
    const left = (await scanProcs()).filter((p) => loops.has(p.pid) || (loops.has(p.ppid) && MINER_RE.test(p.argv[0] ?? '')))
    if (!left.length) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

function signal(pid: number, sig: NodeJS.Signals, log: (line: string) => void, what: string): void {
  try {
    process.kill(pid, sig)
    log(`Sent ${sig} to ${what} (pid ${pid})`)
  } catch {
    // already gone
  }
}

/** The fallback without systemd: a background process that outlives the window. The lock file keeps it single. */
export function spawnDetached(exec: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exec[0], exec.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env })
  child.on('error', () => undefined)
  child.unref()
}
