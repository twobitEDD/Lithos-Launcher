// The order a node is stopped in: the API's /node/shutdown, then a Ctrl+C / SIGTERM, and only
// after a long wait a hard kill. On Windows a hard kill is TerminateProcess: the JVM runs no
// shutdown hooks, and the next start replays blocks to restore a consistent state (hours on a
// slow disk). No Electron imports, so it can be unit-tested.

/** How long a node gets to close its databases before it is forced. */
export const NODE_STOP_TIMEOUT_MS = 2 * 60_000
/** After a forced kill, how long to wait for the exit to be reported. */
export const NODE_KILL_WAIT_MS = 10_000
/** Shown on the node card while a stop is in progress. */
export const STOPPING_DETAIL = "Stopping the node safely… (can take up to 2 minutes; don't close the launcher)"

export interface NodeStopSteps {
  /** POST /node/shutdown with the API key. Null when no key or port is known. */
  requestApi: (() => Promise<void>) | null
  /** Ctrl+C on Windows, SIGTERM elsewhere. Resolves true if delivered. */
  interrupt: () => Promise<boolean>
  waitForExit: (ms: number) => Promise<boolean>
  kill: () => void
  log: (line: string) => void
  timeoutMs?: number
  killWaitMs?: number
}

export type NodeStopResult = 'api' | 'interrupt' | 'killed'

/** Runs the stop sequence. Resolves with how the node ended up stopping. */
export async function stopNodeGracefully(steps: NodeStopSteps): Promise<NodeStopResult> {
  const timeout = steps.timeoutMs ?? NODE_STOP_TIMEOUT_MS
  if (steps.requestApi) {
    try {
      await steps.requestApi()
      steps.log(`Asked the node to shut down; waiting up to ${Math.round(timeout / 1000)} s for it to close its databases`)
      if (await steps.waitForExit(timeout)) return 'api'
      steps.log('The node accepted the shutdown request but is still running')
    } catch (err) {
      steps.log(`Shutdown request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Ctrl+C on Windows / SIGTERM on Linux: the JVM still runs its shutdown hooks.
  if (await steps.interrupt()) {
    steps.log('Sent the node an interrupt (like Ctrl+C)')
    if (await steps.waitForExit(steps.requestApi ? Math.min(timeout, 30_000) : timeout)) return 'interrupt'
  }
  steps.log('The node did not stop in time; forcing it to close. Its next start may take longer while it checks its state.')
  steps.kill()
  await steps.waitForExit(steps.killWaitMs ?? NODE_KILL_WAIT_MS)
  return 'killed'
}
