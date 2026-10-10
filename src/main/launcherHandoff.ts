import { app } from 'electron'
import type { LauncherAdvertExtras } from '@shared/chainCopy'
import { NODE_SYNCED_SLACK, walletScanState, type WalletScanInfo } from '@shared/workWith'
import type { ChainCopyCoordinator } from './chainCopyService'
import type { ClientController } from './clientController'
import { readClientSettings } from './clientConf'
import type { LauncherDeferral } from './deferral'
import { CLIENT_DEFAULT_PORTS } from './layout'
import type { NodeController } from './nodeController'
import { settings } from './settings'
import { soatPaths, writeLauncherHandoff } from './soatControl'
import type { WalletManager } from './wallet'

const WRITE_MS = 30_000
const MIN_GAP_MS = 2000

/**
 * Tells this computer's SOAT service how far the wallet has scanned and which LAN launchers the
 * chain-seed scan found, and gives the chain-seed advert its miner part for other computers.
 * Hosts, heights and states only: no addresses, keys, or paths.
 */
export class LauncherHandoffWriter {
  private timer: NodeJS.Timeout | null = null
  private lastWrite = 0
  private pending: NodeJS.Timeout | null = null

  constructor(
    private readonly root: string,
    private readonly node: NodeController,
    private readonly client: ClientController,
    private readonly wallet: WalletManager,
    private readonly chainCopy: () => ChainCopyCoordinator | null,
    private readonly deferral: LauncherDeferral
  ) {}

  attach(): void {
    this.wallet.on('state', () => this.soon())
    this.node.proc.on('state', () => this.soon())
    this.client.proc.on('state', () => this.soon())
    this.timer = setInterval(() => void this.write(), WRITE_MS)
    this.timer.unref?.()
    this.soon()
  }

  walletScan(): WalletScanInfo {
    const w = this.wallet.state
    const info = this.node.info
    return walletScanState({
      phase: w.phase,
      walletHeight: w.walletHeight,
      nodeRunning: this.node.proc.state.status === 'running' && this.node.runningNetwork === w.network,
      fullHeight: info?.fullHeight ?? null,
      headersHeight: info?.headersHeight ?? null
    })
  }

  async extras(): Promise<LauncherAdvertExtras> {
    const network = this.node.runningNetwork ?? settings().nodeNetwork ?? 'mainnet'
    const stratumPort = await readClientSettings(this.root, network).then(
      (s) => s.stratumPort,
      () => CLIENT_DEFAULT_PORTS.stratum
    )
    const info = this.node.info
    const running = this.client.proc.state.status === 'running'
    const work = this.client.work
    return {
      version: app.getVersion(),
      stratumPort,
      synced:
        info && typeof info.fullHeight === 'number' && typeof info.headersHeight === 'number'
          ? info.headersHeight - info.fullHeight <= NODE_SYNCED_SLACK
          : null,
      client: {
        running,
        hasJob: running ? (work === 'ready' ? true : work === 'none' ? false : null) : false,
        rigs: running ? (this.client.stats?.rigs ?? null) : 0
      },
      walletScan: this.walletScan().state
    }
  }

  private soon(): void {
    if (this.pending) return
    const wait = Math.max(0, this.lastWrite + MIN_GAP_MS - Date.now())
    this.pending = setTimeout(() => {
      this.pending = null
      void this.write()
    }, wait)
  }

  private async write(): Promise<void> {
    this.lastWrite = Date.now()
    const hosts = new Set<string>(this.deferral.stratums().map((s) => s.host))
    for (const seed of this.chainCopy()?.current().seeds ?? []) hosts.add(seed.host)
    await writeLauncherHandoff(soatPaths(this.root).launcherState, {
      network: this.wallet.state.network ?? this.node.runningNetwork,
      walletScan: this.walletScan(),
      hosts: [...hosts]
    }).catch(() => undefined)
  }
}
