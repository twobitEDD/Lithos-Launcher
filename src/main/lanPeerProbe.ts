import { connect } from 'node:net'

/**
 * True when `host:port` accepts TCP. That is Ergo's peer port (scorex.network.bindAddress).
 * Writes nothing. Stratum's mining.subscribe probe is a different check on a different port.
 */
export function probePeerPort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
  })
}
