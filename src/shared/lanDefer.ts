// Deciding whether this computer should start its own node, or use a Lithos launcher
// already running on the LAN. No sockets here: the main process probes, these functions choose.

export interface LanIface {
  address: string
  netmask: string
}

export interface RemoteLauncher {
  host: string
  port: number
}

export type DeferDecision =
  | { action: 'local'; reason: 'no-peer' | 'this-machine-already-serving' }
  | { action: 'defer'; host: string; port: number }

/** Wider than a /24 is not a home LAN we should sweep (Docker bridges are /16). */
export const MAX_SCAN_HOSTS = 254

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (parts.some((n) => n > 255)) return null
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0)
}

export function intToIpv4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

/** Leading ones in a dotted netmask, or null when it is not a contiguous mask. */
export function prefixLength(netmask: string): number | null {
  const n = ipv4ToInt(netmask)
  if (n === null) return null
  let bits = 0
  let seenZero = false
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) {
      if (seenZero) return null
      bits++
    } else {
      seenZero = true
    }
  }
  return bits
}

/**
 * Other hosts on each interface's subnet. Skips this machine, the network and broadcast
 * addresses, and any subnet with more than 254 hosts.
 */
export function scanTargets(ifaces: readonly LanIface[], own: ReadonlySet<string>): string[] {
  const hosts = new Set<string>()
  for (const iface of ifaces) {
    const ip = ipv4ToInt(iface.address)
    const prefix = prefixLength(iface.netmask)
    if (ip === null || prefix === null || prefix >= 32 || prefix < 24) continue
    const mask = (0xffffffff << (32 - prefix)) >>> 0
    const network = (ip & mask) >>> 0
    const broadcast = (network | (~mask >>> 0)) >>> 0
    const count = broadcast - network - 1
    if (count < 1 || count > MAX_SCAN_HOSTS) continue
    for (let n = network + 1; n < broadcast; n++) {
      const host = intToIpv4(n >>> 0)
      if (!own.has(host)) hosts.add(host)
    }
  }
  return [...hosts].sort((a, b) => (ipv4ToInt(a) ?? 0) - (ipv4ToInt(b) ?? 0))
}

/**
 * A reply from the Lithos client's stratum port: a JSON-RPC object, not an HTTP server
 * that happens to have the port open. The launcher has no separate LAN health port.
 */
export function isStratumReply(chunk: string): boolean {
  const text = chunk.trim()
  if (!text || text.startsWith('HTTP/')) return false
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('{'))
  if (!line) return false
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return false
  }
  if (!msg || typeof msg !== 'object') return false
  const o = msg as Record<string, unknown>
  if (typeof o.method === 'string' && o.method.startsWith('mining.')) return true
  if ('result' in o && o.error == null) return true
  return false
}

export function decideDefer(input: {
  localStratumOpen: boolean
  remotes: readonly RemoteLauncher[]
  own: ReadonlySet<string>
  /** Hosts the user chose to ignore. They stay up; this computer just stops deferring to them. */
  ignored?: ReadonlySet<string>
}): DeferDecision {
  // This computer is already the launcher. Do not shut it down and do not defer to it.
  if (input.localStratumOpen) return { action: 'local', reason: 'this-machine-already-serving' }
  const ignored = input.ignored ?? new Set<string>()
  const remote = [...input.remotes]
    .filter((r) => !input.own.has(r.host) && !ignored.has(r.host))
    .sort((a, b) => (ipv4ToInt(a.host) ?? 0) - (ipv4ToInt(b.host) ?? 0))[0]
  if (remote) return { action: 'defer', host: remote.host, port: remote.port }
  return { action: 'local', reason: 'no-peer' }
}

/** Remember a remote launcher so this computer may start. Does not contact that machine. */
export function ignoreLauncher(remote: RemoteLauncher, ignored: readonly string[]): string[] {
  const next = new Set(ignored.filter((host) => ipv4ToInt(host) !== null))
  if (ipv4ToInt(remote.host) !== null) next.add(remote.host)
  return [...next]
}

/** True when Start on this computer is allowed. An ignored remote does not block it. */
export function localStartAllowed(remote: RemoteLauncher | null, ignored: ReadonlySet<string>): boolean {
  if (!remote) return true
  return ignored.has(remote.host)
}

/** Probe `targets` and turn the answers into a defer decision. Does not open sockets itself. */
export async function searchLan(opts: {
  ifaces: readonly LanIface[]
  own: ReadonlySet<string>
  port: number
  localStratumOpen: boolean
  probe: (host: string, port: number) => Promise<boolean>
  concurrency?: number
  ignored?: ReadonlySet<string>
}): Promise<DeferDecision> {
  if (opts.localStratumOpen) {
    return { action: 'local', reason: 'this-machine-already-serving' }
  }
  const targets = scanTargets(opts.ifaces, opts.own)
  const open: RemoteLauncher[] = []
  const limit = Math.max(1, opts.concurrency ?? 48)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      const host = targets[i]
      if (opts.own.has(host)) continue
      if (await opts.probe(host, opts.port)) open.push({ host, port: opts.port })
    }
  }
  const workers = Math.min(limit, targets.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return decideDefer({ localStratumOpen: false, remotes: open, own: opts.own, ignored: opts.ignored })
}
