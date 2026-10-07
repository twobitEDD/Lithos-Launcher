import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  MIN_PASSWORD_LENGTH,
  MNEMONIC_LENGTHS,
  type KeystorePick,
  type Network,
  type ProcState,
  type WalletFileInfo,
  type WalletPhase,
  type WalletState
} from '@shared/types'
import { addressForNetwork } from './address'
import { readNodeSettings } from './ergoConf'
import { keystoreFileName, readKeystore } from './keystore'
import { layout } from './layout'
import { walletSwitchRestartsNode } from '@shared/walletCycle'
import { firstScannableHeight } from '@shared/walletScan'
import { findKeystore } from './lithosClient'
import { NodeApi, type WalletStatus } from './nodeApi'
import {
  activateKeptWallet,
  addKeptKeystore,
  listWalletFiles,
  removeWalletOnNode,
  withActiveWalletSlot
} from './walletFiles'
import type { NodeConnection, NodeController } from './nodeController'
import { shareWalletAcrossNetworks } from './settings'
import { errorMessage } from './util'
import type { Vault } from './vault'

const POLL_MS = 10_000

const UNAVAILABLE: WalletState = {
  network: null,
  phase: 'unavailable',
  address: null,
  addressFromPeer: false,
  hasPeerWallet: false,
  keyMatch: null,
  passwordKnown: false,
  balanceNanoErg: null,
  walletHeight: null,
  error: null
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`)
  }
}

/** Lowercases, collapses whitespace and checks the word count. The node validates the checksum. */
function normalizeMnemonic(mnemonic: string): string {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!(MNEMONIC_LENGTHS as readonly number[]).includes(words.length)) {
    throw new Error(`A seed phrase has ${MNEMONIC_LENGTHS.join(', ')} words. This one has ${words.length}.`)
  }
  return words.join(' ')
}

function otherNetwork(network: Network): Network {
  return network === 'mainnet' ? 'testnet' : 'mainnet'
}

function phaseOf(s: WalletStatus): WalletPhase {
  return !s.isInitialized ? 'uninitialized' : s.isUnlocked ? 'unlocked' : 'locked'
}

/** Which of the two networks have a wallet keystore on disk. */
interface Keystores {
  own: boolean
  peer: boolean
}

/**
 * The node wallet the Lithos Client signs with. Unlocks it automatically on
 * every node start when the password is known. Emits 'state' (WalletState).
 */
export class WalletManager extends EventEmitter {
  private current: WalletState = UNAVAILABLE
  private pollToken = 0
  private refreshGen = 0
  private unlocking = false
  /** One automatic re-unlock per lock, per network; reset once that wallet is unlocked again. */
  private readonly relockTried: Partial<Record<Network, boolean>> = {}
  /** Keystore file the user picked, checked but not yet imported. Kept here so the renderer never names a path. */
  private pickedKeystore: string | null = null
  /** The node is restarting to load an imported keystore; the import does its own unlocking. */
  private importing: Network | null = null
  /** Copying the other network's keystore onto this one. */
  private linking = false
  /**
   * Network the wallet panel is showing: its reads and the panel's actions use this network's
   * node. The running node's wallet is kept unlocked whichever network this is.
   */
  private focused: Network | null = null
  /** One attempt per node session to scan from the first stored block instead of block 1. */
  private scanKick: 'idle' | 'running' | 'done' = 'idle'
  /** Stops the miner before a wallet swap restarts the node. Set once the client exists. */
  private pauseMining: () => Promise<void> = async () => {}

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly vault: Vault
  ) {
    super()
    node.on('ready', (network: Network) => void this.onNodeReady(network))
    node.proc.on('state', (s: ProcState) => {
      if (s.status !== 'running') void this.refresh()
    })
  }

  /** Follow the network selected in the UI. Reads that node's wallet, not the other one's. */
  async focus(network: Network): Promise<WalletState> {
    this.focused = network
    await this.maybeLinkPeerWallet(network)
    this.startPolling()
    await this.refresh()
    return this.current
  }

  /**
   * Re-applies share-wallet settings after the user toggles them: link a peer keystore when
   * sharing is on, and refresh so Create / peer hints match the new preference.
   */
  async applySharePreference(): Promise<WalletState> {
    if (this.focused) {
      await this.maybeLinkPeerWallet(this.focused)
      await this.refresh()
    }
    return this.current
  }

  get state(): WalletState {
    return this.current
  }

  /** The client is constructed after this manager, then wires its stop in here. */
  setPauseMining(pause: () => Promise<void>): void {
    this.pauseMining = pause
  }

  list(network: Network): Promise<WalletFileInfo[]> {
    return listWalletFiles(layout.walletDir(this.root, network))
  }

  async create(password: string, replaceExisting = false): Promise<string[]> {
    checkPassword(password)
    const conn = this.connection()
    const network = conn.network
    if (!replaceExisting) {
      const peer = otherNetwork(network)
      if (shareWalletAcrossNetworks() && (this.vault.getWalletKey(peer) || (await this.peerHasKeystore(network)))) {
        throw new Error('Use the same seed phrase as your other network. Creating a wallet here would make a different key.')
      }
    }
    try {
      const { value } = await withActiveWalletSlot({
        walletDir: layout.walletDir(this.root, network),
        replaceExisting,
        now: new Date(),
        doneLog: 'Wallet created',
        replacedLog: 'Wallet created. The previous wallet is kept on disk in previous-keystore.',
        log: (line) => this.node.proc.log(line),
        node: this.slot(network),
        run: async () => {
          const next = this.connection()
          return next.api.walletInit(next.apiKey, password)
        }
      })
      await this.vault.setWalletPassword(network, password, true)
      await this.ensureUnlocked(this.connection(), password)
      return value.trim().split(/\s+/)
    } finally {
      this.importing = null
    }
  }

  async restore(mnemonic: string, password: string, replaceExisting = false): Promise<void> {
    checkPassword(password)
    const phrase = normalizeMnemonic(mnemonic)
    const conn = this.connection()
    const network = conn.network
    try {
      await withActiveWalletSlot({
        walletDir: layout.walletDir(this.root, network),
        replaceExisting,
        now: new Date(),
        doneLog: 'Wallet restored from seed phrase',
        replacedLog: 'Wallet restored from seed phrase. The previous wallet is kept on disk in previous-keystore.',
        log: (line) => this.node.proc.log(line),
        node: this.slot(network),
        run: async () => {
          const next = this.connection()
          await next.api.walletRestore(next.apiKey, phrase, password)
        }
      })
      await this.vault.setWalletPassword(network, password, true)
      await this.ensureUnlocked(this.connection(), password)
    } finally {
      this.importing = null
    }
  }

  /** Copies a picked keystore onto the kept list. The active wallet and the original file stay put. */
  async addKept(network: Network): Promise<void> {
    const source = this.pickedKeystore
    if (!source) throw new Error('Choose a keystore file first')
    const text = await readKeystore(source)
    await addKeptKeystore(layout.walletDir(this.root, network), basename(source), text, new Date())
    this.pickedKeystore = null
    this.node.proc.log('Added a wallet to previous-keystore. The active wallet is unchanged.')
  }

  /** Moves a listed wallet aside. An active wallet restarts the node; the file is not deleted. */
  async remove(network: Network, file: string): Promise<void> {
    const runningHere = this.node.runningNetwork === network && this.node.proc.alive
    try {
      await removeWalletOnNode({
        walletDir: layout.walletDir(this.root, network),
        file,
        now: new Date(),
        nodeRunning: runningHere,
        stop: () => this.stopForWalletChange(network),
        start: () => this.node.start(network),
        afterActiveRemoved: () => this.vault.forgetWalletPassword(network)
      })
      this.node.proc.log('Moved a wallet file aside. It is still on disk and was not deleted.')
    } finally {
      this.importing = null
    }
  }

  /** Makes a kept wallet the active one. The previous active wallet stays in previous-keystore. */
  async useKept(network: Network, file: string): Promise<void> {
    const state = this.node.proc.state
    const restart = walletSwitchRestartsNode(
      { status: state.status, ownsProcess: this.node.proc.alive, network: state.network },
      network
    )
    try {
      await activateKeptWallet({
        walletDir: layout.walletDir(this.root, network),
        file,
        now: new Date(),
        nodeRunning: restart,
        stop: () => this.stopForWalletChange(network),
        start: () => this.node.start(network),
        beforeStart: () => this.vault.forgetWalletPassword(network)
      })
      this.node.proc.log('Switched the active wallet. The previous wallet is kept on disk in previous-keystore.')
    } finally {
      this.importing = null
    }
  }

  private slot(network: Network): {
    isInitialized: () => Promise<boolean>
    stop: () => Promise<void>
    start: () => Promise<void>
  } {
    return {
      isInitialized: async () => (await this.connection().api.walletStatus(this.connection().apiKey)).isInitialized,
      stop: () => this.stopForWalletChange(network),
      start: () => this.node.start(network)
    }
  }

  private async stopForWalletChange(network: Network): Promise<void> {
    await this.pauseMining()
    this.importing = network
    await this.node.stopForWalletSwitch(network)
  }

  /** Remembers a keystore file the user picked, once it looks like one. */
  async pickKeystore(path: string): Promise<KeystorePick> {
    await readKeystore(path)
    this.pickedKeystore = path
    return { name: basename(path), folder: dirname(path) }
  }

  /**
   * Uses an existing node keystore as this node's wallet. The node reads its keystore folder only
   * at startup, so the file is copied in and the node restarted; the node then checks the password
   * by unlocking. If that fails, the copy is removed and the node restarted without it.
   */
  async importKeystore(password: string): Promise<void> {
    if (!password) throw new Error('Enter the password this keystore was created with')
    const source = this.pickedKeystore
    if (!source) throw new Error('Choose a keystore file first')
    const conn = this.connection()
    const network = conn.network
    if ((await conn.api.walletStatus(conn.apiKey)).isInitialized) throw new Error('This node already has a wallet')
    const dir = layout.keystoreDir(this.root, network)
    // The node loads the first file it finds there, so the folder has to start out empty.
    if ((await readdir(dir).catch(() => [])).length) throw new Error(`The node's keystore folder isn't empty: ${dir}`)

    // Read and check it again, and write exactly what was checked.
    const text = await readKeystore(source)
    const target = join(dir, keystoreFileName(source))
    await mkdir(dir, { recursive: true })
    await writeFile(target, text, { flag: 'wx', mode: 0o600 })
    this.node.proc.log(`Keystore copied to ${target}. Restarting the node to load it.`)

    this.importing = network
    try {
      try {
        await this.node.stop()
        await this.node.start(network)
      } catch (err) {
        await rm(target, { force: true })
        throw err
      }
      if (!(await this.tryUnlock(this.connection(), password))) {
        this.node.proc.log('The keystore did not unlock. Removing the copy and restarting the node without it.')
        await this.node.stop()
        await rm(target, { force: true })
        this.importing = null
        // A failed start shows on the node card; the password is what the user needs to hear about.
        await this.node.start(network).catch(() => undefined)
        throw new Error('That password did not unlock the keystore, so it was not added. Your file is unchanged.')
      }
    } finally {
      this.importing = null
    }

    this.pickedKeystore = null
    await this.vault.setWalletPassword(network, password, true)
    this.node.proc.log('Wallet loaded from the keystore file')
    // Blocks the node scanned between loading the keystore and unlocking it were checked against no
    // keys. Scan again now that it knows them, so the balance and history are complete.
    const after = this.connection()
    const height = (await after.api.walletStatus(after.apiKey)).walletHeight ?? 0
    if (height > 0) {
      const from = await this.scannableHeight(after)
      if (from !== null) {
        await after.api.walletRescan(after.apiKey, from)
        this.node.proc.log("Rescanning the chain for this wallet's past transactions")
      }
    }
    await this.refresh()
  }

  async unlock(password: string, remember: boolean): Promise<void> {
    const conn = this.connection()
    if (!(await this.tryUnlock(conn, password))) throw new Error(this.current.error ?? 'The wallet did not unlock')
    await this.vault.setWalletPassword(conn.network, password, remember)
    await this.refresh()
  }

  /**
   * Checks the node wallet through the API right now and unlocks it if needed. The Lithos
   * Client relies on an unlocked node wallet: emission joins derive new keys through it, and
   * the node's candidate generation may not start without it.
   */
  async unlockForClient(network: Network): Promise<void> {
    // The running node, whichever network the wallet panel shows.
    const conn = this.node.connection()
    if (conn?.network !== network) throw new Error(`Start the ${network} node first`)
    const status = await conn.api.walletStatus(conn.apiKey)
    if (!status.isInitialized) throw new Error('Create or restore the wallet first')
    if (status.isUnlocked) return
    const password = this.vault.getWalletPassword(network)
    if (!password) throw new Error('Unlock the wallet first')
    if (!(await this.tryUnlock(conn, password))) throw new Error('The saved password did not unlock the wallet')
  }

  /** Wallet writes go to the node this launcher started for the selected network. */
  private connection(): NodeConnection {
    const conn = this.node.connection()
    if (!this.focused || conn?.network !== this.focused) {
      throw new Error(`Start the ${this.focused ?? 'selected'} node first`)
    }
    return conn
  }

  /**
   * Wallet reads for `network`: the node this launcher started, or one already
   * listening on that network's configured API port with the stored API key.
   */
  private async endpoint(network: Network): Promise<NodeConnection | null> {
    const managed = this.node.connection()
    if (managed?.network === network) return managed
    const key = this.vault.getNodeKey(network)?.key
    if (!key) return null
    const api = new NodeApi((await readNodeSettings(this.root, network)).apiPort)
    if (!(await api.accepts(key).catch(() => false))) return null
    return { api, apiKey: key, network }
  }

  private async onNodeReady(network: Network): Promise<void> {
    // The client needs the running node's wallet unlocked, whichever network the panel shows.
    await this.autoUnlock(network)
    if (this.focused === network) await this.maybeLinkPeerWallet(network)
    await this.refresh()
    this.startPolling()
  }

  /** Unlocks the running node's wallet when its password is already known. */
  private async autoUnlock(network: Network): Promise<void> {
    const conn = this.node.connection()
    if (conn?.network !== network || this.importing === network) return
    const saved = this.vault.getWalletPassword(network)
    // This start-up unlock counts as the one automatic attempt for this lock.
    this.relockTried[network] = saved !== null
    if (!saved) return
    // With a known password, go straight to unlocking so the UI never flashes a password form.
    try {
      const s = await conn.api.walletStatus(conn.apiKey)
      if (s.isInitialized && !s.isUnlocked && !(await this.tryUnlock(conn, saved)) && this.focused === network) {
        this.set({ ...this.current, error: 'The saved password did not unlock the wallet. Enter it again.' })
      }
    } catch {
      // fall through to a normal refresh
    }
  }

  /**
   * When sharing is on, this network has no wallet yet, and the other network does, copy that
   * keystore and unlock it with the known password so the same mining key is used on both.
   */
  private async maybeLinkPeerWallet(network: Network): Promise<void> {
    if (!shareWalletAcrossNetworks() || this.linking || this.importing || this.focused !== network) return
    const conn = this.node.connection()
    if (conn?.network !== network) return
    try {
      if ((await conn.api.walletStatus(conn.apiKey)).isInitialized) return
    } catch {
      return
    }
    const peer = otherNetwork(network)
    const peerKeystore = await findKeystore(layout.keystoreDir(this.root, peer))
    if (!peerKeystore) return
    const password = this.vault.getWalletPassword(peer) ?? this.vault.getWalletPassword(network)
    if (!password) return

    this.linking = true
    this.pickedKeystore = peerKeystore
    try {
      this.node.proc.log(`Reusing the ${peer} wallet keystore on ${network}`)
      await this.importKeystore(password)
    } catch (err) {
      this.pickedKeystore = null
      this.node.proc.log(`Could not reuse the ${peer} keystore: ${errorMessage(err)}`)
    } finally {
      this.linking = false
    }
  }

  private async peerHasKeystore(network: Network): Promise<boolean> {
    return (await findKeystore(layout.keystoreDir(this.root, otherNetwork(network)))) !== null
  }

  /** Newly created/restored wallets may already be unlocked; unlock only if needed. */
  private async ensureUnlocked(conn: NodeConnection, password: string): Promise<void> {
    await this.refresh()
    if (this.current.phase === 'locked') await this.tryUnlock(conn, password)
  }

  /**
   * Unlocks `conn`'s wallet and says whether the node took the password. The panel shows the
   * progress only when it's showing that network.
   */
  private async tryUnlock(conn: NodeConnection, password: string): Promise<boolean> {
    const shown = conn.network === this.focused
    this.unlocking = true
    if (shown) this.set({ ...this.current, phase: 'unlocking', error: null })
    try {
      await conn.api.walletUnlock(conn.apiKey, password)
      this.node.proc.log('Wallet unlocked')
    } catch (err) {
      this.node.proc.log(`Wallet unlock failed: ${errorMessage(err)}`)
      if (shown) this.set({ ...this.current, phase: 'locked', error: 'That password did not unlock the wallet.' })
      return false
    } finally {
      this.unlocking = false
    }
    await this.refresh()
    return true
  }

  private async keystores(network: Network): Promise<Keystores> {
    const [own, peer] = await Promise.all([
      findKeystore(layout.keystoreDir(this.root, network)),
      findKeystore(layout.keystoreDir(this.root, otherNetwork(network)))
    ])
    return { own: own !== null, peer: peer !== null }
  }

  /** The address remembered for `network`'s own wallet, while its keystore is still on disk. */
  private remembered(network: Network, keystores: Keystores): string | null {
    return keystores.own ? (this.vault.getWalletKey(network)?.address ?? null) : null
  }

  /** Records the address a node reports for its own wallet, with the public key the node reads from it. */
  private async rememberKey(conn: NodeConnection, address: string): Promise<void> {
    if (this.vault.getWalletKey(conn.network)?.address === address) return
    try {
      await this.vault.setWalletKey(conn.network, { address, pubKey: await conn.api.addressToRaw(address) })
    } catch {
      // Not a P2PK address, or the node is busy: try again on the next refresh.
    }
  }

  /**
   * With sharing on and no wallet on `network` yet, the other network's key as a `network` address:
   * the address that wallet gets here once the same seed or keystore is used.
   */
  private peerAddress(network: Network, keystores: Keystores): string | null {
    const peer = this.vault.getWalletKey(otherNetwork(network))
    if (!shareWalletAcrossNetworks() || keystores.own || !keystores.peer || !peer) return null
    return addressForNetwork(peer.address, network)
  }

  /** What to show while `network`'s node can't be read: its own remembered address, else the shared key's. */
  private offlineAddress(network: Network, keystores: Keystores): Pick<WalletState, 'address' | 'addressFromPeer'> {
    const own = this.remembered(network, keystores)
    if (own) return { address: own, addressFromPeer: false }
    const peer = this.peerAddress(network, keystores)
    return { address: peer, addressFromPeer: peer !== null }
  }

  private async refresh(): Promise<void> {
    if (this.unlocking || !this.focused) return
    const network = this.focused
    const gen = ++this.refreshGen
    const stale = (): boolean => gen !== this.refreshGen || this.unlocking || this.focused !== network
    const keystores = await this.keystores(network)
    if (stale()) return
    const conn = await this.endpoint(network)
    if (stale()) return
    if (!conn) {
      this.scanKick = 'idle'
      this.publish(network, keystores, {
        phase: 'unavailable',
        ...this.offlineAddress(network, keystores),
        balanceNanoErg: null,
        walletHeight: null,
        error: null
      })
      return
    }
    try {
      const s = await conn.api.walletStatus(conn.apiKey)
      if (stale()) return
      const phase = phaseOf(s)
      if (s.changeAddress) await this.rememberKey(conn, s.changeAddress)
      // A node with a wallet shows only its own key; the shared key is offered to one without.
      const shown = s.changeAddress
        ? { address: s.changeAddress, addressFromPeer: false }
        : phase === 'uninitialized'
          ? this.offlineAddress(network, keystores)
          : { address: this.remembered(network, keystores), addressFromPeer: false }
      let balanceNanoErg: number | null = null
      if (s.isUnlocked) {
        try {
          balanceNanoErg = await conn.api.walletBalance(conn.apiKey)
        } catch {
          // Keep the last reading only when it already came from this network.
          balanceNanoErg = this.current.network === network ? this.current.balanceNanoErg : null
        }
      }
      if (stale()) return
      this.publish(network, keystores, {
        phase,
        ...shown,
        balanceNanoErg,
        walletHeight: typeof s.walletHeight === 'number' ? s.walletHeight : null,
        error: phase === 'locked' && this.current.network === network ? this.current.error : null
      })
      // Only the node this launcher runs; a node left running elsewhere isn't ours to unlock.
      if (this.node.connection()?.network === network) await this.relockGuard(conn, phase)
      if (phase === 'unlocked' && (typeof s.walletHeight !== 'number' || s.walletHeight === 0)) {
        await this.kickScanFromStoredBlocks(conn)
      }
    } catch {
      // Node busy. Drop the other network's figures rather than keep showing them.
      if (!stale() && this.current.network !== network) {
        this.publish(network, keystores, {
          phase: 'unavailable',
          ...this.offlineAddress(network, keystores),
          balanceNanoErg: null,
          walletHeight: null,
          error: null
        })
      }
    }
  }

  private publish(
    network: Network,
    keystores: Keystores,
    patch: Pick<WalletState, 'phase' | 'address' | 'addressFromPeer' | 'balanceNanoErg' | 'walletHeight' | 'error'>
  ): void {
    const sharing = shareWalletAcrossNetworks()
    const mine = keystores.own ? this.vault.getWalletKey(network) : null
    const peer = keystores.peer ? this.vault.getWalletKey(otherNetwork(network)) : null
    this.set({
      network,
      phase: patch.phase,
      address: patch.address,
      addressFromPeer: patch.addressFromPeer,
      hasPeerWallet: sharing && keystores.peer,
      keyMatch: sharing && mine && peer ? (mine.pubKey === peer.pubKey ? 'same' : 'different') : null,
      passwordKnown: this.vault.getWalletPassword(network) !== null,
      balanceNanoErg: patch.balanceNanoErg,
      walletHeight: patch.walletHeight,
      error: patch.error
    })
  }

  /** Block height the wallet can scan from, or null when the tip is not stored. */
  private async scannableHeight(conn: NodeConnection): Promise<number | null> {
    const info = await conn.api.info()
    const fullHeight = info.fullHeight
    if (typeof fullHeight !== 'number') return null
    return firstScannableHeight(fullHeight, async (height) => (await conn.api.blockIdsAt(height)).length > 0)
  }

  /**
   * The node scans from block 1. When those blocks were never stored, that scan stays at
   * height 0. Ask once for a rescan from the first block this node does have.
   */
  private async kickScanFromStoredBlocks(conn: NodeConnection): Promise<void> {
    if (this.scanKick !== 'idle') return
    this.scanKick = 'running'
    try {
      const from = await this.scannableHeight(conn)
      if (from === null || from <= 1) {
        this.scanKick = 'done'
        return
      }
      await conn.api.walletRescan(conn.apiKey, from)
      this.node.proc.log(`Earlier blocks are not on this node. Scanning this wallet from block ${from}.`)
      this.scanKick = 'done'
    } catch (err) {
      this.scanKick = 'done'
      this.node.proc.log(`Could not start the wallet scan from the stored blocks: ${errorMessage(err)}`)
    }
  }

  /**
   * The Lithos Client needs the node wallet unlocked the whole time it runs. If it becomes
   * locked (e.g. through the node panel), unlock it again once with the known password; a
   * failed attempt waits for the user instead of retrying every poll.
   */
  private async relockGuard(conn: NodeConnection, phase: WalletPhase): Promise<void> {
    const network = conn.network
    if (phase === 'unlocked') {
      this.relockTried[network] = false
      return
    }
    const password = this.vault.getWalletPassword(network)
    if (phase !== 'locked' || !password || this.relockTried[network] || this.importing === network) return
    this.relockTried[network] = true
    this.node.proc.log('The node wallet was locked; unlocking it again')
    await this.tryUnlock(conn, password)
  }

  /**
   * While the panel shows the other network, refresh() doesn't read the running node, so its
   * wallet gets the same relock check here.
   */
  private async guardRunning(): Promise<void> {
    const conn = this.node.connection()
    if (!conn || conn.network === this.focused || this.unlocking) return
    try {
      await this.relockGuard(conn, phaseOf(await conn.api.walletStatus(conn.apiKey)))
    } catch {
      // Node busy; check again on the next poll.
    }
  }

  private startPolling(): void {
    const token = ++this.pollToken
    const tick = async (): Promise<void> => {
      if (token !== this.pollToken) return
      await this.refresh()
      await this.guardRunning()
      if (token === this.pollToken) setTimeout(tick, POLL_MS)
    }
    setTimeout(tick, POLL_MS)
  }

  private set(next: WalletState): void {
    const prev = this.current
    this.current = next
    if (JSON.stringify(prev) !== JSON.stringify(next)) this.emit('state', next)
  }
}
