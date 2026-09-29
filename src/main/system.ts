import { access, statfs } from 'node:fs/promises'
import { networkInterfaces, totalmem } from 'node:os'
import { dirname } from 'node:path'
import type { Network, SystemCheck } from '@shared/types'
import { readClientSettings } from './clientConf'
import { readNodeSettings } from './ergoConf'
import { isPortListening } from './util'

// Adapters for WSL/Hyper-V, Docker and VMs, which other devices on the network can't reach.
const VIRTUAL_ADAPTER_RE = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|docker|^br-|^virbr|^veth/i

/**
 * Non-internal IPv4 addresses, for reaching this machine from rigs and phones on the LAN. Real
 * adapters come first, since the UI shows the first address.
 */
export function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, a })))
    .filter(({ a }) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .sort((x, y) => Number(VIRTUAL_ADAPTER_RE.test(x.name)) - Number(VIRTUAL_ADAPTER_RE.test(y.name)))
    .map(({ a }) => a.address)
}

/** Free bytes on the drive that holds `path` (or its nearest existing parent). */
async function freeBytes(path: string): Promise<number | null> {
  let dir = path
  for (;;) {
    try {
      await access(dir)
      break
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

/** What Quick setup checks before installing: memory, disk space and the ports everything needs. */
export async function systemCheck(root: string, network: Network): Promise<SystemCheck> {
  const [settings, node] = await Promise.all([readClientSettings(root, network), readNodeSettings(root, network)])
  const wanted = [
    { port: node.apiPort, label: 'Node API' },
    { port: node.p2pPort, label: 'Node peers' },
    { port: settings.httpPort, label: 'Lithos panel' },
    { port: settings.stratumPort, label: 'Stratum' }
  ]
  const ports = await Promise.all(wanted.map(async (p) => ({ ...p, free: !(await isPortListening(p.port)) })))
  return { totalMemBytes: totalmem(), freeDiskBytes: await freeBytes(root), installRoot: root, ports }
}
