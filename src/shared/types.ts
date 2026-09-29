// Types and channel names shared by the main process, preload and renderer.
// This file must stay free of Node and DOM imports.

export type Network = 'mainnet' | 'testnet'
export const NETWORKS: readonly Network[] = ['mainnet', 'testnet']

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value)
}

export type ProcId = 'node' | 'client'
export type ProcStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface ComponentState {
  installed: boolean
  version: string | null
}

export interface NetworkState {
  network: Network
  /** Folder holding this network's node and client, for display only. */
  folder: string
  java: ComponentState
  node: ComponentState & { apiPort: number }
  client: ComponentState
}

/**
 * How an Ergo node stores the chain. Ergo publishes each release twice: x.0.y on LevelDB and its
 * x.1.y twin on RocksDB. Both work with Lithos, but neither can read chain data the other wrote.
 */
export type ErgoDb = 'leveldb' | 'rocksdb'

export const ERGO_DB_LABEL: Record<ErgoDb, string> = { leveldb: 'LevelDB', rocksdb: 'RocksDB' }

/** The database an Ergo version uses, from the minor number; null for a line not known yet. */
export function ergoDb(version: string): ErgoDb | null {
  const minor = version.split('.')[1]
  return minor === '0' ? 'leveldb' : minor === '1' ? 'rocksdb' : null
}

/** A release on GitHub the launcher can install. */
export interface ReleaseInfo {
  version: string
  publishedAt: string
  size: number
  /** Node releases only: the database it keeps the chain in. */
  db: ErgoDb | null
}

export interface ReleaseList {
  id: ProcId
  network: Network
  /** Newest first. The client's list holds this network's track only. */
  releases: ReleaseInfo[]
  /** The version the launcher runs, or null before one is installed. */
  active: string | null
  /** A newer release to update to in place: for the node, on the same database. */
  update: string | null
  /** Node only: the database the existing chain data was written with, or null before there is any. */
  dataDb: ErgoDb | null
}

export interface ProcState {
  id: ProcId
  network: Network | null
  status: ProcStatus
  pid: number | null
  exitCode: number | null
  /** Short human-readable detail, e.g. "Waiting for the node API". */
  detail: string | null
  /** Ports the process listens on while running, e.g. { http: 9000, stratum: 4444 }. */
  ports: Record<string, number> | null
  /** A node this launcher started in an earlier session is still running and holds the ports. */
  stray?: boolean
}

export interface NodeInfo {
  appVersion: string | null
  fullHeight: number | null
  headersHeight: number | null
  maxPeerHeight: number | null
  peersCount: number
  indexedHeight: number | null
}

export type WalletPhase = 'unavailable' | 'uninitialized' | 'locked' | 'unlocking' | 'unlocked'

export interface WalletState {
  /** Network of the running node, or null when no node is running. */
  network: Network | null
  phase: WalletPhase
  /**
   * P2PK address of the same key on `network`: mainnet starts with 9, testnet with 3.
   * Null until a node has reported the key. Not a seed.
   */
  address: string | null
  /** The launcher holds this wallet's password (saved, or for this session only). */
  passwordKnown: boolean
  /** Confirmed balance in nanoERG while unlocked, else null. */
  balanceNanoErg: number | null
  /** Last block the wallet has scanned; behind the chain while a new wallet catches up. */
  walletHeight: number | null
  error: string | null
}

/** A keystore file picked for import. The main process keeps the path; the renderer only shows it. */
export interface KeystorePick {
  name: string
  folder: string
}

/** Node settings the launcher manages in ergo.conf. */
export interface NodeSettings {
  /** ergo.node.offlineGeneration: hand out mining work right after a restart, without waiting for a block. */
  offlineGeneration: boolean
}

export type NodeSettingsPatch = Partial<NodeSettings>

/** The Ergo node's own defaults: its mainnet.conf turns offline generation on, testnet leaves it off. */
export const DEFAULT_OFFLINE_GENERATION: Record<Network, boolean> = { mainnet: true, testnet: false }

/** Mining settings the launcher manages in lithos.conf. */
export interface ClientSettings {
  /** stratum.diff, e.g. "48M"; null until chosen (the shipped default is far too high for most rigs). */
  diff: string | null
  /** state.autoCommit: register and commit the difficulty on chain. Off until the user opts in. */
  autoCommit: boolean
  /** stratum.forceConfigDiff: mine at the config diff without committing (testing only). */
  forceConfigDiff: boolean
  httpPort: number
  stratumPort: number
  /** stratum.reductionMultiplier: miners are sent this × the diff, so they report fewer shares. */
  reductionMultiplier: number
  /** Serve the panel on all interfaces so phones and other computers on the LAN can open it. */
  lanPanel: boolean
}

export const REDUCTION_MULTIPLIERS = [10, 100, 1000, 10000] as const
/**
 * The launcher's default. The client ships 10000 (super shares only), which leaves most rigs with
 * too few shares to read a hashrate; 1000 keeps share traffic low but the reading usable.
 */
export const DEFAULT_REDUCTION_MULTIPLIER = 1000

export type ClientSettingsPatch = Partial<
  Pick<
    ClientSettings,
    'diff' | 'autoCommit' | 'forceConfigDiff' | 'httpPort' | 'stratumPort' | 'reductionMultiplier' | 'lanPanel'
  >
>

/** Live figures from the running client's open stats endpoints. Scores are integer strings. */
export interface ClientStats {
  stratumStatus: string | null
  rigs: number
  hashesPerSecond: number | null
  superShares: number
  superSharesPerHour: number | null
  committed: string | null
  pending: string | null
  pendingFromHeight: number | null
  forcedConfig: boolean
}

/** What an existing setup contains, shown before anything is changed. */
export interface ImportPreview {
  network: Network
  /** The node data folder (with history/ and state/), used in place. */
  dataDir: string
  chainBytes: number
  hasWallet: boolean
  /** networkType found in a .conf next to the data folder, if any. */
  detectedNetwork: Network | null
  client: {
    conf: string
    diff: string | null
    autoCommit: boolean | null
    httpPort: number | null
    stratumPort: number | null
    /** The old config holds a plaintext node key or wallet password. */
    plaintextSecrets: boolean
    /** The old client's .lithos data folder, if present. */
    lithosData: string | null
    lithosDataBytes: number
  } | null
  warnings: string[]
}

export interface ImportOptions {
  importClientSettings: boolean
  copyLithosData: boolean
}

export interface LauncherInfo {
  root: string
  defaultRoot: string
  heap: { nodeMb: number; clientMb: number }
  autoHeap: { nodeMb: number; clientMb: number }
  heapOverridden: { node: boolean; client: boolean }
  /** Adopted node data folders, by network. */
  dataDirs: Partial<Record<Network, string>>
}

/** The node's REST API key, or the Lithos Client's own API key. */
export type ApiKeyName = 'node' | 'lithos'

/** A key you choose yourself. It travels in an HTTP header, so printable ASCII without spaces. */
export const MIN_API_KEY_LENGTH = 16
export const API_KEY_RE = /^[\x21-\x7e]{16,256}$/

/** The launcher's two config files: the node's ergo.conf and the client's lithos.conf. */
export type ConfigName = 'node' | 'client'

export interface ConfigFileInfo {
  path: string
  exists: boolean
  /** Settings added below the launcher's block that override ones the launcher relies on. */
  overrides: string[]
}

export interface NetworkConfigInfo {
  files: Record<ConfigName, ConfigFileInfo>
}

/** External pages the UI may open; the URLs live in the main process. */
export type LinkName = 'soat' | 'rigel' | 'ergoReleases' | 'clientReleases'

export interface SystemCheck {
  totalMemBytes: number
  /** Free space on the drive holding the install folder, or null if it couldn't be read. */
  freeDiskBytes: number | null
  installRoot: string
  ports: { port: number; label: string; free: boolean }[]
}

/** Seed phrase word counts the node accepts. */
export const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24] as const
export const MIN_PASSWORD_LENGTH = 8

export type TaskId = 'java' | 'node' | 'client'
export type TaskPhase = 'resolving' | 'downloading' | 'extracting' | 'done' | 'error'

export interface TaskProgress {
  task: TaskId
  phase: TaskPhase
  received?: number
  total?: number
  message?: string
}

/** A run of log lines; `start` is the sequence number of the first line. */
export interface LogChunk {
  proc: ProcId
  start: number
  lines: string[]
}

export interface VaultInfo {
  /** False when secrets would be stored without real OS encryption (Linux with no keyring). */
  secure: boolean
  backend: string
}

export interface AppInfo {
  vault: VaultInfo
  /** Development only: allow starting the client before the node is synced. */
  skipSyncGate: boolean
  /** This machine's LAN IPv4 addresses, for pointing mining rigs at the stratum port. */
  lanAddresses: string[]
  platform: 'win32' | 'linux' | 'darwin' | string
}

export interface LauncherApi {
  getState(network: Network): Promise<NetworkState>
  getAppInfo(): Promise<AppInfo>
  install(network: Network): Promise<NetworkState>
  /** Releases of the node or this network's client on GitHub. Cached for a while unless `recheck`. */
  getReleases(network: Network, id: ProcId, recheck: boolean): Promise<ReleaseList>
  /**
   * Downloads `version` if needed and makes it the one the launcher runs. If it is running on this
   * network it restarts on the new version (the client stops first when the node does); the old
   * version is then removed.
   */
  useVersion(network: Network, id: ProcId, version: string): Promise<NetworkState>
  startNode(network: Network): Promise<void>
  stopNode(): Promise<void>
  getProc(id: ProcId): Promise<ProcState>
  getLogs(id: ProcId): Promise<LogChunk>
  getNodeInfo(): Promise<NodeInfo | null>
  openNodePanel(): Promise<void>
  openFolder(network: Network): Promise<void>
  /** Cleanly stops a node left running by an earlier launcher session. */
  stopStrayNode(network: Network): Promise<void>
  startClient(network: Network): Promise<void>
  stopClient(): Promise<void>
  restartClient(network: Network): Promise<void>
  openLithosPanel(): Promise<void>
  getClientSettings(network: Network): Promise<ClientSettings>
  /** Saves to lithos.conf. The running client picks changes up on its next start. */
  setClientSettings(network: Network, patch: ClientSettingsPatch): Promise<ClientSettings>
  getClientStats(): Promise<ClientStats | null>
  getNodeSettings(network: Network): Promise<NodeSettings>
  /** Saves to ergo.conf. The node picks changes up on its next start. */
  setNodeSettings(network: Network, patch: NodeSettingsPatch): Promise<NodeSettings>
  getSystemCheck(network: Network): Promise<SystemCheck>
  openLink(name: LinkName): Promise<void>
  getLauncherInfo(): Promise<LauncherInfo>
  /** null resets a size to automatic. Takes effect on the next start. */
  setHeap(heap: { nodeMb: number | null; clientMb: number | null }): Promise<LauncherInfo>
  /** Opens a folder picker; the app restarts in the new folder. Resolves false if cancelled. */
  chooseInstallRoot(): Promise<boolean>
  resetInstallRoot(): Promise<void>
  pickFolder(title: string): Promise<string | null>
  getConfigInfo(network: Network): Promise<NetworkConfigInfo>
  /** Opens a config file in an editor, or with `reveal` shows it in the file manager. */
  openConfig(network: Network, name: ConfigName, reveal: boolean): Promise<void>
  /** Copies an API key from the vault straight to the clipboard, which is cleared again after 30 s. */
  copyApiKey(network: Network, name: ApiKeyName): Promise<void>
  /**
   * Replaces an API key with `key`, or a new random one when null. The node hashes it, so the node
   * must be running. The node key restarts the node (the client is stopped first); the Lithos key
   * restarts a running client. Keys are only ever stored encrypted.
   */
  replaceApiKey(network: Network, name: ApiKeyName, key: string | null): Promise<void>
  inspectImport(network: Network, nodeFolder: string, clientFolder: string | null): Promise<ImportPreview>
  applyImport(network: Network, options: ImportOptions): Promise<void>
  clearImport(network: Network): Promise<void>
  /** Replaces the plaintext key/password in the last inspected old lithos.conf with env references. */
  scrubOldSecrets(network: Network): Promise<void>
  getWallet(): Promise<WalletState>
  /** Points wallet reads and writes at this network's node, and returns that wallet. */
  focusWallet(network: Network): Promise<WalletState>
  /** Creates the node wallet and returns its seed words. They are shown once and never stored. */
  createWallet(password: string): Promise<string[]>
  restoreWallet(mnemonic: string, password: string): Promise<void>
  /** Opens a file picker for an Ergo node keystore (.json). Resolves null if cancelled. */
  pickKeystore(): Promise<KeystorePick | null>
  /**
   * Copies the picked keystore into the node's wallet folder and restarts the node to load it.
   * The node checks the password; if it doesn't unlock, the copy is removed and the node restarted.
   */
  importKeystore(password: string): Promise<void>
  /** `remember` saves the password to the vault; it is always kept for the session. */
  unlockWallet(password: string, remember: boolean): Promise<void>
  copyText(text: string): Promise<void>
  /** Hides the window from screenshots/screen recording while secrets are on screen. */
  setSensitive(on: boolean): Promise<void>
  onProgress(cb: (p: TaskProgress) => void): () => void
  onProcState(cb: (s: ProcState) => void): () => void
  onLogs(cb: (chunk: LogChunk) => void): () => void
  onNodeInfo(cb: (info: NodeInfo | null) => void): () => void
  onWallet(cb: (w: WalletState) => void): () => void
  onClientStats(cb: (s: ClientStats | null) => void): () => void
}

export const IPC = {
  getState: 'launcher:get-state',
  getAppInfo: 'launcher:get-app-info',
  install: 'launcher:install',
  getReleases: 'versions:list',
  useVersion: 'versions:use',
  startNode: 'node:start',
  stopNode: 'node:stop',
  getProc: 'proc:get',
  getLogs: 'proc:get-logs',
  getNodeInfo: 'node:get-info',
  openNodePanel: 'node:open-panel',
  openFolder: 'launcher:open-folder',
  stopStrayNode: 'node:stop-stray',
  startClient: 'client:start',
  stopClient: 'client:stop',
  openLithosPanel: 'client:open-panel',
  restartClient: 'client:restart',
  getClientSettings: 'client:get-settings',
  setClientSettings: 'client:set-settings',
  getClientStats: 'client:get-stats',
  getNodeSettings: 'node:get-settings',
  setNodeSettings: 'node:set-settings',
  getSystemCheck: 'launcher:system-check',
  openLink: 'launcher:open-link',
  getLauncherInfo: 'launcher:get-info',
  setHeap: 'launcher:set-heap',
  chooseInstallRoot: 'launcher:choose-root',
  resetInstallRoot: 'launcher:reset-root',
  pickFolder: 'launcher:pick-folder',
  getConfigInfo: 'launcher:config-info',
  openConfig: 'launcher:open-config',
  copyApiKey: 'keys:copy',
  replaceApiKey: 'keys:replace',
  inspectImport: 'import:inspect',
  applyImport: 'import:apply',
  clearImport: 'import:clear',
  scrubOldSecrets: 'import:scrub-secrets',
  getWallet: 'wallet:get',
  focusWallet: 'wallet:focus',
  createWallet: 'wallet:create',
  restoreWallet: 'wallet:restore',
  pickKeystore: 'wallet:pick-keystore',
  importKeystore: 'wallet:import-keystore',
  unlockWallet: 'wallet:unlock',
  copyText: 'launcher:copy-text',
  setSensitive: 'launcher:set-sensitive',
  // main -> renderer
  progress: 'evt:progress',
  procState: 'evt:proc-state',
  logs: 'evt:logs',
  nodeInfo: 'evt:node-info',
  wallet: 'evt:wallet',
  clientStats: 'evt:client-stats'
} as const
