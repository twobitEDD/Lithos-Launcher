/**
 * When a Lithos block's proof pays.
 *
 * The block opens a rollup. Holding is the next 360 blocks (proof posted, bond locked), then
 * evaluation is another 360. The wallet is paid once 720 blocks have passed after that Lithos block:
 * the block's ERG share plus the 0.002 ERG bond. The 0.001 fee does not return.
 */
export const PAYOUT_DELAY_BLOCKS = 720

/** A proof the client already knows about, and the height its payout lands on. */
export interface PayoutProof {
  /** Lithos block that opened the rollup. */
  lithosBlock: number
  /** Chain height at which this proof pays. */
  payoutHeight: number
}

export interface NextPayout {
  lithosBlock: number
  payoutHeight: number
  /** Blocks until `payoutHeight`. Null when the chain height is not known yet. 0 when it is due. */
  blocksRemaining: number | null
  /** Other outstanding proofs after the soonest. */
  laterCount: number
}

/** Payout height for a Lithos block: that block plus the 720-block holding and evaluation. */
export function payoutHeightFor(lithosBlock: number, delay = PAYOUT_DELAY_BLOCKS): number {
  return lithosBlock + delay
}

/** Blocks still to go before `payoutHeight`. Never negative. */
export function blocksRemaining(payoutHeight: number, chainHeight: number): number {
  return Math.max(0, payoutHeight - chainHeight)
}

/** Seconds until payout: blocks left times the chain's block interval (Ergo mainnet is 120). */
export function countdownSeconds(blocks: number, blockSeconds: number): number {
  return Math.max(0, blocks) * Math.max(0, blockSeconds)
}

/**
 * Clock-style wait for a countdown, e.g. "3h 28m 10s". `0` is "due now".
 * Days are used only past 48 hours so a normal payout stays in hours.
 */
export function countdownText(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds <= 0) return 'due now'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours >= 48) {
    const days = Math.floor(hours / 24)
    const rest = hours % 24
    return rest ? `${days}d ${rest}h` : `${days}d`
  }
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

/**
 * Unpaid proofs from `GET /stats/mining/payments`.
 * Uses `payoutReadyFrom` when the client sends it, otherwise `minedHeight + 720`.
 * Slashed claims are omitted (they never pay). Returns null when this body is not that page.
 */
export function proofsFromPayments(body: unknown, delay = PAYOUT_DELAY_BLOCKS): PayoutProof[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { claims?: unknown }).claims)) return null
  const claims = (body as { claims: unknown[] }).claims
  const byBlock = new Map<number, number>()
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') continue
    const row = claim as Record<string, unknown>
    if (row.phase === 'slashed') continue
    const lithosBlock = asInt(row.minedHeight)
    if (lithosBlock === null) continue
    const ready = asInt(row.payoutReadyFrom)
    const phaseHeight = asInt(row.phaseHeight)
    const payoutHeight =
      ready ?? (row.phase === 'payout' && phaseHeight !== null ? phaseHeight : payoutHeightFor(lithosBlock, delay))
    const prev = byBlock.get(lithosBlock)
    if (prev === undefined || payoutHeight < prev) byBlock.set(lithosBlock, payoutHeight)
  }
  return [...byBlock.entries()].map(([lithosBlock, payoutHeight]) => ({ lithosBlock, payoutHeight }))
}

const LITHOS_BLOCK_RE = /Got valid NISP for lithos-mined block (\d+)/g

/**
 * Lithos blocks the client has a proof for, from its own log lines.
 * The same block is often logged more than once; each block is returned once, ascending.
 */
export function lithosBlocksFromLog(text: string): number[] {
  const found = new Set<number>()
  for (const match of text.matchAll(LITHOS_BLOCK_RE)) {
    const height = Number(match[1])
    if (Number.isSafeInteger(height)) found.add(height)
  }
  return [...found].sort((a, b) => a - b)
}

/**
 * The soonest outstanding proof, plus how many pay later.
 * When `dropSettled` is set, a proof whose payout height is already behind the chain is omitted
 * (used for log-derived proofs, which are not marked paid). Claims from the payments API stay
 * until the client drops them, and show as due once the chain has reached their height.
 */
export function nextPayout(
  proofs: readonly PayoutProof[],
  chainHeight: number | null,
  opts?: { dropSettled?: boolean }
): NextPayout | null {
  let list = proofs.filter(
    (p) => Number.isInteger(p.lithosBlock) && Number.isInteger(p.payoutHeight)
  )
  if (opts?.dropSettled && chainHeight !== null) {
    list = list.filter((p) => p.payoutHeight >= chainHeight)
  }
  if (list.length === 0) return null
  list.sort((a, b) => a.payoutHeight - b.payoutHeight || a.lithosBlock - b.lithosBlock)
  const soonest = list[0]
  return {
    lithosBlock: soonest.lithosBlock,
    payoutHeight: soonest.payoutHeight,
    blocksRemaining: chainHeight === null ? null : blocksRemaining(soonest.payoutHeight, chainHeight),
    laterCount: list.length - 1
  }
}
