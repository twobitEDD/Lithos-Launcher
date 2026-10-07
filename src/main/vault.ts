import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { Network, VaultInfo } from '@shared/types'
import { writeFileAtomic } from './util'

export interface NodeKey {
  key: string
  /** blake2b256 of `key` as computed by the node. Not secret; lets ergo.conf be rewritten offline. */
  hash: string
}

/** A network's mining wallet as its node reported it. Not secret: an address and its public key. */
export interface WalletKey {
  address: string
  /** Hex public key behind `address`, from the node. The same key has a 9… and a 3… address. */
  pubKey: string
}

interface VaultData {
  v: 1
  nodeKeys: Partial<Record<Network, NodeKey>>
  walletPasswords: Partial<Record<Network, string>>
  /** Key for the Lithos Client's own API (and its hash for lithos.conf). */
  lithosKeys: Partial<Record<Network, NodeKey>>
  /** Play's application secret for the Lithos Client. */
  playSecrets: Partial<Record<Network, string>>
  /** Each network's own mining wallet, last seen on its node. */
  walletKeys: Partial<Record<Network, WalletKey>>
}

const empty = (): VaultData => ({
  v: 1,
  nodeKeys: {},
  walletPasswords: {},
  lithosKeys: {},
  playSecrets: {},
  walletKeys: {}
})

/**
 * Secrets encrypted with the OS (DPAPI on Windows, libsecret/KWallet on Linux).
 * When only Electron's plaintext fallback is available, nothing is written to
 * disk: secrets live in memory for this session only.
 */
export class Vault {
  readonly info: VaultInfo
  private data: VaultData = empty()
  /** Wallet passwords the user chose not to save, kept until the launcher exits. */
  private readonly sessionPasswords: Partial<Record<Network, string>> = {}
  private readonly file = join(app.getPath('userData'), 'vault.bin')

  constructor() {
    const backend =
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'win32' ? 'dpapi' : 'keychain'
    const secure = safeStorage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown'
    this.info = { secure, backend }
  }

  async load(): Promise<void> {
    if (!this.info.secure) return
    let blob: Buffer
    try {
      blob = await readFile(this.file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    try {
      const parsed = JSON.parse(safeStorage.decryptString(blob)) as Partial<VaultData>
      if (parsed.v === 1) {
        this.data = { ...empty(), ...parsed, v: 1 }
      }
    } catch {
      // Unreadable (e.g. OS profile changed). Start fresh: node keys are re-issued, wallet passwords re-asked.
      this.data = empty()
    }
  }

  getNodeKey(network: Network): NodeKey | null {
    return this.data.nodeKeys[network] ?? null
  }

  async setNodeKey(network: Network, key: NodeKey): Promise<void> {
    this.data.nodeKeys[network] = key
    await this.persist()
  }

  getWalletPassword(network: Network): string | null {
    return this.sessionPasswords[network] ?? this.data.walletPasswords[network] ?? null
  }

  /** Drops the saved wallet password so a switched wallet is not opened with the previous one. */
  async forgetWalletPassword(network: Network): Promise<void> {
    delete this.sessionPasswords[network]
    delete this.data.walletPasswords[network]
    await this.persist()
  }

  /** Always kept for this session; written to disk only if `save` and the OS can encrypt it. */
  async setWalletPassword(network: Network, password: string, save: boolean): Promise<void> {
    if (save && this.info.secure) {
      delete this.sessionPasswords[network]
      this.data.walletPasswords[network] = password
    } else {
      this.sessionPasswords[network] = password
      delete this.data.walletPasswords[network]
    }
    await this.persist()
  }

  getLithosKey(network: Network): NodeKey | null {
    return this.data.lithosKeys[network] ?? null
  }

  async setLithosKey(network: Network, key: NodeKey): Promise<void> {
    this.data.lithosKeys[network] = key
    await this.persist()
  }

  getPlaySecret(network: Network): string | null {
    return this.data.playSecrets[network] ?? null
  }

  async setPlaySecret(network: Network, secret: string): Promise<void> {
    this.data.playSecrets[network] = secret
    await this.persist()
  }

  /** The mining wallet `network`'s node last reported, or null before it has reported one. */
  getWalletKey(network: Network): WalletKey | null {
    return this.data.walletKeys[network] ?? null
  }

  async setWalletKey(network: Network, key: WalletKey): Promise<void> {
    this.data.walletKeys[network] = key
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.info.secure) return
    await writeFileAtomic(this.file, safeStorage.encryptString(JSON.stringify(this.data)), 0o600)
  }
}
