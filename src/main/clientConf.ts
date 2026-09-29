import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIFF_RE } from '@shared/mining'
import {
  DEFAULT_REDUCTION_MULTIPLIER,
  REDUCTION_MULTIPLIERS,
  type ClientSettings,
  type ClientSettingsPatch,
  type Network
} from '@shared/types'
import { readNodeSettings } from './ergoConf'
import { CLIENT_DEFAULT_PORTS, layout } from './layout'
import { readManagedNumber, readManagedValue, updateManagedLines, writeManagedBlock } from './managedBlock'

/** Environment variables the client reads its secrets from (names from the client README). */
export const CLIENT_ENV = {
  nodeKey: 'NODE_KEY_ENV',
  nodePass: 'NODE_PASS_ENV',
  playSecret: 'PLAY_ENV'
} as const

const KEYS = {
  httpAddress: 'play.server.http.address',
  httpPort: 'play.server.http.port',
  stratumPort: 'stratum.stratumPort',
  diff: 'stratum.diff',
  autoCommit: 'state.autoCommit',
  forceConfigDiff: 'stratum.forceConfigDiff',
  reductionMultiplier: 'stratum.reductionMultiplier'
} as const

/** What the launcher relies on or sets from its own UI; custom settings that change these are flagged. */
export const MANAGED_CLIENT_KEYS = [
  'node.url',
  'node.key',
  'node.pass',
  'node.storagePath',
  'node.networkType',
  'node.mempoolSorting',
  'play.http.secret.key',
  'play.filters.hosts.allowed',
  'lithos.apiKeyHash',
  'stratum.reduceShareMessages',
  ...Object.values(KEYS)
] as const

const LOCAL_ADDRESS = '127.0.0.1'
const ALL_ADDRESSES = '0.0.0.0'

function parseQuoted(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** Settings from the managed block, so choices stick across rewrites and releases. */
export async function readClientSettings(root: string, network: Network): Promise<ClientSettings> {
  const file = layout.clientConf(root, network)
  return {
    diff: parseQuoted(await readManagedValue(file, KEYS.diff)),
    autoCommit: (await readManagedValue(file, KEYS.autoCommit)) === 'true',
    forceConfigDiff: (await readManagedValue(file, KEYS.forceConfigDiff)) === 'true',
    httpPort: (await readManagedNumber(file, KEYS.httpPort)) ?? CLIENT_DEFAULT_PORTS.http,
    stratumPort: (await readManagedNumber(file, KEYS.stratumPort)) ?? CLIENT_DEFAULT_PORTS.stratum,
    reductionMultiplier: (await readManagedNumber(file, KEYS.reductionMultiplier)) ?? DEFAULT_REDUCTION_MULTIPLIER,
    lanPanel: parseQuoted(await readManagedValue(file, KEYS.httpAddress)) === ALL_ADDRESSES
  }
}

function checkPort(port: number, what: string, apiPort: number, p2pPort: number, network: Network): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${what} must be a port from 1024 to 65535`)
  if (port === apiPort || port === p2pPort) {
    throw new Error(`${what} can't use ${port}: the ${network} node needs it`)
  }
}

/** Validates and saves mining settings; the client reads them on its next start. */
export async function updateClientSettings(
  root: string,
  network: Network,
  patch: ClientSettingsPatch
): Promise<ClientSettings> {
  const entries: Record<string, string> = {}
  if (patch.diff !== undefined) {
    if (patch.diff === null || !CONFIG_DIFF_RE.test(patch.diff)) {
      throw new Error('A difficulty looks like "48M" or "1.2G": a number and a K, M, G, T or P suffix')
    }
    entries[KEYS.diff] = JSON.stringify(patch.diff)
  }
  if (patch.autoCommit !== undefined) entries[KEYS.autoCommit] = String(patch.autoCommit)
  if (patch.forceConfigDiff !== undefined) entries[KEYS.forceConfigDiff] = String(patch.forceConfigDiff)
  if (patch.httpPort !== undefined || patch.stratumPort !== undefined) {
    const current = await readClientSettings(root, network)
    const node = await readNodeSettings(root, network)
    const http = patch.httpPort ?? current.httpPort
    const stratum = patch.stratumPort ?? current.stratumPort
    checkPort(http, 'The panel port', node.apiPort, node.p2pPort, network)
    checkPort(stratum, 'The stratum port', node.apiPort, node.p2pPort, network)
    if (http === stratum) throw new Error('The panel and stratum need different ports')
    entries[KEYS.httpPort] = String(http)
    entries[KEYS.stratumPort] = String(stratum)
  }
  if (patch.reductionMultiplier !== undefined) {
    if (!(REDUCTION_MULTIPLIERS as readonly number[]).includes(patch.reductionMultiplier)) {
      throw new Error(`The share reporting multiplier is one of ${REDUCTION_MULTIPLIERS.join(', ')}`)
    }
    entries[KEYS.reductionMultiplier] = String(patch.reductionMultiplier)
  }
  if (patch.lanPanel !== undefined) {
    entries[KEYS.httpAddress] = JSON.stringify(patch.lanPanel ? ALL_ADDRESSES : LOCAL_ADDRESS)
  }
  await mkdir(layout.clientDir(root, network), { recursive: true })
  await updateManagedLines(layout.clientConf(root, network), entries)
  return readClientSettings(root, network)
}

interface ClientConf {
  network: Network
  appHome: string
  keystore: string
  lithosApiKeyHash: string
  settings: ClientSettings
  /** REST API port of the Ergo node this client talks to. */
  nodeApiPort: number
  /** This machine's LAN addresses and host name, accepted as Host headers while the panel is on the LAN. */
  lanHosts: string[]
}

/**
 * Play's allowed-hosts filter answers 400 to any Host header outside its list, which by default is
 * only localhost. Naming this machine's own addresses (rather than allowing every host) keeps the
 * filter's protection against DNS rebinding.
 */
function allowedHosts(lanHosts: string[]): string[] {
  return [...new Set(['localhost', LOCAL_ADDRESS, '.local', ...lanHosts.map((h) => h.toLowerCase())])]
}

/**
 * The launcher-managed part of lithos.conf. No secrets: the node API key, wallet
 * password and Play secret are substituted from environment variables at start.
 */
function clientBlock(c: ClientConf): string[] {
  const q = JSON.stringify // JSON strings are valid HOCON quoted strings
  const env = (name: string): string => `\${?${name}}`
  const s = c.settings
  const lines = [
    // Absolute path: include file() resolves relative paths against the working directory.
    `include file(${q(join(c.appHome, 'conf', 'application.conf'))})`,
    'node {',
    // Include the port: without it the client appends Ergo's network default (9053 / 9052).
    `  url = ${q(`http://127.0.0.1:${c.nodeApiPort}`)}`,
    `  key = ${env(CLIENT_ENV.nodeKey)}`,
    `  storagePath = ${q(c.keystore)}`,
    `  pass = ${env(CLIENT_ENV.nodePass)}`,
    `  networkType = ${q(c.network.toUpperCase())}`,
    // Must match the node's ergo.node.mempoolSorting, which the launcher sets to bySize.
    '  mempoolSorting = "bySize"',
    '}',
    `play.http.secret.key = ${env(CLIENT_ENV.playSecret)}`,
    `lithos.apiKeyHash = ${q(c.lithosApiKeyHash)}`,
    // Play listens on 0.0.0.0 by default. The panel stays on this machine unless the user opens it
    // to the LAN. Stratum has no bind setting and always listens on all interfaces, which rigs need.
    `${KEYS.httpAddress} = ${q(s.lanPanel ? ALL_ADDRESSES : LOCAL_ADDRESS)}`,
    `${KEYS.httpPort} = ${s.httpPort}`,
    `${KEYS.stratumPort} = ${s.stratumPort}`
  ]
  if (s.lanPanel) lines.push(`play.filters.hosts.allowed = ${q(allowedHosts(c.lanHosts))}`)
  if (s.diff) lines.push(`${KEYS.diff} = ${q(s.diff)}`)
  lines.push('stratum.reduceShareMessages = true', `${KEYS.reductionMultiplier} = ${s.reductionMultiplier}`)
  // Registration and commitment are on-chain and lock the difficulty for 845 blocks: opt-in only.
  lines.push(`${KEYS.autoCommit} = ${s.autoCommit}`, `${KEYS.forceConfigDiff} = ${s.forceConfigDiff}`)
  return lines
}

export async function writeClientConf(root: string, conf: ClientConf): Promise<void> {
  await mkdir(layout.clientDir(root, conf.network), { recursive: true })
  await writeManagedBlock(layout.clientConf(root, conf.network), clientBlock(conf))
}
