import { ipv4ToInt, scanTargets, type LanIface } from '../shared/lanDefer.ts'
import { MAX_LAN_PEERS, skipSelf, type LanPeer } from '../shared/lanPeers.ts'

/**
 * Hosts on the LAN whose peer port is open. `probe` is the only I/O.
 * `port` is the Ergo peer port (mainnet 9030, testnet 9023), never the stratum port.
 */
export async function discoverLanPeers(opts: {
  ifaces: readonly LanIface[]
  own: ReadonlySet<string>
  port: number
  probe: (host: string, port: number) => Promise<boolean>
  concurrency?: number
}): Promise<LanPeer[]> {
  const targets = scanTargets(opts.ifaces, opts.own)
  const open: LanPeer[] = []
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
  return skipSelf(open, opts.own)
    .sort((a, b) => (ipv4ToInt(a.host) ?? 0) - (ipv4ToInt(b.host) ?? 0))
    .slice(0, MAX_LAN_PEERS)
}
