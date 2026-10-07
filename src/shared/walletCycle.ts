import type { Network, ProcStatus } from './types'

/** A wallet the list can show. `active` is the keystore the node loads. */
export interface WalletCycleItem {
  file: string
  role: 'active' | 'kept'
}

/**
 * What a cycle leaves selected. `cursor` is the highlighted row. `activeFile` is the
 * keystore the node must load. They are the same wallet: a cycle does not move a
 * highlight on its own.
 */
export interface WalletCycleSelection {
  activeFile: string
  cursor: string
}

/**
 * Steps to the neighboring wallet and makes that wallet the active one.
 * Returns null when there is nothing else to select.
 */
export function cycleActiveWallet(
  files: readonly WalletCycleItem[],
  direction: 1 | -1
): WalletCycleSelection | null {
  if (files.length < 2) return null
  const current = files.findIndex((w) => w.role === 'active')
  const from = current === -1 ? 0 : current
  const index = (from + direction + files.length) % files.length
  const file = files[index]?.file
  if (!file || file === files[current]?.file) return null
  return { activeFile: file, cursor: file }
}

/**
 * True when this network's node is up, including a node the launcher adopted and
 * does not own as a child. Switching wallets has to restart that process or the
 * address stays on the keystore it already loaded.
 */
export function walletSwitchRestartsNode(
  state: { status: ProcStatus; ownsProcess: boolean; network: Network | null },
  requested: Network
): boolean {
  if (state.network !== null && state.network !== requested) return false
  if (state.ownsProcess) return true
  return state.status === 'running' || state.status === 'starting'
}
