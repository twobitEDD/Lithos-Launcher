import type { ProcStatus, RemoteLauncher } from './types'

/** Why the node was not started when the launcher opened. */
export type NodeAutoStartSkip =
  | 'off'
  | 'already-tried'
  | 'already-running'
  | 'installing'
  | 'remote-launcher'
  | 'no-java'
  | 'no-node'
  | 'port-busy'

export type NodeAutoStartResult =
  | { action: 'start' }
  | { action: 'adopt' }
  | { action: 'skip'; reason: NodeAutoStartSkip; message: string | null }

/** What the API port check found; mirrors resolveNodeStart in the main process. */
export type NodePortCheck = { action: 'start' } | { action: 'adopt' } | { action: 'busy' }

export interface NodeAutoStartInput {
  /** The "Start node automatically" setting. */
  enabled: boolean
  /** Auto-start already ran in this launcher session (the window was reopened from the tray). */
  attempted: boolean
  nodeStatus: ProcStatus
  installing: boolean
  /** The launcher on another machine this one defers to; null when ignored or none was found. */
  remoteLauncher: RemoteLauncher | null
  javaInstalled: boolean
  nodeInstalled: boolean
  apiPort: number
  /** Only called once everything else allows a start. */
  checkPort: () => Promise<NodePortCheck>
}

const skip = (reason: NodeAutoStartSkip, message: string | null = null): NodeAutoStartResult => ({
  action: 'skip',
  reason,
  message
})

/**
 * Whether to start the node when the launcher opens. A node already listening on the API port
 * with a key this launcher knows is adopted; one it can't talk to is left alone.
 */
export async function planNodeAutoStart(input: NodeAutoStartInput): Promise<NodeAutoStartResult> {
  if (!input.enabled) return skip('off')
  if (input.attempted) return skip('already-tried')
  if (input.nodeStatus !== 'stopped' && input.nodeStatus !== 'crashed') return skip('already-running')
  if (input.installing) {
    return skip('installing', 'Not started automatically: an install is in progress. Start the node once it finishes.')
  }
  if (input.remoteLauncher) {
    const { host, port } = input.remoteLauncher
    return skip(
      'remote-launcher',
      `Not started automatically: this computer is using the launcher at ${host}:${port}.`
    )
  }
  if (!input.javaInstalled || !input.nodeInstalled) {
    return skip(
      input.javaInstalled ? 'no-node' : 'no-java',
      `Not started automatically: ${input.javaInstalled ? 'the Ergo node' : 'Java'} is not installed yet. Install the components above first.`
    )
  }
  const port = await input.checkPort()
  if (port.action === 'adopt') return { action: 'adopt' }
  if (port.action === 'busy') {
    return skip(
      'port-busy',
      `Not started automatically: port ${input.apiPort} is already in use by a node this launcher can't use.`
    )
  }
  return { action: 'start' }
}
