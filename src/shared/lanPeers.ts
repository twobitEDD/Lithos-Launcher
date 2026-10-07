// Finding other Ergo full nodes on this LAN so the local node can download blocks from them.
// No sockets here. This is not launcher deferral: deferral probes the stratum port and may
// skip starting a node. Peering always lets this computer run its own node.

export interface LanPeer {
  host: string
  port: number
}

export type LanPeerPhase = 'idle' | 'searching' | 'done'

export interface LanPeerStatus {
  /** False only when the user turned it off. Absent in settings means on. */
  enabled: boolean
  phase: LanPeerPhase
  /** Hosts that accepted the Ergo peer port, after this machine was removed. */
  found: number
  hosts: string[]
}

/** A subnet that answers every probe should not be added in bulk. Home LANs have a few full nodes. */
export const MAX_LAN_PEERS = 16

/** Absent or true means look for LAN nodes. False leaves the node to its usual peer discovery. */
export function peeringAllowed(flag: boolean | undefined): boolean {
  return flag !== false
}

export function peerSocket(host: string, port: number): string {
  return `${host}:${port}`
}

/** Drop this machine. Peering with our own address does not speed up block download. */
export function skipSelf(peers: readonly LanPeer[], own: ReadonlySet<string>): LanPeer[] {
  return peers.filter((peer) => !own.has(peer.host))
}

/** Short node-card line. Null before a search has finished, so "none" is not shown early. */
export function lanPeerLabel(status: Pick<LanPeerStatus, 'enabled' | 'phase' | 'found'>): string | null {
  if (!status.enabled) return 'LAN peering off'
  if (status.phase === 'searching') return 'Looking for local peers'
  if (status.phase !== 'done') return null
  if (status.found <= 0) return 'No local peers'
  return status.found === 1 ? 'Found 1 local peer' : `Found ${status.found} local peers`
}

/**
 * Ask the node to connect to each LAN peer. One refusal does not stop the rest.
 * Addresses of this machine are ignored again here.
 */
export async function addLanPeers(
  peers: readonly LanPeer[],
  own: ReadonlySet<string>,
  connect: (address: string) => Promise<void>
): Promise<{ added: LanPeer[]; failed: LanPeer[] }> {
  const added: LanPeer[] = []
  const failed: LanPeer[] = []
  for (const peer of skipSelf(peers, own)) {
    try {
      await connect(peerSocket(peer.host, peer.port))
      added.push(peer)
    } catch {
      failed.push(peer)
    }
  }
  return { added, failed }
}
