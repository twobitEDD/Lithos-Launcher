import { connect } from 'node:net'
import type { PortProbe } from '../shared/chainCopy.ts'

/**
 * True when `host:port` accepts TCP. That is Ergo's peer port (scorex.network.bindAddress).
 * Writes nothing. Stratum's mining.subscribe probe is a different check on a different port.
 */
export function probePeerPort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return probePortDetail(host, port, timeoutMs).then((result) => result === 'open')
}

/**
 * How a TCP connect to `host:port` ends. A refusal comes back at once (nothing listens);
 * a timeout means a firewall dropped the packets. Writes nothing.
 */
export function probePortDetail(host: string, port: number, timeoutMs = 300): Promise<PortProbe> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (result: PortProbe): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish('timeout'))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ECONNREFUSED' ? 'refused' : err.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable')
    })
    socket.once('connect', () => finish('open'))
  })
}
