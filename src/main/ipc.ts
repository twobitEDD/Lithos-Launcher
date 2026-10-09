import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  API_KEY_RE,
  IPC,
  isNetwork,
  MIN_API_KEY_LENGTH,
  type ApiKeyName,
  type AppInfo,
  type ClientSettingsPatch,
  type ConfigFileInfo,
  type ConfigName,
  type ImportOptions,
  type LauncherInfo,
  type Network,
  type NodeSettingsPatch,
  type ProcId
} from '@shared/types'
import { managedClientKeys, readClientSettings, updateClientSettings } from './clientConf'
import type { ClientController } from './clientController'
import { MANAGED_NODE_KEYS, readNodeSettings, updateNodeSettings } from './ergoConf'
import type { Importer } from './importer'
import type { Installer } from './installer'
import { autoHeap, defaultRoot, heapPlan, layout } from './layout'
import { customOverrides } from './managedBlock'
import { nodeAutoStart, type NodeAutoStarter } from './nodeAutoStart'
import type { NodeController } from './nodeController'
import { copySecret } from './secretClipboard'
import { settings, shareWalletAcrossNetworks, updateSettings } from './settings'
import { lanAddresses, systemCheck } from './system'
import type { Vault } from './vault'
import type { LauncherDeferral } from './deferral'
import type { LanPeerCoordinator } from './lanPeerService'
import type { MinerController } from './minerController'
import type { WalletManager } from './wallet'

interface IpcContext {
  window: () => BrowserWindow | null
  root: string
  vault: Vault
  installer: Installer
  node: NodeController
  wallet: WalletManager
  client: ClientController
  importer: Importer
  skipSyncGate: boolean
  /** Told when an unconfirmed seed phrase appears or goes, so closing can warn first. */
  onSensitive: (on: boolean) => void
  /** Stops the node and client safely and quits, asking first if either runs. */
  quit: () => Promise<void>
  deferral: LauncherDeferral
  lanPeers: LanPeerCoordinator
  miner: MinerController
  nodeAutoStart: NodeAutoStarter
}

function asNetwork(value: unknown): Network {
  if (!isNetwork(value)) throw new Error('Invalid network')
  return value
}

function asProcId(value: unknown): ProcId {
  if (value !== 'node' && value !== 'client') throw new Error('Invalid process id')
  return value
}

function asString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('Invalid argument')
  return value
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid argument')
  return value
}

/** Only known keys with the right types; values are validated again when written. */
function asSettingsPatch(value: unknown): ClientSettingsPatch {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid settings')
  const v = value as Record<string, unknown>
  const patch: ClientSettingsPatch = {}
  for (const key of Object.keys(v)) {
    if (key === 'diff') patch.diff = asString(v.diff, 16)
    else if (key === 'autoCommit') patch.autoCommit = asBoolean(v.autoCommit)
    else if (key === 'forceConfigDiff') patch.forceConfigDiff = asBoolean(v.forceConfigDiff)
    else if (key === 'lanPanel') patch.lanPanel = asBoolean(v.lanPanel)
    else if (key === 'httpPort' || key === 'stratumPort' || key === 'reductionMultiplier') {
      if (typeof v[key] !== 'number') throw new Error('Invalid argument')
      patch[key] = v[key] as number
    }
    else throw new Error(`Unknown setting: ${key}`)
  }
  return patch
}

function asApiKeyName(value: unknown): ApiKeyName {
  if (value !== 'node' && value !== 'lithos') throw new Error('Invalid key name')
  return value
}

function asConfigName(value: unknown): ConfigName {
  if (value !== 'node' && value !== 'client') throw new Error('Invalid config name')
  return value
}

async function configFile(path: string, managed: readonly string[]): Promise<ConfigFileInfo> {
  const exists = await stat(path).then(
    (s) => s.isFile(),
    () => false
  )
  return { path, exists, overrides: exists ? await customOverrides(path, managed) : [] }
}

function asNodeSettingsPatch(value: unknown): NodeSettingsPatch {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid settings')
  const v = value as Record<string, unknown>
  const patch: NodeSettingsPatch = {}
  for (const key of Object.keys(v)) {
    if (key === 'offlineGeneration') patch.offlineGeneration = asBoolean(v.offlineGeneration)
    else if (key === 'apiPort' || key === 'p2pPort') {
      if (typeof v[key] !== 'number') throw new Error('Invalid argument')
      patch[key] = v[key] as number
    } else throw new Error(`Unknown setting: ${key}`)
  }
  return patch
}

// The only external pages the UI can open. The renderer names one; it never supplies a URL.
const LINKS: Record<string, string> = {
  soat: 'https://github.com/blindrun/soat-miner',
  rigel: 'https://github.com/rigelminer/rigel/releases',
  ergoReleases: 'https://github.com/ergoplatform/ergo/releases',
  clientReleases: 'https://github.com/Lithos-Protocol/Lithos-Client/releases'
}

function launcherInfo(root: string): LauncherInfo {
  const heap = settings().heap
  return {
    root,
    defaultRoot: defaultRoot(),
    heap: heapPlan(),
    autoHeap: autoHeap(),
    heapOverridden: { node: heap?.nodeMb !== undefined, client: heap?.clientMb !== undefined },
    dataDirs: { ...settings().dataDirs },
    shareWalletAcrossNetworks: shareWalletAcrossNetworks()
  }
}

function asHeapMb(value: unknown): number | null {
  if (value === null) return null
  const maxMb = Math.floor(totalmem() / 2 ** 20)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 512 || value > maxMb) {
    throw new Error(`Heap sizes are whole megabytes from 512 to ${maxMb}`)
  }
  return value
}

export function registerIpc(ctx: IpcContext): void {
  // Only the top frame of our own window may call in.
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = ctx.window()
      if (!win || event.sender.id !== win.webContents.id || event.senderFrame?.parent !== null) {
        throw new Error('Unauthorized IPC sender')
      }
      return fn(...args)
    })
  }
  const procOf = (id: ProcId) => (id === 'node' ? ctx.node.proc : ctx.client.proc)

  handle(IPC.getState, (n) => ctx.installer.state(asNetwork(n)))
  handle(
    IPC.getAppInfo,
    (): AppInfo => ({
      vault: ctx.vault.info,
      skipSyncGate: ctx.skipSyncGate,
      lanAddresses: lanAddresses(),
      platform: process.platform,
      // The AppImage's wrapper adds --no-sandbox where Chromium's sandbox can't start (see the README).
      sandboxed: !app.commandLine.hasSwitch('no-sandbox'),
      appImage: process.platform === 'linux' && !!process.env.APPIMAGE,
      shareWalletAcrossNetworks: shareWalletAcrossNetworks(),
      remoteLauncher: ctx.deferral.current(),
      ignoredLaunchers: settings().ignoredLaunchers ?? [],
      autoStartNode: nodeAutoStart()
    })
  )
  handle(IPC.useLocalLauncher, () => ctx.deferral.useLocal())
  handle(IPC.useRemoteLauncher, () => ctx.deferral.useRemoteAgain())
  handle(IPC.install, (n) => ctx.installer.install(asNetwork(n)))
  handle(IPC.getReleases, (n, id, recheck) =>
    ctx.installer.releases(asNetwork(n), asProcId(id), asBoolean(recheck))
  )
  handle(IPC.useVersion, async (n, id, v) => {
    const network = asNetwork(n)
    const which = asProcId(id)
    const version = asString(v, 64)
    const { status, network: on } = (which === 'node' ? ctx.node : ctx.client).proc.state
    if (on === network && (status === 'starting' || status === 'stopping')) {
      throw new Error(`Wait until the ${which === 'node' ? 'node' : 'Lithos Client'} has finished ${status}`)
    }
    const runningHere = on === network && status === 'running'
    await ctx.installer.fetchVersion(network, which, version)
    if (runningHere && which === 'node') {
      // The client talks to the node, so it stops first. With "Start when ready" on, the dashboard
      // starts it again once the node is back up.
      await ctx.client.stop()
      await ctx.node.stop()
      await ctx.node.start(network)
    } else if (runningHere) {
      await ctx.client.restart(network)
    }
    // Only once the new version is up, so a failed start can switch straight back.
    await ctx.installer.prune(network, which)
    return ctx.installer.state(network)
  })
  handle(IPC.startNode, (n) => ctx.node.start(asNetwork(n)))
  handle(IPC.autoStartNode, (n) => ctx.nodeAutoStart.run(asNetwork(n)))
  handle(IPC.setAutoStartNode, async (on) => {
    await updateSettings((s) => {
      if (asBoolean(on)) delete s.autoStartNode
      else s.autoStartNode = false
    })
    return nodeAutoStart()
  })
  // The client depends on the node, so it always stops first.
  handle(IPC.stopNode, async () => {
    await ctx.client.stop()
    await ctx.node.stop()
  })
  handle(IPC.getProc, (id) => procOf(asProcId(id)).state)
  handle(IPC.getLogs, (id) => procOf(asProcId(id)).snapshot())
  handle(IPC.getNodeInfo, () => ctx.node.info)
  handle(IPC.getLanPeers, () => ctx.lanPeers.current())
  handle(IPC.setLanPeering, (on) => ctx.lanPeers.setEnabled(asBoolean(on)))
  handle(IPC.getMiner, () => ctx.miner.state)
  handle(IPC.startMiner, () => ctx.miner.start())
  handle(IPC.stopMiner, () => ctx.miner.stop())
  handle(IPC.setMinerAutoStart, (on) => ctx.miner.setAutoStart(asBoolean(on)))
  handle(IPC.switchMinerService, () => ctx.miner.switchToService())

  handle(IPC.openNodePanel, async () => {
    const conn = ctx.node.connection()
    if (!conn) throw new Error('The node is not running')
    await shell.openExternal(`http://127.0.0.1:${conn.api.port}/panel`)
  })

  handle(IPC.openFolder, async (n) => {
    const dir = layout.netDir(ctx.root, asNetwork(n))
    await mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })

  handle(IPC.stopStrayNode, (n) => ctx.node.stopStray(asNetwork(n)))
  handle(IPC.startClient, (n) => ctx.client.start(asNetwork(n)))
  handle(IPC.stopClient, () => ctx.client.stop())
  handle(IPC.restartClient, (n) => ctx.client.restart(asNetwork(n)))
  handle(IPC.getClientSettings, (n) => readClientSettings(ctx.root, asNetwork(n)))
  handle(IPC.setClientSettings, (n, patch) => updateClientSettings(ctx.root, asNetwork(n), asSettingsPatch(patch)))
  handle(IPC.getClientStats, () => ctx.client.stats)
  handle(IPC.getCommitments, () => ctx.client.commitments)
  handle(IPC.getNodeSettings, (n) => readNodeSettings(ctx.root, asNetwork(n)))
  handle(IPC.setNodeSettings, (n, patch) => updateNodeSettings(ctx.root, asNetwork(n), asNodeSettingsPatch(patch)))
  handle(IPC.getSystemCheck, (n) => systemCheck(ctx.root, asNetwork(n)))
  const nothingRunning = (): void => {
    if (ctx.node.proc.alive || ctx.client.proc.alive) throw new Error('Stop the node and client first')
  }
  const relaunch = (): void => {
    app.relaunch()
    app.quit()
  }

  handle(IPC.getLauncherInfo, () => launcherInfo(ctx.root))
  handle(IPC.setHeap, async (heap) => {
    const h = (heap ?? {}) as { nodeMb?: unknown; clientMb?: unknown }
    const nodeMb = asHeapMb(h.nodeMb ?? null)
    const clientMb = asHeapMb(h.clientMb ?? null)
    await updateSettings((s) => {
      s.heap = {
        ...(nodeMb !== null ? { nodeMb } : {}),
        ...(clientMb !== null ? { clientMb } : {})
      }
      if (!s.heap.nodeMb && !s.heap.clientMb) delete s.heap
    })
    return launcherInfo(ctx.root)
  })
  handle(IPC.setShareWalletAcrossNetworks, async (on) => {
    await updateSettings((s) => {
      if (asBoolean(on)) s.shareWalletAcrossNetworks = true
      else delete s.shareWalletAcrossNetworks
    })
    await ctx.wallet.applySharePreference()
    return launcherInfo(ctx.root)
  })
  handle(IPC.chooseInstallRoot, async () => {
    nothingRunning()
    const win = ctx.window()
    const picked = win
      ? await dialog.showOpenDialog(win, {
          title: 'Choose where the launcher installs everything',
          properties: ['openDirectory', 'createDirectory']
        })
      : null
    const folder = picked && !picked.canceled ? picked.filePaths[0] : null
    if (!folder) return false
    await updateSettings((s) => {
      if (resolve(folder) === resolve(defaultRoot())) delete s.root
      else s.root = resolve(folder)
    })
    relaunch()
    return true
  })
  handle(IPC.resetInstallRoot, async () => {
    nothingRunning()
    await updateSettings((s) => {
      delete s.root
    })
    relaunch()
  })
  handle(IPC.pickFolder, async (title) => {
    const win = ctx.window()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, { title: asString(title, 200), properties: ['openDirectory'] })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })
  const configPath = (network: Network, name: ConfigName): string =>
    name === 'node' ? layout.ergoConf(ctx.root, network) : layout.clientConf(ctx.root, network)
  handle(IPC.getConfigInfo, async (n) => {
    const network = asNetwork(n)
    return {
      files: {
        node: await configFile(configPath(network, 'node'), MANAGED_NODE_KEYS),
        client: await configFile(
          configPath(network, 'client'),
          managedClientKeys(await readClientSettings(ctx.root, network))
        )
      }
    }
  })
  handle(IPC.openConfig, async (n, name, reveal) => {
    const network = asNetwork(n)
    const config = asConfigName(name)
    const path = configPath(network, config)
    if (!(await stat(path).then(() => true, () => false))) {
      throw new Error(`${config === 'node' ? 'ergo.conf' : 'lithos.conf'} is created the first time the ${config} starts`)
    }
    if (asBoolean(reveal)) return shell.showItemInFolder(path)
    if (!(await shell.openPath(path))) return
    // .conf usually has no program associated with it on Windows; every Windows has Notepad.
    if (process.platform === 'win32') {
      const notepad = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
      spawn(notepad, [path], { detached: true, stdio: 'ignore' }).unref()
    } else {
      shell.showItemInFolder(path)
    }
  })
  // The keys go from the vault to the clipboard inside the main process; the renderer never sees them.
  handle(IPC.copyApiKey, async (n, name) => {
    const network = asNetwork(n)
    const which = asApiKeyName(name)
    const stored = which === 'node' ? ctx.vault.getNodeKey(network) : ctx.vault.getLithosKey(network)
    if (!stored) {
      throw new Error(
        which === 'node'
          ? `The ${network} node makes its API key the first time it starts`
          : `The Lithos API key is made the first time the ${network} client starts`
      )
    }
    await copySecret(stored.key)
  })
  handle(IPC.replaceApiKey, async (n, name, key) => {
    const network = asNetwork(n)
    const chosen = key === null ? null : asString(key, 256)
    if (chosen !== null && !API_KEY_RE.test(chosen)) {
      throw new Error(`Use at least ${MIN_API_KEY_LENGTH} characters: letters, digits and symbols, no spaces`)
    }
    if (asApiKeyName(name) === 'lithos') return ctx.client.replaceKey(network, chosen)
    if (ctx.node.runningNetwork !== network || ctx.node.proc.state.status !== 'running') {
      throw new Error(`Start the ${network} node first`)
    }
    // The client talks to the node with the old key, so it stops first. With "Start when ready"
    // on, the dashboard starts it again once the node is back up.
    await ctx.client.stop()
    await ctx.node.replaceKey(network, chosen)
  })
  handle(IPC.inspectImport, (n, nodeFolder, clientFolder) =>
    ctx.importer.inspect(
      asNetwork(n),
      asString(nodeFolder, 1000),
      clientFolder === null ? null : asString(clientFolder, 1000)
    )
  )
  handle(IPC.applyImport, async (n, options) => {
    const network = asNetwork(n)
    if (ctx.node.proc.alive && ctx.node.runningNetwork === network) throw new Error('Stop the node first')
    const o = (options ?? {}) as Record<string, unknown>
    const opts: ImportOptions = {
      importClientSettings: asBoolean(o.importClientSettings),
      copyLithosData: asBoolean(o.copyLithosData)
    }
    await ctx.importer.apply(network, opts)
  })
  handle(IPC.clearImport, async (n) => {
    const network = asNetwork(n)
    if (ctx.node.proc.alive && ctx.node.runningNetwork === network) throw new Error('Stop the node first')
    await ctx.importer.clear(network)
  })
  handle(IPC.scrubOldSecrets, (n) => ctx.importer.scrubSecrets(asNetwork(n)))

  handle(IPC.openLink, async (name) => {
    const url = typeof name === 'string' ? LINKS[name] : undefined
    if (!url) throw new Error('Unknown link')
    await shell.openExternal(url)
  })
  handle(IPC.openLithosPanel, async () => {
    const port = ctx.client.httpPort
    if (port === null) throw new Error('The Lithos Client is not running')
    await shell.openExternal(`http://127.0.0.1:${port}/`)
  })

  handle(IPC.getWallet, () => ctx.wallet.state)
  handle(IPC.focusWallet, (n) => ctx.wallet.focus(asNetwork(n)))
  handle(IPC.listWallets, (n) => ctx.wallet.list(asNetwork(n)))
  handle(IPC.createWallet, (password, replace) =>
    ctx.wallet.create(asString(password, 256), replace === undefined ? false : asBoolean(replace))
  )
  handle(IPC.restoreWallet, (mnemonic, password, replace) =>
    ctx.wallet.restore(
      asString(mnemonic, 1000),
      asString(password, 256),
      replace === undefined ? false : asBoolean(replace)
    )
  )
  handle(IPC.addWallet, (n) => ctx.wallet.addKept(asNetwork(n)))
  handle(IPC.removeWallet, (n, file) => ctx.wallet.remove(asNetwork(n), asString(file, 200)))
  handle(IPC.useWallet, (n, file) => ctx.wallet.useKept(asNetwork(n), asString(file, 200)))
  handle(IPC.unlockWallet, (password, remember) => ctx.wallet.unlock(asString(password, 256), asBoolean(remember)))
  // The picked path stays in the main process; the renderer only ever sees its name.
  handle(IPC.pickKeystore, async () => {
    const win = ctx.window()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose your Ergo node keystore file',
      filters: [
        { name: 'Ergo keystore', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const file = picked.canceled ? null : picked.filePaths[0]
    return file ? ctx.wallet.pickKeystore(file) : null
  })
  handle(IPC.importKeystore, (password) => ctx.wallet.importKeystore(asString(password, 256)))

  // The renderer has no clipboard permission; copying goes through here.
  handle(IPC.copyText, (text) => clipboard.writeText(asString(text, 2000)))
  handle(IPC.setSensitive, (on) => {
    const value = asBoolean(on)
    ctx.onSensitive(value)
    // Windows and macOS only; on Linux the seed screen warns about screenshots instead.
    ctx.window()?.setContentProtection(value)
  })
  handle(IPC.quit, () => ctx.quit())
}
