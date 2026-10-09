// Types and channel names shared by the main process, preload and renderer.
// This file must stay free of Node and DOM imports.

import type { LanPeerStatus } from './lanPeers'
import type { PayoutProof } from './payout'
import type { MinerState } from './soatMiner'
import type { NodeAutoStartResult } from './nodeAutoStart'

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

/** One connected Ergo peer, as the sync-details panel shows it. */
export interface SyncPeerRow {
  /** host:port with no leading slash. */
  address: string
  host: string
  lan: boolean
  direction: 'incoming' | 'outgoing' | null
  remoteHeight: number | null
  /**
   * First full-block height this peer reports keeping.
   * 1 means it reports blocks from the start. Null when the node did not say.
   */
  historyFrom: number | null
  /** Peer reported fullBlocksSuffix 0: it keeps headers only. */
  keepsNoFullBlocks: boolean
  /** Raw mode.fullBlocksSuffix. -1 means the peer says it keeps the whole chain. */
  fullBlocksSuffix: number | null
  /** True only when trackInfo shows a block body received from this peer. Null if trackInfo was not read. */
  sendingBlocks: boolean | null
  /** A block body was requested from this peer and none is in the received set yet. */
  blockRequested: boolean
}

/**
 * Why a block download can take days even when LAN peers are connected.
 * Filled from /info plus /peers/syncInfo, /peers/connected, and /peers/trackInfo.
 */
export interface NodeSyncDetails {
  headersHeight: number | null
  fullHeight: number | null
  /** Chain height still not stored as full blocks. Null when the node has not reported a target. */
  blocksRemaining: number | null
  peers: SyncPeerRow[]
  /**
   * Plain reason local peers are not supplying the missing early chain.
   * Does not claim anyone is sending blocks unless trackInfo says so.
   */
  lanNote: string | null
  /**
   * No connected LAN peer has reported the blocks this node still needs,
   * so a countdown is this node's own sync.
   */
  etaIsNodeSync: boolean
  /** False when the peer list could not be read. An empty list then means nothing, not "no peers". */
  peersKnown: boolean
  /** False when /peers/trackInfo could not be read. Traffic is then left unstated. */
  trackKnown: boolean
}

export interface NodeInfo {
  appVersion: string | null
  fullHeight: number | null
  headersHeight: number | null
  maxPeerHeight: number | null
  peersCount: number
  indexedHeight: number | null
  /** Present on every poll. Explains a long block download. */
  syncDetails: NodeSyncDetails
}

export type WalletPhase = 'unavailable' | 'uninitialized' | 'locked' | 'unlocking' | 'unlocked'

export interface WalletState {
  /** The network the wallet panel shows (its node may not be running), or null before one is picked. */
  network: Network | null
  phase: WalletPhase
  /**
   * The mining address on `network` (mainnet starts with 9, testnet with 3): its node's own, or
   * the one remembered for it while its keystore is still there. With sharing on and no wallet on
   * `network` yet, the other network's key as a `network` address (see addressFromPeer). Not a seed.
   */
  address: string | null
  /** `address` is the other network's key: `network` has no wallet of its own yet. */
  addressFromPeer: boolean
  /**
   * Sharing is on and the other network has a node keystore. Creating a new wallet here would make
   * a different key; restore or reuse instead.
   */
  hasPeerWallet: boolean
  /**
   * With sharing on and both networks' wallets known: whether they use one key. 'different' means
   * sharing can't apply, and each network keeps its own wallet. Null otherwise.
   */
  keyMatch: 'same' | 'different' | null
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

/**
 * A wallet file on this node. `active` is the one the node loads; `kept` sits in
 * previous-keystore and is not used for mining until it is made active.
 * Names only: the renderer never receives a filesystem path.
 * `address` is this keystore's public address, remembered when the node reported it.
 */
export interface WalletFileInfo {
  file: string
  role: 'active' | 'kept'
  label: string
  savedAt: number
  /** Public address for this keystore. Null until the node has reported it. */
  address: string | null
}

/** Node settings the launcher manages in ergo.conf. */
export interface NodeSettings {
  /** ergo.node.offlineGeneration: hand out mining work right after a restart, without waiting for a block. */
  offlineGeneration: boolean
  /** scorex.restApi.bindAddress port; defaults are Ergo's 9053 (mainnet) / 9052 (testnet). */
  apiPort: number
  /** scorex.network.bindAddress port; defaults are Ergo's 9030 (mainnet) / 9023 (testnet). */
  p2pPort: number
}

export type NodeSettingsPatch = Partial<NodeSettings>

/** The Ergo node's own defaults: its mainnet.conf turns offline generation on, testnet leaves it off. */
export const DEFAULT_OFFLINE_GENERATION: Record<Network, boolean> = { mainnet: true, testnet: false }

/** Ergo's default REST API ports (mainnet.conf / testnet.conf in the node jar). */
export const DEFAULT_NODE_API_PORT: Record<Network, number> = { mainnet: 9053, testnet: 9052 }

/** Ergo's default peer-to-peer ports. */
export const DEFAULT_NODE_P2P_PORT: Record<Network, number> = { mainnet: 9030, testnet: 9023 }

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

/** Live figures from the running client's open stats endpoints. */
export interface ClientStats {
  stratumStatus: string | null
  rigs: number
  hashesPerSecond: number | null
  superShares: number
  superSharesPerHour: number | null
  forcedConfig: boolean
  /** Chain height from the client's /info, when that call answered. */
  chainHeight: number | null
  /**
   * Unpaid proofs. Null when the client has not reported any (payments API down and no proof log).
   * An empty list means none are outstanding.
   */
  payoutProofs: PayoutProof[] | null
  /**
   * Log-derived proofs are dropped once the chain passes their payout height. Claims from
   * /stats/mining/payments stay until the client says they paid.
   */
  payoutSettleAtHeight: boolean
}

/**
 * This miner's difficulty commitment as the Lithos Client last read it from the chain; scores are
 * integer strings. Kept per network for the session, so it still shows after the client stops.
 */
export interface CommitmentRead {
  /** The score NISPs are judged against now; null until any commitment has taken effect. */
  committed: string | null
  /** A newer commitment still waiting to take effect, at `pendingFromHeight`. */
  pending: string | null
  pendingFromHeight: number | null
  /** The chain height the client read it at; null on clients that don't report it. */
  checkedHeight: number | null
}

export type CommitmentReads = Partial<Record<Network, CommitmentRead>>

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
  /**
   * One mining key on mainnet and testnet (same seed; addresses rewrite 9… ↔ 3…).
   * Off by default so testnet can keep a separate, less-trusted wallet.
   */
  shareWalletAcrossNetworks: boolean
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

/** A Lithos launcher already serving stratum on this LAN. Null when this computer should run its own. */
export interface RemoteLauncher {
  host: string
  port: number
}

export interface AppInfo {
  vault: VaultInfo
  /** Development only: allow starting the client before the node is synced. */
  skipSyncGate: boolean
  /** This machine's LAN IPv4 addresses, for pointing mining rigs at the stratum port. */
  lanAddresses: string[]
  platform: 'win32' | 'linux' | 'darwin' | string
  /** False when Chromium's OS sandbox is off (the AppImage's --no-sandbox fallback). */
  sandboxed: boolean
  /** Running from an AppImage, where the .deb is the sandboxed alternative. */
  appImage: boolean
  /** One mining key across networks when true; see LauncherInfo.shareWalletAcrossNetworks. */
  shareWalletAcrossNetworks: boolean
  /** Set when startup found another launcher and this one will not start a node or stratum. */
  remoteLauncher: RemoteLauncher | null
  /** Addresses of launchers the user chose to ignore. Not secrets. */
  ignoredLaunchers: string[]
  /** Start the node when the launcher opens (on unless turned off). */
  autoStartNode: boolean
}

export interface LauncherApi {
  getState(network: Network): Promise<NetworkState>
  getAppInfo(): Promise<AppInfo>
  /**
   * Ignore the other machine's launcher and allow a node on this computer.
   * Returns the remembered addresses. Does not shut the other machine down.
   */
  useLocalLauncher(): Promise<string[]>
  /** Defer to other launchers again. Does not stop a node on this computer. */
  useRemoteLauncher(): Promise<string[]>
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
  /** Starts or adopts the node when the launcher opens, at most once per launcher run. */
  autoStartNode(network: Network): Promise<NodeAutoStartResult>
  /** Saves "Start node automatically when the launcher opens" and returns it. */
  setAutoStartNode(on: boolean): Promise<boolean>
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
  /** Commitments the client has read this session, by network. */
  getCommitments(): Promise<CommitmentReads>
  getNodeSettings(network: Network): Promise<NodeSettings>
  /** Saves to ergo.conf. The node picks changes up on its next start. */
  setNodeSettings(network: Network, patch: NodeSettingsPatch): Promise<NodeSettings>
  getSystemCheck(network: Network): Promise<SystemCheck>
  openLink(name: LinkName): Promise<void>
  getLauncherInfo(): Promise<LauncherInfo>
  /** null resets a size to automatic. Takes effect on the next start. */
  setHeap(heap: { nodeMb: number | null; clientMb: number | null }): Promise<LauncherInfo>
  /**
   * One mining key on both networks when true; separate keys when false.
   * Turning it on may copy the other network's keystore onto an empty node.
   */
  setShareWalletAcrossNetworks(on: boolean): Promise<LauncherInfo>
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
  /** Wallet files for this network: one active, any others kept on disk. */
  listWallets(network: Network): Promise<WalletFileInfo[]>
  /**
   * Creates the node wallet and returns its seed words. They are shown once and never stored.
   * `replaceExisting` sets the current keystore aside (it stays on disk) before creating.
   */
  createWallet(password: string, replaceExisting?: boolean): Promise<string[]>
  restoreWallet(mnemonic: string, password: string, replaceExisting?: boolean): Promise<void>
  /** Copies the picked keystore onto the kept list. Does not change the active wallet. */
  addWallet(network: Network): Promise<void>
  /** Moves a listed wallet file aside. The bytes stay on disk. */
  removeWallet(network: Network, file: string): Promise<void>
  /** Makes a kept wallet the one active wallet. The previous active wallet stays on disk. */
  useWallet(network: Network, file: string): Promise<void>
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
  /** Hides the window from screenshots/screen recording while secrets are on screen (not on Linux). */
  setSensitive(on: boolean): Promise<void>
  /** Stops the node and client safely and quits; asks first if either is running. */
  quit(): Promise<void>
  onProgress(cb: (p: TaskProgress) => void): () => void
  onProcState(cb: (s: ProcState) => void): () => void
  onLogs(cb: (chunk: LogChunk) => void): () => void
  onNodeInfo(cb: (info: NodeInfo | null) => void): () => void
  onWallet(cb: (w: WalletState) => void): () => void
  onClientStats(cb: (s: ClientStats | null) => void): () => void
  onCommitments(cb: (c: CommitmentReads) => void): () => void
  onRemoteLauncher(cb: (remote: RemoteLauncher | null) => void): () => void
  /** Other Ergo nodes on this LAN. Separate from stratum launcher deferral. */
  getLanPeers(): Promise<LanPeerStatus>
  /** Turn LAN peering on or off. Off does not stop the node. */
  setLanPeering(on: boolean): Promise<LanPeerStatus>
  onLanPeers(cb: (status: LanPeerStatus) => void): () => void
  /** The SOAT miner on this computer's GPU, run by the background SOAT service. */
  getMiner(): Promise<MinerState>
  /** Starts now (downloading SOAT first if needed); waits for the node and client if they are not ready. */
  startMiner(): Promise<MinerState>
  stopMiner(): Promise<MinerState>
  /** Saved by the service (and in launcher.json). On also starts the miner. */
  setMinerAutoStart(on: boolean): Promise<MinerState>
  /** Stops and disables the old soat-*.service setup and enables the Lithos SOAT service. */
  switchMinerService(): Promise<MinerState>
  onMiner(cb: (state: MinerState) => void): () => void
}

export const IPC = {
  getState: 'launcher:get-state',
  getAppInfo: 'launcher:get-app-info',
  useLocalLauncher: 'launcher:use-local',
  useRemoteLauncher: 'launcher:use-remote',
  install: 'launcher:install',
  getReleases: 'versions:list',
  useVersion: 'versions:use',
  startNode: 'node:start',
  autoStartNode: 'node:auto-start',
  setAutoStartNode: 'node:set-auto-start',
  stopNode: 'node:stop',
  getProc: 'proc:get',
  getLogs: 'proc:get-logs',
  getNodeInfo: 'node:get-info',
  getLanPeers: 'node:lan-peers',
  setLanPeering: 'node:set-lan-peering',
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
  getCommitments: 'client:get-commitments',
  getNodeSettings: 'node:get-settings',
  setNodeSettings: 'node:set-settings',
  getSystemCheck: 'launcher:system-check',
  openLink: 'launcher:open-link',
  getLauncherInfo: 'launcher:get-info',
  setHeap: 'launcher:set-heap',
  setShareWalletAcrossNetworks: 'launcher:set-share-wallet',
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
  listWallets: 'wallet:list',
  createWallet: 'wallet:create',
  restoreWallet: 'wallet:restore',
  addWallet: 'wallet:add',
  removeWallet: 'wallet:remove',
  useWallet: 'wallet:use',
  pickKeystore: 'wallet:pick-keystore',
  importKeystore: 'wallet:import-keystore',
  unlockWallet: 'wallet:unlock',
  copyText: 'launcher:copy-text',
  setSensitive: 'launcher:set-sensitive',
  quit: 'launcher:quit',
  getMiner: 'miner:get',
  startMiner: 'miner:start',
  stopMiner: 'miner:stop',
  setMinerAutoStart: 'miner:set-auto-start',
  switchMinerService: 'miner:switch-service',
  // main -> renderer
  progress: 'evt:progress',
  procState: 'evt:proc-state',
  logs: 'evt:logs',
  nodeInfo: 'evt:node-info',
  wallet: 'evt:wallet',
  clientStats: 'evt:client-stats',
  commitments: 'evt:commitments',
  remoteLauncher: 'evt:remote-launcher',
  lanPeers: 'evt:lan-peers',
  miner: 'evt:miner'
} as const
