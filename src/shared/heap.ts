// JVM heap limits for the Ergo node and the Lithos Client, sized from system RAM. No Node or DOM imports.

/** Node + client heap together stay at or under this share of RAM (OS, miner, browser, disk cache). */
export const HEAP_RAM_SHARE = 0.6
/** More than this does not help the node; Ergo with the extra index syncs well in 6-8 GB. */
export const NODE_HEAP_MAX_MB = 8192

/**
 * The node gets what the RAM share leaves after the client, between 4 and 8 GB, in 256 MB steps:
 * 16 GB of RAM gives the node 6.5 GB and the client 3 GB (59%). Under 12 GB the old fixed sizes stay.
 */
export function autoHeapFor(totalBytes: number): { nodeMb: number; clientMb: number } {
  const gb = totalBytes / 2 ** 30
  if (gb < 12) return { nodeMb: 3072, clientMb: 2048 }
  const clientMb = gb < 24 ? 3072 : 4096
  const budget = (totalBytes / 2 ** 20) * HEAP_RAM_SHARE - clientMb
  const nodeMb = Math.min(NODE_HEAP_MAX_MB, Math.max(4096, Math.floor(budget / 256) * 256))
  return { nodeMb, clientMb }
}
