import { DEFAULT_NODE_P2P_PORT, type Network, type ProcState } from '@shared/types'
import { addLanPeers, peeringAllowed, type LanPeerStatus } from '../shared/lanPeers.ts'
import { discoverLanPeers } from './lanPeerDiscover.ts'
import { readNodeSettings } from './ergoConf.ts'
import { ownIpv4Addresses, physicalLanIfaces } from './lanDiscover.ts'
import { probePeerPort } from './lanPeerProbe.ts'
import type { NodeController } from './nodeController.ts'
import { settings, updateSettings } from './settings.ts'
import { errorMessage } from './util.ts'

const PROBE_MS = 300

export function currentLanPeerStatus(): LanPeerStatus {
  return { enabled: peeringAllowed(settings().lanPeering), phase: 'idle', found: 0, hosts: [] }
}

/**
 * After the local node is up, find other full nodes on this LAN and connect to them
 * through the node's peer API. A miss, a timeout, or the switch being off does not
 * stop the node from starting. Deferral (stratum) is a separate decision.
 */
export class LanPeerCoordinator {
  private generation = 0
  private status: LanPeerStatus = currentLanPeerStatus()

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly emit: (status: LanPeerStatus) => void,
    private readonly log: (line: string) => void
  ) {}

  current(): LanPeerStatus {
    return this.status
  }

  attach(): void {
    this.node.on('ready', (network: Network) => {
      void this.sync(network)
    })
    this.node.proc.on('state', (state: ProcState) => {
      if (state.status === 'stopping' || state.status === 'stopped' || state.status === 'crashed') {
        this.generation++
        if (state.status !== 'stopping') {
          this.publish({ enabled: peeringAllowed(settings().lanPeering), phase: 'idle', found: 0, hosts: [] })
        }
      }
    })
    this.publish(this.status)
  }

  async setEnabled(on: boolean): Promise<LanPeerStatus> {
    await updateSettings((next) => {
      next.lanPeering = on
    })
    this.generation++
    if (!on) {
      this.publish({ enabled: false, phase: 'idle', found: 0, hosts: [] })
      return this.status
    }
    const network = this.node.runningNetwork
    if (network) {
      this.publish({ enabled: true, phase: 'searching', found: 0, hosts: [] })
      void this.sync(network)
    } else {
      this.publish({ enabled: true, phase: 'idle', found: 0, hosts: [] })
    }
    return this.status
  }

  /** Looks up the peer port, probes the LAN, then asks the node to connect. Never throws outward. */
  private async sync(network: Network): Promise<void> {
    const gen = ++this.generation
    if (!peeringAllowed(settings().lanPeering)) {
      this.publish({ enabled: false, phase: 'idle', found: 0, hosts: [] })
      return
    }
    this.publish({ enabled: true, phase: 'searching', found: 0, hosts: [] })
    try {
      const port = await this.peerPort(network)
      if (gen !== this.generation) return
      const own = ownIpv4Addresses()
      const peers = await discoverLanPeers({
        ifaces: physicalLanIfaces(),
        own,
        port,
        probe: (host, peerPort) => probePeerPort(host, peerPort, PROBE_MS)
      })
      if (gen !== this.generation) return
      const conn = this.node.connection()
      if (conn && peers.length > 0) {
        const { added, failed } = await addLanPeers(peers, own, (address) => conn.api.connectPeer(conn.apiKey, address))
        if (gen !== this.generation) return
        for (const peer of added) this.log(`Added LAN peer ${peer.host}:${peer.port} for block download`)
        for (const peer of failed) this.log(`Could not add LAN peer ${peer.host}:${peer.port}`)
      } else if (peers.length === 0) {
        this.log('No other Ergo node is accepting the peer port on this network.')
      } else {
        this.log('Found LAN nodes, but the node API is not ready to add them yet.')
      }
      if (gen !== this.generation) return
      this.publish({
        enabled: true,
        phase: 'done',
        found: peers.length,
        hosts: peers.map((peer) => peer.host)
      })
    } catch (err) {
      if (gen !== this.generation) return
      this.log(`LAN peer lookup failed: ${errorMessage(err)}`)
      this.publish({ enabled: true, phase: 'done', found: 0, hosts: [] })
    }
  }

  /** Configured scorex.network.bindAddress port, or Ergo's default for the network. */
  private async peerPort(network: Network): Promise<number> {
    try {
      const node = await readNodeSettings(this.root, network)
      if (Number.isInteger(node.p2pPort) && node.p2pPort > 0 && node.p2pPort <= 65535) return node.p2pPort
    } catch {
      // missing ergo.conf: Ergo's own default peer port
    }
    return DEFAULT_NODE_P2P_PORT[network]
  }

  private publish(status: LanPeerStatus): void {
    this.status = status
    this.emit(status)
  }
}
