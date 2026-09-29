export interface WalletStatus {
  isInitialized: boolean
  isUnlocked: boolean
  changeAddress: string
  /** Last block the wallet scanned. */
  walletHeight?: number
}

/** Turns an Ergo ApiError body ({ error, reason, detail }) into a readable message. */
async function errorFrom(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { reason?: unknown; detail?: unknown }
    const text = typeof body.detail === 'string' && body.detail ? body.detail : body.reason
    if (typeof text === 'string' && text) return new Error(text)
  } catch {
    // not JSON
  }
  return new Error(`The node returned HTTP ${res.status}`)
}

/** Minimal client for the local Ergo node REST API. */
export class NodeApi {
  constructor(readonly port: number) {}

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  /** Authenticated JSON call. Wallet operations derive keys, so they get a long timeout. */
  private async call<T>(method: 'GET' | 'POST', path: string, apiKey: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: body === undefined ? { api_key: apiKey } : { api_key: apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw await errorFrom(res)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  async info(): Promise<Record<string, unknown>> {
    const res = await fetch(this.url('/info'), { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`/info returned HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  /** Indexer height, or null while the indexer is unavailable. */
  async indexedHeight(): Promise<number | null> {
    try {
      const res = await fetch(this.url('/blockchain/indexedHeight'), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      const body = (await res.json()) as { indexedHeight?: unknown }
      return typeof body.indexedHeight === 'number' ? body.indexedHeight : null
    } catch {
      return null
    }
  }

  /** blake2b256 of `message`, hex encoded, computed by the node. */
  async blake2b(message: string): Promise<string> {
    const res = await fetch(this.url('/utils/hash/blake2b'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw new Error(`Hash request returned HTTP ${res.status}`)
    const hash = await res.json()
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('The node returned a malformed hash')
    return hash
  }

  /** True if the node accepts `apiKey` on a protected endpoint. */
  async accepts(apiKey: string): Promise<boolean> {
    const res = await fetch(this.url('/wallet/status'), {
      headers: { api_key: apiKey },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok
  }

  /** Asks the node to shut down cleanly (it exits a few seconds later). */
  async shutdown(apiKey: string): Promise<void> {
    const res = await fetch(this.url('/node/shutdown'), {
      method: 'POST',
      headers: { api_key: apiKey },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw new Error(`Shutdown request returned HTTP ${res.status}`)
  }

  walletStatus(apiKey: string): Promise<WalletStatus> {
    return this.call('GET', '/wallet/status', apiKey)
  }

  /** Creates a wallet with a node-generated seed and returns the mnemonic. */
  async walletInit(apiKey: string, pass: string): Promise<string> {
    const result = await this.call<{ mnemonic?: unknown }>('POST', '/wallet/init', apiKey, { pass })
    if (typeof result.mnemonic !== 'string') throw new Error('The node did not return a seed phrase')
    return result.mnemonic
  }

  async walletRestore(apiKey: string, mnemonic: string, pass: string): Promise<void> {
    await this.call('POST', '/wallet/restore', apiKey, { pass, mnemonic, usePre1627KeyDerivation: false })
  }

  /** Confirmed wallet balance in nanoERG (the wallet must be unlocked). */
  async walletBalance(apiKey: string): Promise<number> {
    const body = await this.call<{ balance?: unknown }>('GET', '/wallet/balances', apiKey)
    if (typeof body.balance !== 'number') throw new Error('The node returned no balance')
    return body.balance
  }

  async walletUnlock(apiKey: string, pass: string): Promise<void> {
    await this.call('POST', '/wallet/unlock', apiKey, { pass })
  }

  /** Drops the wallet's scanned history and scans the chain again from `fromHeight`, in the background. */
  async walletRescan(apiKey: string, fromHeight: number): Promise<void> {
    await this.call('POST', '/wallet/rescan', apiKey, { fromHeight })
  }
}
