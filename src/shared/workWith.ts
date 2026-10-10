// Which Lithos stratum this computer's SOAT miner works with: its own Lithos Client, or another
// Lithos launcher on the LAN. No sockets or files here: the SOAT service gathers the facts and
// these functions choose. Must stay free of Node and DOM imports.
import type { ChainSeedAdvert, WalletScanState } from './chainCopy'
import type { StratumTarget } from './soatMiner'

export type WorkWithMode = 'auto' | 'local' | 'lan'
/** `syncing`: use the LAN launcher only until this computer's own stack and wallet are ready. */
export type WorkWithScope = 'syncing' | 'always'

/** The "Work with" choice, kept by the SOAT service in soat-service.json. */
export interface WorkWith {
  mode: WorkWithMode
  /** The LAN launcher picked, when `mode` is `lan`. */
  host: string | null
  scope: WorkWithScope
}

export const DEFAULT_WORK_WITH: WorkWith = { mode: 'auto', host: null, scope: 'syncing' }

/** Mining locally and the local stack stops reporting a job: wait this long before moving to a LAN launcher. */
export const WORK_WITH_GRACE_MS = 60_000

/** Blocks the wallet may trail the node by and still count as scanned (the window uses the same). */
export const WALLET_SLACK_BLOCKS = 3
/** Blocks the node's full height may trail its headers and still count as synced. */
export const NODE_SYNCED_SLACK = 10

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** RFC 1918 IPv4 only. A LAN launcher is never a host name, loopback, or public address. */
export function isLanHost(host: unknown): host is string {
  if (typeof host !== 'string') return false
  const m = IPV4_RE.exec(host)
  if (!m) return false
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if ([a, b, c, d].some((n) => n > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** A saved or requested choice, or null when it is not one. */
export function parseWorkWith(v: unknown): WorkWith | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.scope !== undefined && r.scope !== 'always' && r.scope !== 'syncing') return null
  const scope: WorkWithScope = r.scope === 'always' ? 'always' : 'syncing'
  if (r.mode === 'auto' || r.mode === 'local') return { mode: r.mode, host: null, scope }
  if (r.mode === 'lan' && isLanHost(r.host)) return { mode: 'lan', host: r.host, scope }
  return null
}

const ipNum = (ip: string): number => {
  const m = IPV4_RE.exec(ip)
  return m ? ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0 : 0
}

/** One LAN launcher as this computer's SOAT service sees it. */
export interface LanLauncher {
  host: string
  /** Its Lithos Client's stratum port; null when neither the stratum scan nor its advert gave one. */
  stratumPort: number | null
  /** The stratum answered the launcher's LAN scan. */
  stratumSeen: boolean
  /** `full`: an advert with miner details (0.2.1-twobit.8+). `basic`: an older advert (network and heights). `none`: no advert. */
  advert: 'full' | 'basic' | 'none'
  network: 'mainnet' | 'testnet' | null
  fullHeight: number | null
  headersHeight: number | null
  synced: boolean | null
  clientRunning: boolean | null
  hasJob: boolean | null
  rigs: number | null
  version: string | null
  walletScan: WalletScanState | null
}

/** Combines what the stratum scan found with the host's 9077 advert, old or new. */
export function lanLauncherFrom(host: string, stratumPort: number | null, advert: ChainSeedAdvert | null): LanLauncher {
  const extras = advert?.launcher ?? null
  const fullHeight = advert?.fullHeight ?? null
  const headersHeight = advert?.headersHeight ?? null
  const synced =
    extras?.synced ??
    (advert?.available && fullHeight !== null && headersHeight !== null ? headersHeight - fullHeight <= NODE_SYNCED_SLACK : null)
  return {
    host,
    stratumPort: stratumPort ?? extras?.stratumPort ?? null,
    stratumSeen: stratumPort !== null,
    advert: extras ? 'full' : advert ? 'basic' : 'none',
    network: advert?.available ? advert.network : (advert?.network ?? null),
    fullHeight,
    headersHeight,
    synced,
    clientRunning: extras ? extras.client.running : null,
    hasJob: extras ? extras.client.hasJob : null,
    rigs: extras ? extras.client.rigs : null,
    version: extras?.version ?? null,
    walletScan: extras?.walletScan ?? null
  }
}

/** Null when this computer's miner can mine through `l` on `network`; otherwise why not. */
export function lanLauncherSkip(l: LanLauncher, network: 'mainnet' | 'testnet'): string | null {
  if (!isLanHost(l.host)) return 'not a private LAN address'
  if (l.stratumPort === null) return 'its stratum port is not known yet'
  if (l.network !== null && l.network !== network) return `it runs ${l.network}; this computer mines on ${network}`
  if (l.clientRunning === false) return 'its Lithos Client is not running'
  return null
}

/** Usable launchers, best first: a current job, then synced, then the highest chain, then the lowest address. */
export function rankLanLaunchers(list: readonly LanLauncher[], network: 'mainnet' | 'testnet'): LanLauncher[] {
  const job = (l: LanLauncher): number => (l.hasJob === true ? 0 : l.hasJob === null ? 1 : 2)
  const synced = (l: LanLauncher): number => (l.synced === true ? 0 : l.synced === null ? 1 : 2)
  return list
    .filter((l) => lanLauncherSkip(l, network) === null)
    .sort(
      (a, b) =>
        job(a) - job(b) ||
        synced(a) - synced(b) ||
        (b.fullHeight ?? 0) - (a.fullHeight ?? 0) ||
        ipNum(a.host) - ipNum(b.host)
    )
}

/** Whether this computer's wallet still has to catch up, from the launcher's wallet and node state. */
export interface WalletScanInfo {
  state: WalletScanState
  height: number | null
  tip: number | null
}

export function walletScanState(input: {
  /** WalletState.phase */
  phase: string
  walletHeight: number | null
  /** The node runs on the wallet's network. */
  nodeRunning: boolean
  fullHeight: number | null
  headersHeight: number | null
}): WalletScanInfo {
  const tip = input.nodeRunning ? input.fullHeight : null
  if (input.phase === 'unavailable' || input.phase === 'uninitialized') return { state: 'none', height: null, tip }
  if (input.phase !== 'unlocked') return { state: 'locked', height: input.walletHeight, tip }
  const nodeSynced =
    input.nodeRunning &&
    input.fullHeight !== null &&
    input.headersHeight !== null &&
    input.headersHeight - input.fullHeight <= NODE_SYNCED_SLACK
  if (!nodeSynced) return { state: 'waiting-node', height: input.walletHeight, tip }
  if (input.walletHeight === null) return { state: 'unknown', height: null, tip }
  if (input.walletHeight < input.fullHeight! - WALLET_SLACK_BLOCKS) return { state: 'scanning', height: input.walletHeight, tip }
  return { state: 'done', height: input.walletHeight, tip }
}

/** The wallet scan holds the miner on a LAN launcher (in `syncing` scope) while it waits for the node or scans. */
export function walletHolds(state: WalletScanState | null | undefined): boolean {
  return state === 'waiting-node' || state === 'scanning'
}

/** The picker's line about this computer's wallet, or null when it has nothing to wait for. */
export function walletWaitText(info: WalletScanInfo | null, via: string | null): string | null {
  if (!info || !walletHolds(info.state)) return null
  const meanwhile = via ? `; meanwhile mining through ${via}.` : '.'
  if (info.state === 'waiting-node') return `Your wallet will scan once this node syncs${meanwhile}`
  const progress =
    info.height !== null && info.tip !== null && info.tip > 0 ? ` (block ${info.height.toLocaleString('en-US')} of ${info.tip.toLocaleString('en-US')})` : ''
  return `Your wallet is scanning the chain${progress}${meanwhile}`
}

export interface WorkWithInput {
  choice: WorkWith
  network: 'mainnet' | 'testnet'
  /** This computer's own stratum (loopback). */
  primary: StratumTarget
  /** Every LAN launcher known, usable or not. */
  launchers: readonly LanLauncher[]
  /** Launchers Automatic may use: "mine through a LAN launcher while this computer has no work" is on for them. */
  autoHosts: ReadonlySet<string>
  /** This computer's Lithos Client has a current job. */
  localReady: boolean
  /** This computer's wallet is waiting for the node or scanning. */
  walletHold: boolean
  /** How long the local stack has not been ready (0 when it is). */
  localDownForMs: number
  /** What the miner is connected to now, or null when it is not running. */
  current: StratumTarget | null
}

export interface WorkWithResult {
  target: StratumTarget
  /** Mining through a LAN launcher for now; moves back to this computer by itself. */
  lanFallback: boolean
  /** The target is another computer. */
  remote: boolean
  /** Whose Lithos Client (and wallet) gets the shares: a LAN host, or null for this computer. */
  via: string | null
  /** Why the miner is not doing what was picked, when it is not. */
  note: string | null
}

const sameTarget = (a: StratumTarget | null, b: StratumTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.host === b.host && a.port === b.port)

const targetOf = (l: LanLauncher): StratumTarget => ({ host: l.host, port: l.stratumPort! })

/**
 * Where the miner works now. Automatic and "only while syncing" hold this computer's stratum for a
 * short grace when its job blinks out, and keep the launcher already mined through, so the miner is
 * not bounced around.
 */
export function resolveWorkWith(input: WorkWithInput): WorkWithResult {
  const { choice, primary, current, network } = input
  const here: WorkWithResult = { target: primary, lanFallback: false, remote: false, via: null, note: null }
  const graceHere = current !== null && sameTarget(current, primary) && input.localDownForMs < WORK_WITH_GRACE_MS
  if (choice.mode === 'local') return here

  if (choice.mode === 'lan') {
    const picked = input.launchers.find((l) => l.host === choice.host) ?? null
    const skip = picked ? lanLauncherSkip(picked, network) : 'was not found on the LAN in the last scan'
    if (skip || !picked) return { ...here, note: `${choice.host} ${skip ?? 'is not available'}. Mining on this computer meanwhile.` }
    const there: WorkWithResult = { target: targetOf(picked), lanFallback: false, remote: true, via: picked.host, note: null }
    if (choice.scope === 'always') return there
    if (input.localReady && !input.walletHold) return here
    if (graceHere && !input.walletHold) return here
    return { ...there, lanFallback: true }
  }

  if (input.localReady) return here
  const usable = rankLanLaunchers(
    input.launchers.filter((l) => input.autoHosts.has(l.host)),
    network
  )
  if (!usable.length || graceHere) return here
  const keep = current ? usable.find((l) => sameTarget(targetOf(l), current) && l.hasJob !== false) : undefined
  const best = keep ?? usable[0]
  return { target: targetOf(best), lanFallback: true, remote: true, via: best.host, note: null }
}

/** Whose wallet the miner's shares pay, in a sentence. */
export function rewardsText(via: string | null): string {
  return via
    ? `Shares go to the Lithos Client on ${via} and are paid to that launcher's wallet, not this computer's.`
    : "Shares go to this computer's Lithos Client and are paid to this computer's wallet."
}

/** One line of live facts for a launcher in the picker. Older launchers say less. */
export function lanLauncherSummary(l: LanLauncher): string {
  const parts: string[] = []
  if (l.network) parts.push(l.network)
  if (l.fullHeight !== null) parts.push(`height ${l.fullHeight.toLocaleString('en-US')}${l.synced === true ? ' (synced)' : l.synced === false ? ' (syncing)' : ''}`)
  if (l.advert === 'full') {
    parts.push(l.clientRunning ? (l.hasJob === true ? 'client has a job' : l.hasJob === false ? 'client has no job yet' : 'client running') : 'client stopped')
    if (l.rigs !== null) parts.push(`${l.rigs} rig${l.rigs === 1 ? '' : 's'}`)
    if (l.version) parts.push(`v${l.version}`)
  } else if (l.advert === 'basic') {
    parts.push('older launcher: no client details')
  } else {
    parts.push(l.stratumSeen ? 'stratum found; no details (port 9077 closed or older launcher)' : 'no details')
  }
  return parts.join(' · ')
}

/**
 * Why "Use a LAN node for this computer's Lithos Client" is not offered. Lithos Client 1.0.x reads
 * its wallet through the node's wallet API and asks the node for mining candidates without a public
 * key, so a client pointed at another computer's node would see and spend that computer's node
 * wallet, and found blocks would pay that node's mining key.
 */
export const LAN_NODE_FOR_CLIENT_NOTE =
  "This computer's Lithos Client can't use another computer's node: the client reads its wallet " +
  "through the node's wallet API (/wallet/addresses, /wallet/balances, /wallet/boxes/unspent, " +
  "/wallet/deriveNextKey) and gets mining work from /mining/candidateWithTxs, which pays the node's own " +
  "mining key. Through another node it would use that computer's wallet and pay that computer, and its " +
  "candidate requests would replace the other client's work. Mining through that launcher's stratum " +
  'is the safe way to keep this GPU busy while this node syncs.'
