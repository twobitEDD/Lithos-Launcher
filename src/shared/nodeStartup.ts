// Reads the Ergo node's log for what it is doing before /info reports heights: loading its
// database ("Readers are not initialized yet"), replaying blocks after an unclean stop
// ("Applying block N during node start-up to restore consistent state"), and the extra indexer's
// progress. No Node or DOM imports.

import type { NodeStartup } from './types'

/** "Readers are not initialized" counts as current for this long after the last such line. */
export const READERS_WINDOW_MS = 30_000
/** The API poll stays slow this long after the last such line, so it does not flip back and forth. */
export const SLOW_POLL_WINDOW_MS = 5 * 60_000
/** A restore with no new "Applying block" line for this long is no longer shown. */
export const RESTORE_STALE_MS = 60 * 60_000
/** The rate needs at least this much time between the first and last block seen. */
const RATE_MIN_SPAN_MS = 60_000

const READERS_RE = /Readers are not initialized yet|undefined history reader/
const RESTORE_RE = /Applying block (\d+) during node start-up to restore consistent state/
const RESTORE_APPLIED_RE = /applied to UtxoState at height (\d+)/
const INDEXER_RE = /ExtraIndexer.*?\b(?:Buffered|Indexed|Indexing)\s+block\s+#?(\d+)\s*\/\s*(\d+)/i

interface Mark {
  block: number
  at: number
}

export class NodeStartupTracker {
  private readersAt: number | null = null
  private first: Mark | null = null
  private last: Mark | null = null
  private indexer: NodeStartup['indexer'] = null

  /** A new node process: forget the previous one's progress. */
  reset(): void {
    this.readersAt = null
    this.first = null
    this.last = null
    this.indexer = null
  }

  feed(lines: readonly string[], now: number): void {
    for (const line of lines) {
      if (READERS_RE.test(line)) {
        this.readersAt = now
        continue
      }
      const restore = RESTORE_RE.exec(line)
      if (restore) {
        this.mark(Number(restore[1]), now)
        continue
      }
      const applied = this.last ? RESTORE_APPLIED_RE.exec(line) : null
      if (applied) {
        this.mark(Number(applied[1]), now, false)
        continue
      }
      const indexer = INDEXER_RE.exec(line)
      if (indexer) this.indexer = { block: Number(indexer[1]), target: Number(indexer[2]), updatedAt: now }
    }
  }

  readersPending(now: number, windowMs = READERS_WINDOW_MS): boolean {
    return this.readersAt !== null && now - this.readersAt < windowMs
  }

  /** Null when the log shows nothing worth explaining. `fullHeight` set means the restore is over. */
  snapshot(now: number, heights: { headersHeight: number | null; fullHeight: number | null }): NodeStartup | null {
    const readersPending = this.readersPending(now)
    const restoring = this.last !== null && heights.fullHeight === null && now - this.last.at < RESTORE_STALE_MS
    let restore: NodeStartup['restore'] = null
    if (restoring && this.first && this.last) {
      const candidates = [heights.headersHeight, this.indexer?.target ?? null].filter(
        (h): h is number => h !== null && h >= this.last!.block
      )
      const target = candidates.length ? Math.max(...candidates) : null
      const span = this.last.at - this.first.at
      const done = this.last.block - this.first.block
      const blocksPerHour = span >= RATE_MIN_SPAN_MS && done > 0 ? (done * 3_600_000) / span : null
      const etaSeconds = blocksPerHour && target !== null ? Math.max(0, ((target - this.last.block) / blocksPerHour) * 3600) : null
      restore = { block: this.last.block, target, blocksPerHour, etaSeconds, updatedAt: this.last.at }
    }
    if (!readersPending && !restore && !this.indexer) return null
    return { readersPending, restore, indexer: this.indexer }
  }

  /** `canRestart`: a lower block means a new replay (a restart), not a stray older line. */
  private mark(block: number, now: number, canRestart = true): void {
    if (!Number.isFinite(block)) return
    if (!this.first || !this.last || (canRestart && block < this.last.block)) {
      this.first = { block, at: now }
      this.last = { block, at: now }
      return
    }
    if (block > this.last.block) this.last = { block, at: now }
  }
}
