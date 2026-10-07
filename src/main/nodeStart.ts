export type NodeStartDecision =
  | { action: 'start' }
  | { action: 'adopt'; apiKey: string }
  | { action: 'busy' }

/**
 * A closed API port means this launcher should start a node.
 * An open port with a key the node accepts is adopted: no second process.
 * An open port with no working key is left alone, also without spawning.
 */
export async function resolveNodeStart(input: {
  portOpen: boolean
  keys: readonly string[]
  accepts: (key: string) => Promise<boolean>
}): Promise<NodeStartDecision> {
  if (!input.portOpen) return { action: 'start' }
  for (const key of input.keys) {
    if (!key) continue
    if (await input.accepts(key)) return { action: 'adopt', apiKey: key }
  }
  return { action: 'busy' }
}
