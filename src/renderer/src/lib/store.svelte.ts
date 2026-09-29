import { addressForNetwork } from '@shared/address'
import { syncView } from '@shared/sync'
import type {
  ApiKeyName,
  ClientSettings,
  ClientSettingsPatch,
  ClientStats,
  Network,
  NetworkState,
  NodeInfo,
  ProcId,
  ProcState,
  ReleaseList,
  TaskId,
  TaskProgress,
  VaultInfo,
  WalletState
} from '@shared/types'
import { RateTracker } from './format'

const NETWORK_KEY = 'lithos.network'
const AUTOSTART_KEY = 'lithos.autoStartClient'
const api = window.lithos
const syncRate = new RateTracker()

function savedNetwork(): Network {
  try {
    const value = localStorage.getItem(NETWORK_KEY)
    if (value === 'mainnet' || value === 'testnet') return value
  } catch {
    // storage unavailable; fall through to the default
  }
  return 'mainnet'
}

function savedAutoStart(): boolean {
  try {
    return localStorage.getItem(AUTOSTART_KEY) !== 'false'
  } catch {
    return true
  }
}

export const ui = $state({
  network: savedNetwork(),
  net: null as NetworkState | null,
  node: { id: 'node', network: null, status: 'stopped', pid: null, exitCode: null, detail: null, ports: null } as ProcState,
  client: { id: 'client', network: null, status: 'stopped', pid: null, exitCode: null, detail: null, ports: null } as ProcState,
  info: null as NodeInfo | null,
  /** Seconds until the current sync stage finishes, when it can be estimated. */
  syncEta: null as number | null,
  wallet: {
    network: null,
    phase: 'unavailable',
    address: null,
    passwordKnown: false,
    balanceNanoErg: null,
    walletHeight: null,
    error: null
  } as WalletState,
  clientSettings: null as ClientSettings | null,
  clientStats: null as ClientStats | null,
  /** Start the client by itself once everything it needs is ready. */
  autoStartClient: savedAutoStart(),
  dialog: null as 'difficulty' | 'commit' | 'miner' | 'shares' | 'settings' | 'import' | 'versions' | null,
  quickSetup: false,
  platform: '' as string,
  /** Open wallet wizard, if any. */
  wizard: null as 'create' | 'restore' | 'keystore' | null,
  progress: {} as Partial<Record<TaskId, TaskProgress>>,
  vault: null as VaultInfo | null,
  /** Development only: the client may start before the node is synced. */
  skipSyncGate: false,
  lanAddresses: [] as string[],
  installing: false,
  /** Node and client releases on GitHub for the selected network; null until checked (or offline). */
  releases: { node: null, client: null } as Record<ProcId, ReleaseList | null>,
  /** The node or client whose version is being switched. */
  switching: null as ProcId | null,
  setupError: null as string | null,
  nodeError: null as string | null,
  clientError: null as string | null
})

/** Strips Electron's "Error invoking remote method ..." wrapper. */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function applyNodeInfo(info: NodeInfo | null): void {
  ui.info = info
  if (!info) {
    syncRate.reset()
    ui.syncEta = null
    return
  }
  const v = syncView(info)
  const current = v.stage === 'headers' ? v.headers : v.stage === 'blocks' ? v.blocks : v.stage === 'indexing' ? v.indexed : null
  ui.syncEta = current === null ? null : syncRate.eta(v.stage, current, v.target)
}

export async function init(): Promise<void> {
  api.onProcState((s) => {
    if (s.id === 'node') ui.node = s
    else ui.client = s
  })
  api.onNodeInfo(applyNodeInfo)
  api.onWallet((w) => (ui.wallet = w))
  api.onClientStats((st) => (ui.clientStats = st))
  api.onProgress((p) => (ui.progress[p.task] = p))

  const [app, node, client, info, wallet, stats] = await Promise.all([
    api.getAppInfo(),
    api.getProc('node'),
    api.getProc('client'),
    api.getNodeInfo(),
    api.focusWallet(ui.network),
    api.getClientStats()
  ])
  ui.platform = app.platform
  ui.clientStats = stats
  ui.vault = app.vault
  ui.skipSyncGate = app.skipSyncGate
  ui.lanAddresses = app.lanAddresses
  ui.node = node
  ui.client = client
  ui.wallet = wallet
  applyNodeInfo(info)
  await refresh()
  // First launch: nothing installed yet, so offer the guided setup.
  ui.quickSetup = ui.net !== null && !ui.net.java.installed
}

export async function refresh(): Promise<void> {
  const network = ui.network
  const [state, settings] = await Promise.all([api.getState(network), api.getClientSettings(network)])
  if (network === ui.network) {
    ui.net = state
    ui.clientSettings = settings
  }
  // Quietly looks for newer releases; GitHub is only asked again after a while.
  if (state.node.installed || state.client.installed) void loadReleases(false).catch(() => undefined)
}

/** Fetches both release lists for the selected network. Throws if GitHub can't be reached. */
export async function loadReleases(recheck: boolean): Promise<void> {
  const network = ui.network
  const [node, client] = await Promise.all([
    api.getReleases(network, 'node', recheck),
    api.getReleases(network, 'client', recheck)
  ])
  if (network === ui.network) ui.releases = { node, client }
}

/** Switches the node or client to `version`, restarting it if it runs. Returns an error message, or null. */
export async function useVersion(id: ProcId, version: string): Promise<string | null> {
  const network = ui.network
  ui.switching = id
  delete ui.progress[id]
  try {
    const state = await api.useVersion(network, id, version)
    if (state.network === ui.network) ui.net = state
    await loadReleases(false).catch(() => undefined)
    return null
  } catch (err) {
    await refresh()
    return errorText(err)
  } finally {
    ui.switching = null
  }
}

export async function setNetwork(network: Network): Promise<void> {
  if (network === ui.network) return
  ui.network = network
  ui.net = null
  ui.clientSettings = null
  ui.releases = { node: null, client: null }
  ui.setupError = null
  ui.progress = {}
  // Same key, other network: flip the address immediately and drop the other balance.
  ui.wallet = {
    ...ui.wallet,
    network,
    phase: 'unavailable',
    address: ui.wallet.address ? addressForNetwork(ui.wallet.address, network) : null,
    balanceNanoErg: null,
    walletHeight: null,
    error: null,
    passwordKnown: false
  }
  try {
    localStorage.setItem(NETWORK_KEY, network)
  } catch {
    // not critical
  }
  ui.wallet = await api.focusWallet(network)
  await refresh()
}

export async function install(): Promise<void> {
  ui.installing = true
  ui.setupError = null
  ui.progress = {}
  try {
    const state = await api.install(ui.network)
    if (state.network === ui.network) ui.net = state
  } catch (err) {
    ui.setupError = errorText(err)
    await refresh()
  } finally {
    ui.installing = false
  }
}

export async function startNode(): Promise<void> {
  ui.nodeError = null
  try {
    await api.startNode(ui.network)
  } catch (err) {
    ui.nodeError = errorText(err)
  }
}

export async function stopNode(): Promise<void> {
  ui.nodeError = null
  try {
    await api.stopNode()
  } catch (err) {
    ui.nodeError = errorText(err)
  }
}

export async function openNodePanel(): Promise<void> {
  try {
    await api.openNodePanel()
  } catch (err) {
    ui.nodeError = errorText(err)
  }
}

export async function openFolder(): Promise<void> {
  try {
    await api.openFolder(ui.network)
  } catch (err) {
    ui.setupError = errorText(err)
  }
}

/** Returns an error message, or null on success. */
export async function unlockWallet(password: string, remember: boolean): Promise<string | null> {
  try {
    await api.unlockWallet(password, remember)
    return null
  } catch (err) {
    return errorText(err)
  }
}

export function copyText(text: string): Promise<void> {
  return api.copyText(text)
}

/** Copies an API key in the main process, so it never reaches this window. Returns an error message, or null. */
export async function copyApiKey(network: Network, name: ApiKeyName): Promise<string | null> {
  try {
    await api.copyApiKey(network, name)
    return null
  } catch (err) {
    return errorText(err)
  }
}

export async function startClient(): Promise<void> {
  ui.clientError = null
  try {
    await api.startClient(ui.network)
  } catch (err) {
    ui.clientError = errorText(err)
  }
}

export async function stopClient(): Promise<void> {
  ui.clientError = null
  try {
    await api.stopClient()
  } catch (err) {
    ui.clientError = errorText(err)
  }
}

export async function openLithosPanel(): Promise<void> {
  try {
    await api.openLithosPanel()
  } catch (err) {
    ui.clientError = errorText(err)
  }
}

export async function restartClient(): Promise<void> {
  ui.clientError = null
  try {
    await api.restartClient(ui.network)
  } catch (err) {
    ui.clientError = errorText(err)
  }
}

/** Saves mining settings for the selected network. Returns an error message, or null. */
export async function saveClientSettings(patch: ClientSettingsPatch): Promise<string | null> {
  try {
    ui.clientSettings = await api.setClientSettings(ui.network, patch)
    return null
  } catch (err) {
    return errorText(err)
  }
}

export function setAutoStartClient(on: boolean): void {
  ui.autoStartClient = on
  try {
    localStorage.setItem(AUTOSTART_KEY, String(on))
  } catch {
    // not critical
  }
}

export interface Requirement {
  label: string
  ok: boolean
  note: string
}

/** What the Lithos Client needs before it can start on the selected network. */
export function clientRequirements(): Requirement[] {
  const nodeUp = ui.node.status === 'running' && ui.node.network === ui.network
  const synced = nodeUp && ui.info !== null && syncView(ui.info).stage === 'synced'
  return [
    { label: 'Client installed', ok: ui.net?.client.installed ?? false, note: '' },
    { label: 'Node running', ok: nodeUp, note: '' },
    {
      label: 'Node synced',
      ok: synced || (ui.skipSyncGate && nodeUp),
      note: ui.skipSyncGate && !synced ? 'skipped (dev)' : ''
    },
    { label: 'Wallet unlocked', ok: ui.wallet.phase === 'unlocked' && ui.wallet.network === ui.network, note: '' },
    { label: 'Difficulty chosen', ok: Boolean(ui.clientSettings?.diff), note: '' }
  ]
}
