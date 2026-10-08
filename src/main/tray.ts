import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { MinerState } from '@shared/soatMiner'
import type { ProcState } from '@shared/types'

interface TrayOptions {
  open: () => void
  quit: () => void
  states: () => { node: ProcState; client: ProcState; miner: MinerState }
}

const describe = (s: ProcState): string =>
  s.status === 'running' && s.network ? `running on ${s.network}` : s.status === 'crashed' ? 'stopped unexpectedly' : s.status

const describeMiner = (m: MinerState): string =>
  m.status === 'running' && m.sample ? `running, ${m.sample.mhs.toFixed(1)} MH/s` : m.status

/**
 * The system tray entry that keeps mining going with the window closed. Created the first time
 * the user sends the launcher to the background.
 */
export class LauncherTray {
  private tray: Tray | null = null

  constructor(private readonly opts: TrayOptions) {}

  show(): void {
    if (!this.tray) {
      const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'tray.png'))
      this.tray = new Tray(icon)
      this.tray.on('click', () => this.opts.open())
    }
    this.refresh()
  }

  refresh(): void {
    if (!this.tray) return
    const { node, client, miner } = this.opts.states()
    this.tray.setToolTip(
      `Lithos Launcher\nNode: ${describe(node)}\nClient: ${describe(client)}\nSOAT miner: ${describeMiner(miner)}`
    )
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Lithos Launcher', click: () => this.opts.open() },
        { type: 'separator' },
        { label: `Node: ${describe(node)}`, enabled: false },
        { label: `Client: ${describe(client)}`, enabled: false },
        { label: `SOAT miner: ${describeMiner(miner)}`, enabled: false },
        { type: 'separator' },
        { label: 'Stop everything and quit', click: () => this.opts.quit() }
      ])
    )
  }
}
