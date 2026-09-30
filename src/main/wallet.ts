import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { addressForNetwork, p2pkContent } from '@shared/address'
import {
  MIN_PASSWORD_LENGTH,
  MNEMONIC_LENGTHS,
  type KeystorePick,
  type Network,
  type ProcState,
  type WalletPhase,
  type WalletState
} from '@shared/types'
import { readNodeSettings } from './ergoConf'
import { keystoreFileName, readKeystore } from './keystore'
import { layout } from './layout'
import { findKeystore } from './lithosClient'
import { NodeApi } from './nodeApi'
import type { NodeConnection, NodeController } from './nodeController'
import { errorMessage } from './util'
import type { Vault } from './vault'

const POLL_MS = 10_000

const UNAVAILABLE: WalletState = {
  network: null,
  phase: 'unavailable',
  address: null,
  hasPeerWallet: false,
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

/**
 * The node wallet the Lithos Client signs with. Unlocks it automatically on
 * every node start when the password is known. Emits 'state' (WalletState).
 */
export class WalletManager extends EventEmitter {
  private current: WalletState = UNAVAILABLE
  private pollToken = 0
  private refreshGen = 0
  private unlocking = false
  /** One automatic re-unlock per lock; reset once the wallet is unlocked again. */
  private relockTried = false
  /** Keystore file the user picked, checked but not yet imported. Kept here so the renderer never names a path. */
  private pickedKeystore: string | null = null
  /** The node is restarting to load an imported keystore; the import does its own unlocking. */
  private importing: Network | null = null
  /** Copying the other network's keystore onto this one. */
  private linking = false
  /** Network the wallet panel is showing. Wallet API calls use this network's node. */
  private focused: Network | null = null
  /**
   * Last P2PK address read from a node (or restored from the vault). The same key is encoded for
   * the other network; the seed is never kept here.
   */
  private knownAddress: string | null
  /** Other network has a keystore on disk; refreshed when publishing wallet state. */
  private peerWallet = false

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly vault: Vault
  ) {
    super()
    this.knownAddress = vault.getMiningAddress()
    node.on('ready', (network: Network) => void this.onNodeReady(network))
    node.proc.on('state', (s: ProcState) => {
      if (s.status !== 'running') void this.refresh()
    })
  }

  /** Follow the network selected in the UI. Reads that node's wallet, not the other one's. */
  async focus(network: Network): Promise<WalletState> {
    if (this.focused !== network) this.relockTried = false
    this.focused = network
    await this.autoUnlock(network)
    await this.maybeLinkPeerWallet(network)
    this.startPolling()
    await this.refresh()
    return this.current
  }

  get state(): WalletState {
    return this.current
  }

  async create(password: string): Promise<string[]> {
    checkPassword(password)
    const conn = this.connection()
    if ((await conn.api.walletStatus(conn.apiKey)).isInitialized) throw new Error('This node already has a wallet')
    if (this.knownAddress || (await this.peerHasKeystore(conn.network))) {
      throw new Error('Use the same seed phrase as your other network. Creating a wallet here would make a different key.')
    }
    const mnemonic = await conn.api.walletInit(conn.apiKey, password)
    await this.vault.setWalletPassword(conn.network, password, true)
    this.node.proc.log('Wallet created')
    await this.ensureUnlocked(conn, password)
    return mnemonic.trim().split(/\s+/)
  }

  async restore(mnemonic: string, password: string): Promise<void> {
    checkPassword(password)
    const phrase = normalizeMnemonic(mnemonic)
    const conn = this.connection()
    if ((await conn.api.walletStatus(conn.apiKey)).isInitialized) throw new Error('This node already has a wallet')
    await conn.api.walletRestore(conn.apiKey, phrase, password)
    await this.vault.setWalletPassword(conn.network, password, true)
    this.node.proc.log('Wallet restored from seed phrase')
    await this.ensureUnlocked(conn, password)
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
      await this.tryUnlock(this.connection(), password)
      if (this.current.phase !== 'unlocked') {
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
    if (((await after.api.walletStatus(after.apiKey)).walletHeight ?? 0) > 0) {
      await after.api.walletRescan(after.apiKey, 0)
      this.node.proc.log("Rescanning the chain for this wallet's past transactions")
    }
    await this.refresh()
  }

  async unlock(password: string, remember: boolean): Promise<void> {
    const conn = this.connection()
    await this.tryUnlock(conn, password)
    if (this.current.phase !== 'unlocked') throw new Error(this.current.error ?? 'The wallet did not unlock')
    await this.vault.setWalletPassword(conn.network, password, remember)
    await this.refresh()
  }

  /**
   * Checks the node wallet through the API right now and unlocks it if needed. The Lithos
   * Client relies on an unlocked node wallet: emission joins derive new keys through it, and
   * the node's candidate generation may not start without it.
   */
  async unlockForClient(network: Network): Promise<void> {
    const conn = this.connection()
    if (conn.network !== network) throw new Error(`Start the ${network} node first`)
    const status = await conn.api.walletStatus(conn.apiKey)
    if (!status.isInitialized) throw new Error('Create or restore the wallet first')
    if (status.isUnlocked) return
    const password = this.vault.getWalletPassword(network)
    if (!password) throw new Error('Unlock the wallet first')
    await this.tryUnlock(conn, password)
    if (this.current.phase !== 'unlocked') throw new Error(this.current.error ?? 'The wallet did not unlock')
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
    const { apiPort } = await readNodeSettings(this.root, network)
    const api = new NodeApi(apiPort)
    if (!(await api.accepts(key).catch(() => false))) return null
    return { api, apiKey: key, network }
  }

  private async onNodeReady(network: Network): Promise<void> {
    if (this.focused === network) {
      await this.autoUnlock(network)
      await this.maybeLinkPeerWallet(network)
    }
    await this.refresh()
    this.startPolling()
  }

  /** Unlocks the selected network's node when its password is already known. */
  private async autoUnlock(network: Network): Promise<void> {
    const conn = this.node.connection()
    if (conn?.network !== network || this.importing === network) return
    const saved = this.vault.getWalletPassword(network)
    // This start-up unlock counts as the one automatic attempt for this lock.
    this.relockTried = saved !== null
    if (!saved) return
    // With a known password, go straight to unlocking so the UI never flashes a password form.
    try {
      const s = await conn.api.walletStatus(conn.apiKey)
      if (s.isInitialized && !s.isUnlocked) {
        await this.tryUnlock(conn, saved)
        if (this.current.phase === 'locked' && this.current.network === network) {
          this.set({ ...this.current, error: 'The saved password did not unlock the wallet. Enter it again.' })
        }
      }
    } catch {
      // fall through to a normal refresh
    }
  }

  /**
   * When this network has no wallet yet but the other network does, copy that keystore and unlock
   * it with the known password so the same mining key is used on both networks.
   */
  private async maybeLinkPeerWallet(network: Network): Promise<void> {
    if (this.linking || this.importing || this.focused !== network) return
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

  private async tryUnlock(conn: NodeConnection, password: string): Promise<void> {
    this.unlocking = true
    this.set({ ...this.current, phase: 'unlocking', error: null })
    try {
      await conn.api.walletUnlock(conn.apiKey, password)
      this.node.proc.log('Wallet unlocked')
    } catch (err) {
      this.node.proc.log(`Wallet unlock failed: ${errorMessage(err)}`)
      this.set({ ...this.current, phase: 'locked', error: 'That password did not unlock the wallet.' })
      return
    } finally {
      this.unlocking = false
    }
    await this.refresh()
  }

  private addressFor(network: Network): string | null {
    return this.knownAddress ? addressForNetwork(this.knownAddress, network) : null
  }

  private async rememberAddress(changeAddress: string): Promise<void> {
    if (!p2pkContent(changeAddress)) return
    this.knownAddress = changeAddress
    await this.vault.setMiningAddress(changeAddress).catch(() => undefined)
  }

  private async refresh(): Promise<void> {
    if (this.unlocking || !this.focused) return
    const network = this.focused
    const gen = ++this.refreshGen
    const stale = (): boolean => gen !== this.refreshGen || this.unlocking || this.focused !== network
    this.peerWallet = await this.peerHasKeystore(network)
    if (stale()) return
    const conn = await this.endpoint(network)
    if (stale()) return
    if (!conn) {
      this.publish(network, { phase: 'unavailable', balanceNanoErg: null, walletHeight: null, error: null })
      return
    }
    try {
      const s = await conn.api.walletStatus(conn.apiKey)
      if (stale()) return
      const phase: WalletPhase = !s.isInitialized ? 'uninitialized' : s.isUnlocked ? 'unlocked' : 'locked'
      if (s.changeAddress) await this.rememberAddress(s.changeAddress)
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
      this.publish(network, {
        phase,
        balanceNanoErg,
        walletHeight: typeof s.walletHeight === 'number' ? s.walletHeight : null,
        error: phase === 'locked' && this.current.network === network ? this.current.error : null
      })
      await this.relockGuard(conn, phase)
    } catch {
      // Node busy. Drop the other network's figures rather than keep showing them.
      if (!stale() && this.current.network !== network) {
        this.publish(network, { phase: 'unavailable', balanceNanoErg: null, walletHeight: null, error: null })
      }
    }
  }

  private publish(
    network: Network,
    patch: Pick<WalletState, 'phase' | 'balanceNanoErg' | 'walletHeight' | 'error'>
  ): void {
    this.set({
      network,
      phase: patch.phase,
      address: this.addressFor(network),
      hasPeerWallet: this.peerWallet || Boolean(this.knownAddress),
      passwordKnown: this.vault.getWalletPassword(network) !== null,
      balanceNanoErg: patch.balanceNanoErg,
      walletHeight: patch.walletHeight,
      error: patch.error
    })
  }

  /**
   * The Lithos Client needs the node wallet unlocked the whole time it runs. If it becomes
   * locked (e.g. through the node panel), unlock it again once with the known password; a
   * failed attempt waits for the user instead of retrying every poll.
   */
  private async relockGuard(conn: NodeConnection, phase: WalletState['phase']): Promise<void> {
    if (phase === 'unlocked') {
      this.relockTried = false
      return
    }
    const password = this.vault.getWalletPassword(conn.network)
    if (phase !== 'locked' || !password || this.relockTried || this.importing === conn.network) return
    this.relockTried = true
    this.node.proc.log('The node wallet was locked; unlocking it again')
    await this.tryUnlock(conn, password)
  }

  private startPolling(): void {
    const token = ++this.pollToken
    const tick = async (): Promise<void> => {
      if (token !== this.pollToken) return
      await this.refresh()
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
