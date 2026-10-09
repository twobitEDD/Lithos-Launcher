// Installs and starts the background SOAT service from Lithos Launcher or the SOAT Miner window.
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { lockHolder, soatPaths } from './soatControl'
import {
  applicationsDir,
  DESKTOP_FILE,
  desktopEntryText,
  SERVICE_UNIT,
  serviceUnitText,
  spawnDetached,
  systemctlUser,
  systemdUserAvailable,
  userUnitDir
} from './soatServiceUnit'

export const SERVICE_FLAG = '--soat-service'
export const WINDOW_FLAG = '--soat'
export const ROOT_FLAG = '--lithos-root='

const APPIMAGE_RE = /^Lithos-Launcher-.+\.AppImage$/

/**
 * How to run this launcher again from outside it. An AppImage runs from a temporary mount that is
 * gone when it exits, and the downloaded file may be moved or deleted, so it is copied once per
 * version into `<root>/miner/app/` and the service runs that copy.
 */
async function launcherCommand(root: string): Promise<string[]> {
  if (!app.isPackaged) return [process.execPath, app.getAppPath()]
  const appImage = process.env.APPIMAGE
  if (process.platform !== 'linux' || !appImage) return [process.execPath]
  const dir = join(soatPaths(root).dir, 'app')
  const name = `Lithos-Launcher-${app.getVersion()}.AppImage`
  const copy = join(dir, name)
  const have = await stat(copy).then(
    (s) => s.isFile(),
    () => false
  )
  if (!have) {
    await mkdir(dir, { recursive: true })
    const tmp = `${copy}.${process.pid}.tmp`
    await copyFile(appImage, tmp)
    await chmod(tmp, 0o755)
    await rename(tmp, copy)
  }
  // Older copies: a service still running one keeps working (the file stays open until it exits).
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (entry !== name && APPIMAGE_RE.test(entry)) await rm(join(dir, entry), { force: true }).catch(() => undefined)
  }
  return [copy]
}

export async function serviceCommand(root: string): Promise<string[]> {
  const base = await launcherCommand(root)
  // No window and no GPU process; headless so it starts without a display (systemd user units have none).
  const extra = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox'] : ['--disable-gpu']
  return [...base, SERVICE_FLAG, `${ROOT_FLAG}${root}`, ...extra]
}

export async function windowCommand(root: string): Promise<string[]> {
  return [...(await launcherCommand(root)), WINDOW_FLAG, `${ROOT_FLAG}${root}`]
}

/** `--lithos-root=<dir>` from argv, or null. */
export function rootFromArgv(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith(ROOT_FLAG))
  return arg ? arg.slice(ROOT_FLAG.length) || null : null
}

export function soatModeFromArgv(argv: string[]): 'service' | 'window' | null {
  if (argv.includes(SERVICE_FLAG)) return 'service'
  if (argv.includes(WINDOW_FLAG)) return 'window'
  return null
}

async function writeIfChanged(file: string, data: string | Buffer): Promise<boolean> {
  const next = typeof data === 'string' ? Buffer.from(data) : data
  const old = await readFile(file).catch(() => null)
  if (old?.equals(next)) return false
  await writeFile(file, next)
  return true
}

/** The "SOAT Miner" menu entry, so the window opens without Lithos Launcher. Linux only. */
async function installDesktopEntry(root: string): Promise<void> {
  if (process.platform !== 'linux') return
  const icon = join(soatPaths(root).dir, 'soat-miner.png')
  await mkdir(soatPaths(root).dir, { recursive: true })
  const png = await readFile(join(app.getAppPath(), 'resources', 'icon.png')).catch(() => null)
  if (png) await writeIfChanged(icon, png).catch(() => undefined)
  await mkdir(applicationsDir(), { recursive: true })
  await writeIfChanged(join(applicationsDir(), DESKTOP_FILE), desktopEntryText(await windowCommand(root), icon))
}

export interface EnsureResult {
  mode: 'systemd' | 'detached'
  installed: boolean
}

/**
 * Writes the unit (and the menu entry) and, when `start` is set, enables and starts the service.
 * Without systemd --user (or off Linux), starts a detached service unless one already holds the lock.
 * Never stops or restarts a running service.
 */
export async function ensureService(root: string, start: boolean): Promise<EnsureResult> {
  await installDesktopEntry(root).catch(() => undefined)
  const exec = await serviceCommand(root)
  if (await systemdUserAvailable()) {
    await mkdir(userUnitDir(), { recursive: true })
    if (await writeIfChanged(join(userUnitDir(), SERVICE_UNIT), serviceUnitText(exec))) {
      await systemctlUser('daemon-reload')
    }
    if (start) {
      const r = await systemctlUser('enable', '--now', SERVICE_UNIT)
      if (r.code !== 0) throw new Error(`Could not start ${SERVICE_UNIT}: ${r.out || `exit ${r.code}`}`)
    }
    return { mode: 'systemd', installed: true }
  }
  if (start && lockHolder(soatPaths(root).lock) === null) spawnDetached(exec)
  return { mode: 'detached', installed: true }
}
