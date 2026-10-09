import { homedir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { autoHeapFor } from '@shared/heap'
import type { Network } from '@shared/types'
import { settings } from './settings'

const EXE = process.platform === 'win32' ? '.exe' : ''

export const defaultRoot = (): string => join(homedir(), 'Lithos')

/**
 * Everything the launcher installs lives under one root: `~/Lithos` by default, or the folder
 * chosen in Settings. LITHOS_LAUNCHER_ROOT overrides both for development and testing.
 */
export function installRoot(): string {
  return resolve(process.env.LITHOS_LAUNCHER_ROOT || settings().root || defaultRoot())
}

/** The node's data folder: the launcher's own, or one adopted from an existing setup. */
const nodeDataDir = (root: string, net: Network): string =>
  settings().dataDirs?.[net] ?? join(root, net, 'node', '.ergo')

export const layout = {
  javaDir: (root: string) => join(root, 'java', 'temurin-11-jre'),
  javaBin: (root: string) => join(root, 'java', 'temurin-11-jre', 'bin', `java${EXE}`),
  netDir: (root: string, net: Network) => join(root, net),
  nodeDir: (root: string, net: Network) => join(root, net, 'node'),
  nodeDataDir,
  ergoConf: (root: string, net: Network) => join(root, net, 'node', 'ergo.conf'),
  walletDir: (root: string, net: Network) => join(nodeDataDir(root, net), 'wallet'),
  keystoreDir: (root: string, net: Network) => join(nodeDataDir(root, net), 'wallet', 'keystore'),
  /**
   * The client's working directory: lithos.conf, .lithos/ data and logs/ live here, while each
   * release unpacks into its own lithos-client-<version>/ subfolder, so updates keep the data.
   */
  clientDir: (root: string, net: Network) => join(root, net, 'client'),
  clientConf: (root: string, net: Network) => join(root, net, 'client', 'lithos.conf'),
  /** SOAT releases unpack here as soat-miner_v<version>_<os>/, next to soat-miner.log. */
  minerDir: (root: string) => join(root, 'miner')
}

export const CLIENT_DEFAULT_PORTS = { http: 9000, stratum: 4444 }
/** lithos.conf keys for the client's ports; ergoConf reads them too, to keep the node off them. */
export const CLIENT_PORT_KEYS = { http: 'play.server.http.port', stratum: 'stratum.stratumPort' } as const

/** JVM heap limits sized from system RAM. Read at each start, so a change applies on the next start. */
export function autoHeap(totalBytes = totalmem()): { nodeMb: number; clientMb: number } {
  return autoHeapFor(totalBytes)
}

/** The heap sizes actually used: Settings overrides, else sized from RAM. */
export function heapPlan(): { nodeMb: number; clientMb: number } {
  const auto = autoHeap()
  const heap = settings().heap
  return { nodeMb: heap?.nodeMb ?? auto.nodeMb, clientMb: heap?.clientMb ?? auto.clientMb }
}

/** Environment for Java child processes: our JRE, and no user-level JVM flag injection. */
export function javaEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: layout.javaDir(root) }
  for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_OPTS', 'ELECTRON_RUN_AS_NODE']) {
    delete env[key]
  }
  return env
}
