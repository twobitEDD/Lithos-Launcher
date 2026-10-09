import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Network, ProcId } from '@shared/types'
import { writeFileAtomic } from './util'

/**
 * launcher.json: the only settings the launcher keeps outside ergo.conf / lithos.conf, and only
 * for things those files can't hold. Absent entirely unless the user changes one of them.
 */
export interface LauncherSettings {
  v: 1
  /** Install folder, when not the default ~/Lithos. */
  root?: string
  /** JVM heap overrides in MB; absent means sized from system RAM. */
  heap?: { nodeMb?: number; clientMb?: number }
  /** Node data folders adopted from an existing setup, used in place. */
  dataDirs?: Partial<Record<Network, string>>
  /** Node and client versions picked under Versions; absent means the newest one installed. */
  versions?: Partial<Record<Network, Partial<Record<ProcId, string>>>>
  /**
   * One mining key across mainnet and testnet (same seed, 9… / 3… addresses).
   * Off by default: testnet keys are often treated less carefully than mainnet ones.
   */
  shareWalletAcrossNetworks?: boolean
  /** LAN hosts the user chose not to defer to. Addresses only, never secrets. */
  ignoredLaunchers?: string[]
  /**
   * Connect to other Ergo nodes on this LAN for block download.
   * Absent means on. False does not stop the node. Separate from ignoredLaunchers (stratum deferral).
   */
  lanPeering?: boolean
  /** Offer this computer's chain to other launchers on the LAN. Absent means on. */
  lanChainSeed?: boolean
  /** Copy the chain from a LAN launcher when this node is far behind. Absent means on. */
  lanChainCopy?: boolean
  /** Start (or adopt) the node when the launcher opens. Absent means on. */
  autoStartNode?: boolean
  /** The network the node last ran on; auto-start uses it when the window doesn't say. */
  nodeNetwork?: Network
  /** The built-in SOAT miner. Absent means auto-start and keep running. */
  soatMiner?: { autoStart?: boolean }
}

const file = (): string => join(app.getPath('userData'), 'launcher.json')

let current: LauncherSettings = { v: 1 }

/** Read synchronously at startup, before anything asks for the install folder. */
export function loadSettings(): LauncherSettings {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<LauncherSettings>
    if (parsed.v === 1) current = { ...parsed, v: 1 }
  } catch {
    current = { v: 1 }
  }
  return current
}

export function settings(): LauncherSettings {
  return current
}

/** Whether one mining key is reused on both networks. Absent means separate keys. */
export function shareWalletAcrossNetworks(): boolean {
  return current.shareWalletAcrossNetworks === true
}

/** The node or client version picked for a network, if one was. */
export function pinnedVersion(network: Network, id: ProcId): string | null {
  return current.versions?.[network]?.[id] ?? null
}

export async function updateSettings(patch: (s: LauncherSettings) => void): Promise<LauncherSettings> {
  const next: LauncherSettings = JSON.parse(JSON.stringify(current))
  patch(next)
  current = next
  await writeFileAtomic(file(), JSON.stringify(current, null, 2))
  return current
}
