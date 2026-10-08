// Turns Ergo /peers/syncInfo, /peers/connected, and /peers/trackInfo into a short
// explanation of a long block download. No sockets and no claims the node did not make.

import type { NodeSyncDetails, SyncPeerRow } from './types'

/** One IPv4 interface. Same shape as the LAN scan's iface list. */
export interface SyncSubnet {
  address: string
  netmask: string
}

function ipv4ToInt(ip: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  if (parts.some((n) => n > 255)) return null
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0)
}

/** A couple of blocks still counts as caught up, matching the sync panel. */
const SLACK = 2

/** Block sections that carry a body. Headers alone are not block bodies. */
const BLOCK_BODIES = new Set(['blocktransactions', 'adproofs', 'extension', '102', '103', '108'])

export interface SyncDetailInput {
  headersHeight: number | null
  fullHeight: number | null
  maxPeerHeight: number | null
  /** null when that call failed. An array (possibly empty) means the node answered. */
  syncInfo: unknown
  connected: unknown
  track: unknown
  ifaces: readonly SyncSubnet[]
  own: ReadonlySet<string>
}

interface ParsedPeer {
  host: string
  port: number | null
  remoteHeight: number | null
  fullBlocksSuffix: number | null
  direction: 'incoming' | 'outgoing' | null
}

/** host:port from an Ergo address. Accepts "ip:port", "/ip:port", and "name/ip:port". */
export function parsePeerAddress(raw: string): { host: string; port: number | null } | null {
  const text = raw.trim()
  if (!text || text === 'N/A') return null
  const slash = text.lastIndexOf('/')
  const socket = (slash >= 0 ? text.slice(slash + 1) : text).trim()
  const match = /^(.*):(\d{1,5})$/.exec(socket)
  if (!match) {
    return ipv4ToInt(socket) === null ? null : { host: socket, port: null }
  }
  const host = match[1].replace(/^\[|\]$/g, '')
  const port = Number(match[2])
  if (!host || port > 65535) return null
  return { host, port }
}

/** True when `host` sits on one of this machine's LAN subnets and is not this machine. */
export function hostOnLan(host: string, ifaces: readonly SyncSubnet[], own: ReadonlySet<string>): boolean {
  if (own.has(host)) return false
  const ip = ipv4ToInt(host)
  if (ip === null) return false
  return ifaces.some((iface) => {
    const addr = ipv4ToInt(iface.address)
    const mask = ipv4ToInt(iface.netmask)
    if (addr === null || mask === null || mask === 0) return false
    return (ip & mask) === (addr & mask)
  })
}

/**
 * First full-block height implied by a peer's mode.fullBlocksSuffix.
 * -1 keeps the chain from the start. A positive suffix is the number of recent full blocks.
 */
export function fullHistoryStart(
  height: number | null,
  suffix: number | null
): { from: number | null; keepsNone: boolean } {
  if (suffix === null || suffix < -1) return { from: null, keepsNone: false }
  if (suffix === -1) return { from: 1, keepsNone: false }
  if (suffix === 0) return { from: null, keepsNone: true }
  if (height === null || height < 1) return { from: null, keepsNone: false }
  const from = height - suffix + 1
  return { from: from < 1 ? 1 : from, keepsNone: false }
}

/** Blocks between the stored full height and the best announced chain height. */
export function blocksStillMissing(
  headers: number | null,
  full: number | null,
  maxPeer: number | null
): number | null {
  if (full === null) return null
  const target = Math.max(headers ?? 0, maxPeer ?? 0)
  if (target <= 0) return null
  return Math.max(0, target - full)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function directionOf(value: unknown): 'incoming' | 'outgoing' | null {
  if (typeof value !== 'string') return null
  const text = value.toLowerCase()
  if (text.startsWith('in')) return 'incoming'
  if (text.startsWith('out')) return 'outgoing'
  return null
}

function suffixOf(mode: unknown): number | null {
  const record = asRecord(mode)
  if (!record) return null
  return num(record.fullBlocksSuffix)
}

function isBlockBody(type: string): boolean {
  return BLOCK_BODIES.has(type.toLowerCase())
}

/** Hosts named under block-body sections. Header and mempool entries are ignored. */
function hostsIn(section: unknown): Set<string> {
  const hosts = new Set<string>()
  const record = asRecord(section)
  if (!record) return hosts
  for (const [type, mods] of Object.entries(record)) {
    if (!isBlockBody(type)) continue
    const byId = asRecord(mods)
    if (!byId) continue
    for (const value of Object.values(byId)) {
      const address = asRecord(value)?.address
      if (typeof address !== 'string') continue
      const parsed = parsePeerAddress(address)
      if (parsed) hosts.add(parsed.host)
    }
  }
  return hosts
}

function trafficFrom(track: unknown): { known: boolean; received: Set<string>; requested: Set<string> } {
  const body = asRecord(track)
  if (!body || (body.received === undefined && body.requested === undefined)) {
    return { known: false, received: new Set(), requested: new Set() }
  }
  return { known: true, received: hostsIn(body.received), requested: hostsIn(body.requested) }
}

function rowsFrom(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return []
  return list.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
}

function mergePeers(syncInfo: unknown, connected: unknown): ParsedPeer[] {
  const byHost = new Map<string, ParsedPeer>()
  const take = (rawAddress: unknown, patch: (row: ParsedPeer) => void): void => {
    if (typeof rawAddress !== 'string') return
    const parsed = parsePeerAddress(rawAddress)
    if (!parsed) return
    const key = parsed.host.toLowerCase()
    const row = byHost.get(key) ?? { host: parsed.host, port: parsed.port, remoteHeight: null, fullBlocksSuffix: null, direction: null }
    if (row.port === null && parsed.port !== null) row.port = parsed.port
    patch(row)
    byHost.set(key, row)
  }
  for (const row of rowsFrom(syncInfo)) {
    take(row.address, (peer) => {
      const height = num(row.height)
      if (height !== null && (peer.remoteHeight === null || height > peer.remoteHeight)) peer.remoteHeight = height
      const suffix = suffixOf(row.mode)
      if (suffix !== null) peer.fullBlocksSuffix = suffix
    })
  }
  for (const row of rowsFrom(connected)) {
    take(row.address, (peer) => {
      const direction = directionOf(row.connectionType)
      if (direction) peer.direction = direction
    })
  }
  return [...byHost.values()]
}

function comma(n: number): string {
  return n.toLocaleString('en-US')
}

function explain(
  peers: readonly SyncPeerRow[],
  fullHeight: number | null,
  blocksRemaining: number | null,
  trackKnown: boolean
): { lanNote: string | null; etaIsNodeSync: boolean } {
  const missing = blocksRemaining !== null && blocksRemaining > SLACK
  const lan = peers.filter((peer) => peer.lan)
  const need = fullHeight === null ? null : fullHeight + 1
  const covers = (peer: SyncPeerRow): boolean =>
    need !== null && peer.historyFrom !== null && !peer.keepsNoFullBlocks && peer.historyFrom <= need
  const unknownHistory = (peer: SyncPeerRow): boolean => peer.historyFrom === null && !peer.keepsNoFullBlocks
  const anyCovers = lan.some(covers)
  const anyUnknown = lan.some(unknownHistory)
  const etaIsNodeSync = missing && !anyCovers && !anyUnknown

  if (!missing) return { lanNote: null, etaIsNodeSync: false }
  if (lan.length === 0) {
    return {
      lanNote: "No local peers are connected. The time left is this node's own sync from its other peers.",
      etaIsNodeSync
    }
  }

  const sending = lan.filter((peer) => peer.sendingBlocks === true)
  const requested = lan.filter((peer) => peer.blockRequested && peer.sendingBlocks !== true)
  const noneArrived = trackKnown && sending.length === 0
  const starts = lan.map((peer) => peer.historyFrom).filter((height): height is number => height !== null)
  const bestFrom = starts.length ? Math.min(...starts) : null
  const late = need !== null && bestFrom !== null && bestFrom > need

  if (late && bestFrom !== null) {
    const start = comma(bestFrom)
    if (sending.length) {
      return {
        lanNote: `A local peer is sending block bodies, but the earliest local history starts around height ${start}. Blocks before that are not on this LAN, so the rest still comes from other peers.`,
        etaIsNodeSync
      }
    }
    const traffic = !trackKnown
      ? ''
      : requested.length
        ? ' Block bodies were requested from a local peer, but none have arrived.'
        : ' Those peers are not sending block bodies.'
    return {
      lanNote: `Local peers are connected, but the best one reports full blocks only from about height ${start}. This node still needs earlier blocks.${traffic} They can only share blocks both already have.`,
      etaIsNodeSync
    }
  }

  if (lan.every((peer) => peer.keepsNoFullBlocks)) {
    return {
      lanNote: 'Local peers are connected, but they report keeping no full blocks, so they cannot supply the missing chain.',
      etaIsNodeSync
    }
  }

  if (noneArrived) {
    const range = anyUnknown ? ' The node did not say how far back their saved blocks go.' : ''
    const asked = requested.length ? ' Block bodies were requested, and none have arrived.' : ''
    return {
      lanNote: `Local peers are connected, but this node is not receiving block bodies from them.${asked}${range}`,
      etaIsNodeSync
    }
  }

  if (sending.length) {
    return { lanNote: 'A local peer is sending block bodies.', etaIsNodeSync }
  }

  return { lanNote: null, etaIsNodeSync }
}

/** Build the sync-details snapshot from node JSON. Failed calls are null, not empty arrays. */
export function buildNodeSyncDetails(input: SyncDetailInput): NodeSyncDetails {
  const blocksRemaining = blocksStillMissing(input.headersHeight, input.fullHeight, input.maxPeerHeight)
  const peersKnown = input.syncInfo !== null || input.connected !== null
  const traffic = input.track === null ? { known: false, received: new Set<string>(), requested: new Set<string>() } : trafficFrom(input.track)
  const peers: SyncPeerRow[] = []
  if (peersKnown) {
    for (const peer of mergePeers(input.syncInfo ?? [], input.connected ?? [])) {
      if (input.own.has(peer.host)) continue
      const history = fullHistoryStart(peer.remoteHeight, peer.fullBlocksSuffix)
      const lan = hostOnLan(peer.host, input.ifaces, input.own)
      const received = traffic.known && traffic.received.has(peer.host)
      const asked = traffic.known && traffic.requested.has(peer.host)
      peers.push({
        address: peer.port === null ? peer.host : `${peer.host}:${peer.port}`,
        host: peer.host,
        lan,
        direction: peer.direction,
        remoteHeight: peer.remoteHeight,
        historyFrom: history.from,
        keepsNoFullBlocks: history.keepsNone,
        fullBlocksSuffix: peer.fullBlocksSuffix,
        sendingBlocks: traffic.known ? received : null,
        blockRequested: traffic.known ? asked && !received : false
      })
    }
    peers.sort(
      (a, b) =>
        Number(b.lan) - Number(a.lan) ||
        (b.remoteHeight ?? -1) - (a.remoteHeight ?? -1) ||
        a.address.localeCompare(b.address)
    )
  }
  const { lanNote, etaIsNodeSync } = peersKnown
    ? explain(peers, input.fullHeight, blocksRemaining, traffic.known)
    : { lanNote: null, etaIsNodeSync: false }
  return {
    headersHeight: input.headersHeight,
    fullHeight: input.fullHeight,
    blocksRemaining,
    peers,
    lanNote,
    etaIsNodeSync,
    peersKnown,
    trackKnown: traffic.known
  }
}
