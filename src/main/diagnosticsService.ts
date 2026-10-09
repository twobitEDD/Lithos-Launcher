import { open, readFile, stat } from 'node:fs/promises'
import { arch, cpus, freemem, release, totalmem, type as osType } from 'node:os'
import { dirname, join } from 'node:path'
import { copyActive } from '@shared/chainCopy'
import { buildDiagnostics, redactText, type DiagnosticLog } from '@shared/diagnostics'
import { nodePhase } from '@shared/nodePhase'
import { NETWORKS, type LogId, type Network } from '@shared/types'
import type { ChainCopyCoordinator } from './chainCopyService'
import { freeBytes } from './chainSnapshot'
import type { ClientController } from './clientController'
import type { LauncherDeferral } from './deferral'
import type { Installer } from './installer'
import { detectJre } from './java'
import type { LanPeerCoordinator } from './lanPeerService'
import { autoHeap, heapPlan, layout } from './layout'
import type { MinerController } from './minerController'
import type { NodeController } from './nodeController'
import { settings } from './settings'
import { soatPaths } from './soatControl'
import { errorMessage } from './util'
import type { Vault } from './vault'

/** The SOAT log can grow large; only its end is read. */
const SOAT_TAIL_BYTES = 512 * 1024

export interface DiagnosticsContext {
  root: string
  version: string
  electron: string | null
  packaged: boolean
  vault: Vault
  installer: Installer
  node: NodeController
  client: ClientController
  miner: MinerController
  lanPeers: LanPeerCoordinator
  chainCopy: ChainCopyCoordinator
  deferral: LauncherDeferral
}

/** Every secret value the vault holds, for exact-match masking. Never returned to the renderer. */
export function knownSecrets(vault: Vault): string[] {
  const out: string[] = []
  for (const network of NETWORKS) {
    const node = vault.getNodeKey(network)
    const lithos = vault.getLithosKey(network)
    for (const value of [node?.key, node?.hash, lithos?.key, lithos?.hash, vault.getWalletPassword(network), vault.getPlaySecret(network)]) {
      if (typeof value === 'string' && value) out.push(value)
    }
  }
  return out
}

/** The last lines of a text file, reading at most `maxBytes` from its end. */
export async function readFileTail(path: string, maxBytes = SOAT_TAIL_BYTES): Promise<string[]> {
  const size = (await stat(path)).size
  const length = Math.min(size, maxBytes)
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (size > length) lines.shift() // first line is probably cut
    return lines.filter((line) => line.trim() !== '')
  } finally {
    await handle.close()
  }
}

/** Where each log's full copy lives on disk. */
export function logFolder(root: string, id: LogId, network: Network): string {
  if (id === 'soat') return soatPaths(root).dir
  if (id === 'client') return join(layout.clientDir(root, network), 'logs')
  return layout.nodeDir(root, network)
}

/** Every buffered line of a log, redacted. */
export async function fullLog(ctx: DiagnosticsContext, id: LogId): Promise<string[]> {
  const secrets = knownSecrets(ctx.vault)
  const lines =
    id === 'soat'
      ? await readFileTail(soatPaths(ctx.root).log).catch(() => ctx.miner.state.logTail)
      : (id === 'node' ? ctx.node.proc : ctx.client.proc).snapshot().lines
  return lines.map((line) => redactText(line, secrets))
}

function network(ctx: DiagnosticsContext): Network {
  return ctx.node.proc.state.network ?? settings().nodeNetwork ?? 'mainnet'
}

/** The whole redacted bundle. Each part that fails is listed instead of stopping the rest. */
export async function collectDiagnostics(ctx: DiagnosticsContext): Promise<string> {
  const errors: string[] = []
  const net = network(ctx)
  const attempt = async <T>(what: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (err) {
      errors.push(`${what}: ${errorMessage(err)}`)
      return undefined
    }
  }

  const install = await attempt('install state', () => ctx.installer.state(net))
  const java = await attempt('Java check', () => detectJre(ctx.root))
  const disk = await attempt('free disk space', () => freeBytes(dirname(layout.nodeDataDir(ctx.root, net))))
  const ergoConf = await attempt('ergo.conf', () =>
    readFile(layout.ergoConf(ctx.root, net), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
  )
  const soatLog = await readFileTail(soatPaths(ctx.root).log).catch(() => ctx.miner.state.logTail)
  const chainCopy = ctx.chainCopy.current()
  const gb = (bytes: number): number => Math.round((bytes / 2 ** 30) * 10) / 10

  const logs: DiagnosticLog[] = [
    { name: 'Ergo node', lines: ctx.node.proc.snapshot().lines, source: logFolder(ctx.root, 'node', net) },
    { name: 'Lithos Client', lines: ctx.client.proc.snapshot().lines, source: logFolder(ctx.root, 'client', net) },
    { name: 'SOAT miner', lines: soatLog, source: soatPaths(ctx.root).log }
  ]

  const phase = nodePhase({
    status: ctx.node.proc.state.status,
    detail: ctx.node.proc.state.detail,
    info: ctx.node.info,
    installed: Boolean(install?.java.installed && install?.node.installed),
    remote: ctx.deferral.current() !== null,
    copying: copyActive(chainCopy.phase),
    noHeightSince: null,
    now: Date.now()
  })

  return buildDiagnostics({
    generatedAt: new Date().toISOString(),
    launcher: { version: ctx.version, electron: ctx.electron, packaged: ctx.packaged },
    os: {
      platform: process.platform,
      type: osType(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      totalMemoryGB: gb(totalmem()),
      freeMemoryGB: gb(freemem()),
      freeDiskGB: typeof disk === 'number' ? gb(disk) : null,
      appImage: process.platform === 'linux' && Boolean(process.env.APPIMAGE),
      installRoot: ctx.root,
      network: net,
      java: java ?? null,
      heapMb: heapPlan(),
      heapAutoMb: autoHeap(),
      heapOverride: settings().heap ?? null
    },
    nodePhase: phase?.text ?? null,
    settings: settings(),
    install,
    node: { state: ctx.node.proc.state, info: ctx.node.info, health: ctx.node.health, ergoConf },
    client: { state: ctx.client.proc.state, stats: ctx.client.stats },
    miner: { ...ctx.miner.state, logTail: undefined },
    lanPeers: ctx.lanPeers.current(),
    chainCopy,
    remoteLauncher: ctx.deferral.current(),
    logs,
    secrets: knownSecrets(ctx.vault),
    errors
  })
}
