import { planNodeAutoStart, type NodeAutoStartResult } from '@shared/nodeAutoStart'
import type { Network } from '@shared/types'
import type { LauncherDeferral } from './deferral'
import { HELLO_KEY, readNodeSettings } from './ergoConf'
import type { Installer } from './installer'
import { NodeApi } from './nodeApi'
import type { NodeController } from './nodeController'
import { resolveNodeStart } from './nodeStart'
import { settings } from './settings'
import { errorMessage, isPortListening } from './util'
import type { Vault } from './vault'

/** The "Start node automatically when the launcher opens" setting. Absent means on. */
export function nodeAutoStart(): boolean {
  return settings().autoStartNode !== false
}

/** Starts or adopts the node once per launcher run, when the window first asks. */
export class NodeAutoStarter {
  private attempted = false

  constructor(
    private readonly root: string,
    private readonly vault: Vault,
    private readonly node: NodeController,
    private readonly installer: Installer,
    private readonly deferral: LauncherDeferral
  ) {}

  /**
   * The window normally asks right after it loads, with the network it shows. If it hasn't asked
   * after `delayMs`, start on the network the node last ran on (mainnet before the first run).
   */
  fallbackAfter(delayMs: number): void {
    setTimeout(() => {
      if (this.attempted) return
      void this.run(settings().nodeNetwork ?? 'mainnet').catch((err: unknown) =>
        this.node.proc.log(`Automatic start failed: ${errorMessage(err)}`)
      )
    }, delayMs)
  }

  async run(network: Network): Promise<NodeAutoStartResult> {
    const attempted = this.attempted
    this.attempted = true
    const enabled = nodeAutoStart()
    if (!enabled || attempted) {
      return planNodeAutoStart({
        enabled,
        attempted,
        nodeStatus: this.node.proc.state.status,
        installing: false,
        remoteLauncher: null,
        javaInstalled: false,
        nodeInstalled: false,
        apiPort: 0,
        checkPort: async () => ({ action: 'start' })
      })
    }
    const [state, remoteLauncher] = await Promise.all([this.installer.state(network), this.deferral.settled()])
    const { apiPort } = await readNodeSettings(this.root, network)
    const plan = await planNodeAutoStart({
      enabled,
      attempted,
      nodeStatus: this.node.proc.state.status,
      installing: this.installer.installing,
      remoteLauncher,
      javaInstalled: state.java.installed,
      nodeInstalled: state.node.installed,
      apiPort,
      checkPort: async () => {
        const portOpen = await isPortListening(apiPort)
        const known = this.vault.getNodeKey(network)?.key
        const keys = [...new Set([known, HELLO_KEY].filter((key): key is string => Boolean(key)))]
        const decision = await resolveNodeStart({
          portOpen,
          keys: portOpen ? keys : [],
          accepts: (key) => new NodeApi(apiPort).accepts(key).catch(() => false)
        })
        return { action: decision.action }
      }
    })

    if (plan.action === 'skip') {
      if (plan.message) {
        this.node.proc.log(plan.message)
        // The Node card already explains a remote launcher or a missing install, and those clear
        // themselves; a foreign node on the port does not.
        const { status } = this.node.proc.state
        if (plan.reason === 'port-busy' && (status === 'stopped' || status === 'crashed')) {
          this.node.proc.setState({ detail: plan.message })
        }
      }
      return plan
    }
    this.node.proc.log(
      plan.action === 'adopt'
        ? 'Launcher opened: using the node already running on this computer.'
        : 'Launcher opened: starting the node automatically.'
    )
    // start() adopts a running node itself and reports its own failures on the Node card.
    void this.node.start(network).catch((err: unknown) => this.node.proc.log(`Automatic start failed: ${errorMessage(err)}`))
    return plan
  }
}
