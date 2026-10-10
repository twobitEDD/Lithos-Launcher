// The SOAT service's view of the LAN launchers it may mine through: the stratums Lithos Launcher
// found, plus each host's chain-seed advert (port 9077) for live details. No Electron imports.
import { CHAIN_SEED_PATH, CHAIN_SEED_PORT, parseAdvert, type ChainSeedAdvert } from '../shared/chainCopy.ts'
import type { StratumTarget } from '../shared/soatMiner.ts'
import { isLanHost, lanLauncherFrom, type LanLauncher } from '../shared/workWith.ts'

/** Adverts are asked for again after this long; the service polls every few seconds. */
export const ADVERT_TTL_MS = 20_000
const ADVERT_TIMEOUT_MS = 2000
const MAX_HOSTS = 32

export async function fetchLauncherAdvert(host: string): Promise<ChainSeedAdvert | null> {
  try {
    const res = await fetch(`http://${host}:${CHAIN_SEED_PORT}${CHAIN_SEED_PATH}`, { signal: AbortSignal.timeout(ADVERT_TIMEOUT_MS) })
    return res.ok ? parseAdvert(await res.json()) : null
  } catch {
    return null
  }
}

export class LanLauncherView {
  private cache = new Map<string, { at: number; advert: ChainSeedAdvert | null }>()
  private readonly fetchAdvert: (host: string) => Promise<ChainSeedAdvert | null>
  private readonly now: () => number

  constructor(fetchAdvert: (host: string) => Promise<ChainSeedAdvert | null> = fetchLauncherAdvert, now: () => number = Date.now) {
    this.fetchAdvert = fetchAdvert
    this.now = now
  }

  /**
   * One row per LAN host, lowest address first: `stratums` answered the stratum scan, `hosts`
   * answered on the chain-seed port. Only private IPv4 addresses are asked.
   */
  async list(stratums: readonly StratumTarget[], hosts: readonly string[]): Promise<LanLauncher[]> {
    const ports = new Map<string, number>()
    for (const s of stratums) if (isLanHost(s.host) && !ports.has(s.host)) ports.set(s.host, s.port)
    const all = [...new Set([...ports.keys(), ...hosts.filter((h) => isLanHost(h))])].slice(0, MAX_HOSTS)
    const now = this.now()
    await Promise.all(
      all.map(async (host) => {
        const hit = this.cache.get(host)
        if (hit && now - hit.at < ADVERT_TTL_MS) return
        this.cache.set(host, { at: now, advert: await this.fetchAdvert(host).catch(() => null) })
      })
    )
    for (const host of this.cache.keys()) if (!all.includes(host)) this.cache.delete(host)
    return all
      .map((host) => lanLauncherFrom(host, ports.get(host) ?? null, this.cache.get(host)?.advert ?? null))
      .sort((a, b) => a.host.localeCompare(b.host, 'en', { numeric: true }))
  }
}
