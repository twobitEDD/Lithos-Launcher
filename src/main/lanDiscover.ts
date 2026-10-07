import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isStratumReply, type LanIface } from '../shared/lanDefer.ts'

const VIRTUAL_ADAPTER_RE = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|docker|^br-|^virbr|^veth/i

/** Every IPv4 on this machine, including loopback, so discovery never treats us as a peer. */
export function ownIpv4Addresses(): Set<string> {
  const own = new Set<string>(['127.0.0.1'])
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4') own.add(a.address)
    }
  }
  return own
}

/** Real LAN adapters only. Docker and VM bridges are not networks we sweep. */
export function physicalLanIfaces(): LanIface[] {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, a })))
    .filter(
      ({ name, a }) =>
        a.family === 'IPv4' &&
        !a.internal &&
        !a.address.startsWith('169.254.') &&
        !VIRTUAL_ADAPTER_RE.test(name) &&
        Boolean(a.netmask)
    )
    .map(({ a }) => ({ address: a.address, netmask: a.netmask }))
}

/**
 * True when `host:port` speaks stratum. Sends one mining.subscribe and disconnects.
 * A refused port is not a launcher. Timeout is short so a quiet subnet stays quick.
 */
export function probeStratum(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let buf = ''
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(isStratumReply(buf)))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['lithos-launcher'] })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      if (buf.length > 4096) buf = buf.slice(0, 4096)
      if (isStratumReply(buf)) finish(true)
    })
  })
}
