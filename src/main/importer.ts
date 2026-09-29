import { cp, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_DIFF_RE } from '@shared/mining'
import { ERGO_DB_LABEL, ergoDb, isNetwork, type ImportOptions, type ImportPreview, type Network } from '@shared/types'
import { readClientSettings, updateClientSettings } from './clientConf'
import { chainDb, detectErgo } from './ergo'
import { readNodeSettings } from './ergoConf'
import { layout } from './layout'
import { pinnedVersion, updateSettings } from './settings'
import { isPortListening, writeFileAtomic } from './util'

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Total bytes under `dir`, walked iteratively (a synced chain has thousands of files). */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const path = join(current, e.name)
      if (e.isDirectory()) stack.push(path)
      else if (e.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size
    }
  }
  return total
}

/** The node data folder: the picked folder itself, or a .ergo inside it. */
async function findDataDir(picked: string): Promise<string | null> {
  for (const candidate of [picked, join(picked, '.ergo')]) {
    if ((await isDir(join(candidate, 'history'))) && (await isDir(join(candidate, 'state')))) return candidate
  }
  return null
}

/** networkType from any .conf beside the data folder (node configs usually sit there). */
async function detectNetwork(dataDir: string): Promise<Network | null> {
  const folder = dirname(dataDir)
  let files: string[]
  try {
    files = (await readdir(folder)).filter((f) => f.endsWith('.conf'))
  } catch {
    return null
  }
  for (const file of files) {
    const text = await readFile(join(folder, file), 'utf8').catch(() => '')
    const found = /\bnetworkType\s*[=:]\s*"?(mainnet|testnet)"?/i.exec(text)?.[1]?.toLowerCase()
    if (isNetwork(found)) return found
  }
  return null
}

const PLAINTEXT_SECRET_RE = /^(\s*(?:node\.)?(key|pass)\s*[=:]\s*)"[^"]+"/gm

async function inspectClient(picked: string): Promise<ImportPreview['client']> {
  for (const conf of [join(picked, 'bin', 'lithos.conf'), join(picked, 'lithos.conf')]) {
    if (!(await exists(conf))) continue
    const text = await readFile(conf, 'utf8')
    const lithosData = join(dirname(conf), '.lithos')
    const hasData = await isDir(lithosData)
    const num = (re: RegExp): number | null => {
      const m = re.exec(text)?.[1]
      return m ? Number(m) : null
    }
    const diff = /\bdiff\s*[=:]\s*"([^"]+)"/.exec(text)?.[1] ?? null
    const autoCommit = /\bautoCommit\s*[=:]\s*(true|false)/.exec(text)?.[1]
    return {
      conf,
      diff: diff && CONFIG_DIFF_RE.test(diff) ? diff : null,
      autoCommit: autoCommit === undefined ? null : autoCommit === 'true',
      httpPort: num(/\bhttp\.port\s*[=:]\s*(\d+)/),
      stratumPort: num(/\bstratumPort\s*[=:]\s*(\d+)/),
      plaintextSecrets: new RegExp(PLAINTEXT_SECRET_RE.source, 'm').test(text),
      lithosData: hasData ? lithosData : null,
      lithosDataBytes: hasData ? await dirSize(lithosData) : 0
    }
  }
  throw new Error('No lithos.conf found there. Pick the lithos-client folder (the one containing bin/).')
}

/**
 * Adopts an existing node (and optionally client) setup. The chain and wallet stay where they
 * are and are used in place: nothing big is copied, and nothing needs to re-sync.
 */
export class Importer {
  private previews: Partial<Record<Network, ImportPreview>> = {}

  constructor(private readonly root: string) {}

  async inspect(network: Network, nodeFolder: string, clientFolder: string | null): Promise<ImportPreview> {
    const dataDir = await findDataDir(nodeFolder)
    if (!dataDir) throw new Error('No Ergo node data here. Pick the node folder, or the .ergo folder inside it.')
    const [chainBytes, hasWallet, detectedNetwork, client, dataDb, node] = await Promise.all([
      dirSize(join(dataDir, 'history')),
      readdir(join(dataDir, 'wallet', 'keystore'))
        .then((f) => f.some((n) => n.endsWith('.json')))
        .catch(() => false),
      detectNetwork(dataDir),
      clientFolder ? inspectClient(clientFolder) : Promise.resolve(null),
      chainDb(dataDir),
      detectErgo(layout.nodeDir(this.root, network), pinnedVersion(network, 'node'))
    ])

    const warnings: string[] = []
    if (detectedNetwork && detectedNetwork !== network) {
      warnings.push(`The config next to this folder says ${detectedNetwork}, but you are importing it as ${network}.`)
    }
    const nodeDb = node ? ergoDb(node.version) : null
    if (dataDb && nodeDb && dataDb !== nodeDb) {
      warnings.push(
        `This chain is stored in ${ERGO_DB_LABEL[dataDb]}, but the launcher's node (${node?.version}) uses ` +
          `${ERGO_DB_LABEL[nodeDb]} and can't read it. After importing, open Versions and pick a ` +
          `${ERGO_DB_LABEL[dataDb]} version of the node.`
      )
    }
    if (!hasWallet) warnings.push('No wallet was found in this data. You can create or restore one after importing.')
    const apiPort = (await readNodeSettings(this.root, network)).apiPort
    if (await isPortListening(apiPort)) {
      warnings.push(`Something is using port ${apiPort}. Stop your old node before starting it here.`)
    }
    const preview: ImportPreview = { network, dataDir, chainBytes, hasWallet, detectedNetwork, client, warnings }
    this.previews[network] = preview
    return preview
  }

  /** Applies the last inspected preview for `network`. */
  async apply(network: Network, options: ImportOptions): Promise<void> {
    const preview = this.previews[network]
    if (!preview) throw new Error('Inspect the setup first')
    await updateSettings((s) => {
      s.dataDirs = { ...s.dataDirs, [network]: preview.dataDir }
    })

    const client = preview.client
    if (client && options.importClientSettings) {
      const current = await readClientSettings(this.root, network)
      await updateClientSettings(this.root, network, {
        ...(client.diff ? { diff: client.diff } : {}),
        ...(client.autoCommit !== null ? { autoCommit: client.autoCommit } : {}),
        ...(client.httpPort || client.stratumPort
          ? { httpPort: client.httpPort ?? current.httpPort, stratumPort: client.stratumPort ?? current.stratumPort }
          : {})
      })
    }
    if (client?.lithosData && options.copyLithosData) {
      const target = join(layout.clientDir(this.root, network), '.lithos')
      if (await exists(target)) throw new Error(`The launcher already has client data at ${target}; not overwriting it.`)
      await cp(client.lithosData, target, { recursive: true })
    }
  }

  async clear(network: Network): Promise<void> {
    await updateSettings((s) => {
      if (s.dataDirs) delete s.dataDirs[network]
    })
  }

  /**
   * The launcher never uses the old lithos.conf, but its plaintext node key and wallet password
   * stay readable there. Replace just those values with the env references the client supports.
   * No backup is kept: a backup would keep the plaintext.
   */
  async scrubSecrets(network: Network): Promise<void> {
    const conf = this.previews[network]?.client?.conf
    if (!conf) throw new Error('Inspect the old client folder first')
    const text = await readFile(conf, 'utf8')
    const next = text.replace(PLAINTEXT_SECRET_RE, (_m, prefix: string, which: string) =>
      `${prefix}\${?${which === 'key' ? 'NODE_KEY_ENV' : 'NODE_PASS_ENV'}}`
    )
    if (next !== text) await writeFileAtomic(conf, next)
    const preview = this.previews[network]
    if (preview?.client) preview.client.plaintextSecrets = false
  }
}
