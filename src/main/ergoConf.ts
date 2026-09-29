import { mkdir } from 'node:fs/promises'
import {
  DEFAULT_NODE_API_PORT,
  DEFAULT_NODE_P2P_PORT,
  DEFAULT_OFFLINE_GENERATION,
  type Network,
  type NodeSettings,
  type NodeSettingsPatch
} from '@shared/types'
import { CLIENT_DEFAULT_PORTS, layout } from './layout'
import { readManagedNumber, readManagedValue, updateManagedLines, writeManagedBlock } from './managedBlock'

/** blake2b256("hello"): the documented default key, used only for the first boot. */
export const HELLO_HASH = '324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf'
export const HELLO_KEY = 'hello'

// Settings the user can change are written as top-level dotted keys, one per line, so they can be
// read back from the managed block (and a later key overrides the nested block above it in HOCON).
const KEYS = {
  offlineGeneration: 'ergo.node.offlineGeneration',
  apiBind: 'scorex.restApi.bindAddress',
  p2pBind: 'scorex.network.bindAddress'
} as const

/** What the launcher and client rely on; custom settings that change these are flagged. */
export const MANAGED_NODE_KEYS = [
  'ergo.directory',
  'ergo.networkType',
  'ergo.node.mining',
  'ergo.node.useExternalMiner',
  'ergo.node.extraIndex',
  'ergo.node.mempoolSorting',
  KEYS.offlineGeneration,
  'ergo.wallet.secretStorage.secretDir',
  KEYS.apiBind,
  'scorex.restApi.apiKeyHash',
  KEYS.p2pBind
] as const

function parseBindPort(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  let value = raw.trim()
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') value = parsed
  } catch {
    // unquoted HOCON string
  }
  const match = /:(\d+)\s*$/.exec(value)
  if (!match) return fallback
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

function checkNodePort(port: number, what: string): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${what} must be a port from 1024 to 65535`)
  }
}

/** Settings from the managed block; the node's own per-network default when never changed. */
export async function readNodeSettings(root: string, network: Network): Promise<NodeSettings> {
  const file = layout.ergoConf(root, network)
  const offline = await readManagedValue(file, KEYS.offlineGeneration)
  return {
    offlineGeneration: offline === 'true' ? true : offline === 'false' ? false : DEFAULT_OFFLINE_GENERATION[network],
    apiPort: parseBindPort(await readManagedValue(file, KEYS.apiBind), DEFAULT_NODE_API_PORT[network]),
    p2pPort: parseBindPort(await readManagedValue(file, KEYS.p2pBind), DEFAULT_NODE_P2P_PORT[network])
  }
}

/** Saves node settings; the node reads them on its next start. */
export async function updateNodeSettings(
  root: string,
  network: Network,
  patch: NodeSettingsPatch
): Promise<NodeSettings> {
  const current = await readNodeSettings(root, network)
  const next: NodeSettings = {
    offlineGeneration: patch.offlineGeneration ?? current.offlineGeneration,
    apiPort: patch.apiPort ?? current.apiPort,
    p2pPort: patch.p2pPort ?? current.p2pPort
  }
  checkNodePort(next.apiPort, 'The Ergo API port')
  checkNodePort(next.p2pPort, 'The Ergo peer port')
  if (next.apiPort === next.p2pPort) throw new Error('The Ergo API and peer ports must be different')
  // Read client ports directly to avoid a circular import with clientConf.
  const clientFile = layout.clientConf(root, network)
  const httpPort = (await readManagedNumber(clientFile, 'play.server.http.port')) ?? CLIENT_DEFAULT_PORTS.http
  const stratumPort = (await readManagedNumber(clientFile, 'stratum.stratumPort')) ?? CLIENT_DEFAULT_PORTS.stratum
  if (next.apiPort === httpPort || next.apiPort === stratumPort) {
    throw new Error(`The Ergo API port can't use ${next.apiPort}: the Lithos Client needs it`)
  }
  if (next.p2pPort === httpPort || next.p2pPort === stratumPort) {
    throw new Error(`The Ergo peer port can't use ${next.p2pPort}: the Lithos Client needs it`)
  }

  const entries: Record<string, string> = {
    [KEYS.offlineGeneration]: String(next.offlineGeneration),
    [KEYS.apiBind]: JSON.stringify(`127.0.0.1:${next.apiPort}`),
    [KEYS.p2pBind]: JSON.stringify(`0.0.0.0:${next.p2pPort}`)
  }
  await mkdir(layout.nodeDir(root, network), { recursive: true })
  await updateManagedLines(layout.ergoConf(root, network), entries)
  return readNodeSettings(root, network)
}

interface NodeConf {
  network: Network
  dataDir: string
  apiKeyHash: string
  settings: NodeSettings
}

/** The launcher-managed part of ergo.conf. */
function nodeBlock(c: NodeConf): string[] {
  const q = JSON.stringify // JSON strings are valid HOCON quoted strings
  const lines = [
    'ergo {',
    `  directory = ${q(c.dataDir)}`,
    `  networkType = ${q(c.network)}`,
    '  node {',
    '    mining = true',
    '    useExternalMiner = true',
    '    extraIndex = true',
    // The node defaults to "random"; the Lithos Client expects its node.mempoolSorting to match ("bySize").
    '    mempoolSorting = "bySize"',
    '  }'
  ]
  if (c.network === 'mainnet') {
    lines.push('  chain.reemission.checkReemissionRules = true', '  wallet.checkEIP27 = true')
  } else {
    lines.push(
      '  chain.voting.version2ActivationHeight = 2147483647',
      '  chain.voting.version2ActivationDifficultyHex = "20"'
    )
  }
  lines.push(
    '}',
    'scorex {',
    '  restApi {',
    // Ergo binds to 0.0.0.0 by default; keep the API on this machine only.
    `    bindAddress = ${q(`127.0.0.1:${c.settings.apiPort}`)}`,
    `    apiKeyHash = ${q(c.apiKeyHash)}`,
    '  }',
    '  network {',
    `    nodeName = ${q(`lithos-${c.network}-node`)}`,
    // Explicit so a custom peer port sticks across rewrites (Ergo's default is network-specific).
    `    bindAddress = ${q(`0.0.0.0:${c.settings.p2pPort}`)}`
  )
  if (c.network === 'testnet') {
    lines.push('    knownPeers = ["128.253.41.110:9020"]', '    peerDiscovery = true')
  }
  lines.push('  }', '}')
  // Always written, so the file says what the node runs with. Ergo's mainnet.conf turns it on.
  lines.push(`${KEYS.offlineGeneration} = ${c.settings.offlineGeneration}`)
  // Top-level dotted forms so readNodeSettings can round-trip ports without parsing nested HOCON.
  lines.push(`${KEYS.apiBind} = ${q(`127.0.0.1:${c.settings.apiPort}`)}`)
  lines.push(`${KEYS.p2pBind} = ${q(`0.0.0.0:${c.settings.p2pPort}`)}`)
  return lines
}

export async function writeNodeConf(root: string, network: Network, apiKeyHash: string): Promise<void> {
  const dataDir = layout.nodeDataDir(root, network)
  await mkdir(dataDir, { recursive: true })
  const settings = await readNodeSettings(root, network)
  await writeManagedBlock(layout.ergoConf(root, network), nodeBlock({ network, dataDir, apiKeyHash, settings }))
}
