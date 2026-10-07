/**
 * Height to pass to the node's wallet rescan.
 * A full chain is scanned from block 1. When block 2 is missing, genesis can still
 * be present while the rest of history is not: scanning from 1 never advances.
 * In that case the scan starts at the first later block this node has stored.
 * Returns null when the tip itself is missing, so the caller does not retry.
 */
export async function firstScannableHeight(
  fullHeight: number,
  hasBlock: (height: number) => Promise<boolean>
): Promise<number | null> {
  if (!Number.isInteger(fullHeight) || fullHeight < 1) return null
  if (fullHeight === 1) return (await hasBlock(1)) ? 1 : null
  if (await hasBlock(2)) return 1
  if (!(await hasBlock(fullHeight))) return null
  let lo = 2
  let hi = fullHeight
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (await hasBlock(mid)) hi = mid
    else lo = mid
  }
  return hi
}
