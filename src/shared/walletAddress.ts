/** A wallet the list can show. `address` is that keystore's own public address. */
export interface WalletAddressView {
  file: string
  role: 'active' | 'kept'
  address: string | null
}

/**
 * Public address for the wallet the user selected.
 * The node loads one keystore, so `nodeAddress` belongs to that loaded wallet only.
 * It fills in when this list has a single active wallet and that wallet has no
 * record yet. It is never shown for a different wallet.
 */
export function addressForSelection(
  wallets: readonly WalletAddressView[],
  selectedFile: string | null,
  nodeAddress: string | null
): string | null {
  const selected = selectedFile
    ? (wallets.find((w) => w.file === selectedFile) ?? null)
    : (wallets.find((w) => w.role === 'active') ?? null)
  if (selectedFile && !selected) return null
  if (selected?.address) return selected.address
  if (wallets.length === 0) return nodeAddress
  if (wallets.length === 1 && selected?.role === 'active') return nodeAddress
  return null
}

/** Public address drawn on one list row. Each row uses its own wallet. */
export function addressOnWalletRow(
  wallet: WalletAddressView,
  wallets: readonly WalletAddressView[],
  nodeAddress: string | null
): string | null {
  return addressForSelection(wallets, wallet.file, nodeAddress)
}

/**
 * Whether `reported` should be stored on the active keystore.
 * An address already stored on that file is left as it is.
 * Repeating the address the node showed for the previous keystore does not stamp
 * it onto a file that has no address yet.
 */
export function shouldStampAddress(
  existingOnFile: string | null,
  previouslyShown: string | null,
  reported: string
): boolean {
  if (existingOnFile) return false
  return previouslyShown !== reported
}
