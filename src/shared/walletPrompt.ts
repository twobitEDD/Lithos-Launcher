import type { WalletPhase } from './types'

/** Same minimum as `MIN_PASSWORD_LENGTH` in types.ts. The unit test checks they stay equal. */
const MIN_PASSWORD_LENGTH = 8

/**
 * "Create a new wallet" stays on the wallet card in every phase. A locked or
 * unlocked wallet can still be replaced after an explicit confirm; the old
 * keystore is kept on disk.
 */
export function showCreateWalletPrompt(phase: WalletPhase): boolean {
  return (
    phase === 'unavailable' ||
    phase === 'uninitialized' ||
    phase === 'locked' ||
    phase === 'unlocking' ||
    phase === 'unlocked'
  )
}

/** True when creating would set the node's current wallet aside. */
export function createReplacesWallet(phase: WalletPhase): boolean {
  return phase === 'locked' || phase === 'unlocking' || phase === 'unlocked'
}

/**
 * Why the create-wallet password step cannot be submitted, or null when it can.
 * A matching repeat is required. Node status and an existing wallet are not part of this:
 * those are reported when the button is clicked, and an existing wallet needs its own confirm.
 */
export function createWalletPasswordProblem(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (!confirmPassword) return 'Repeat the password'
  if (confirmPassword !== password) return 'The passwords do not match'
  return null
}

/** The "Create a new wallet" submit control. Busy is the only extra gate. */
export function canSubmitCreateWallet(input: {
  busy: boolean
  password: string
  confirmPassword: string
}): boolean {
  return !input.busy && createWalletPasswordProblem(input.password, input.confirmPassword) === null
}

/** Shown when create cannot talk to a node yet. The button stays enabled. */
export function createWalletNodeProblem(nodeRunning: boolean): string | null {
  if (nodeRunning) return null
  return 'Start the node on this computer first. The new wallet is created on that node.'
}

/**
 * Whether the wizard may call the create API. An adopted node counts as running.
 * The password button and the replace checkbox stay separate checks.
 */
export function canInvokeCreateWallet(input: {
  nodeRunning: boolean
  phase: WalletPhase
  replaceConfirmed: boolean
  busy: boolean
  password: string
  confirmPassword: string
}): boolean {
  return (
    canSubmitCreateWallet(input) &&
    createWalletNodeProblem(input.nodeRunning) === null &&
    replaceWalletBlocked(input.phase, input.replaceConfirmed) === null
  )
}

/**
 * Shown beside an enabled create button when this node already has a wallet.
 * The button stays clickable. The checkbox is what allows the current wallet to be set aside.
 */
export function existingWalletCreateNote(phase: WalletPhase): string | null {
  if (!createReplacesWallet(phase)) return null
  return 'The current wallet will be set aside and kept on disk. Mining will use the new wallet after it is created.'
}

/** Why a click must not set the current wallet aside, or null when the confirm box is checked. */
export function replaceWalletBlocked(phase: WalletPhase, confirmed: boolean): string | null {
  if (!createReplacesWallet(phase) || confirmed) return null
  return 'Check the box to set the current wallet aside before continuing.'
}
