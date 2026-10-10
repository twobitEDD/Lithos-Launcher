// The standalone SOAT Miner window (`--soat`): its own desktop entry and single-instance lock, so it
// opens without Lithos Launcher. Like the launcher's card it only talks to the background service.
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron'
import { redactText } from '@shared/diagnostics'
import { IPC } from '@shared/types'
import { parseWorkWith } from '@shared/workWith'
import { readFileTail } from './diagnosticsService'
import { MinerController } from './minerController'
import { soatPaths } from './soatControl'

export function runSoatWindow(root: string): void {
  // Separate profile: its own single-instance lock, independent of the launcher's.
  app.setPath('userData', join(app.getPath('appData'), 'lithos-soat-miner'))
  app.setName('SOAT Miner')
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let win: BrowserWindow | null = null
  let miner: MinerController | null = null
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
  // Mining belongs to the service: closing this window only closes the window.
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => void miner?.shutdown())

  void app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    if (app.isPackaged) Menu.setApplicationMenu(null)

    win = new BrowserWindow({
      width: 560,
      height: 660,
      minWidth: 420,
      minHeight: 420,
      show: false,
      title: 'SOAT Miner',
      icon: join(app.getAppPath(), 'resources', 'icon.png'),
      backgroundColor: '#12141a',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    })
    win.on('page-title-updated', (event) => event.preventDefault())
    win.once('ready-to-show', () => win?.show())

    const send = (state: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.miner, state)
    }
    const m = new MinerController(root, send, (line) => console.log(line))
    miner = m
    const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!win || event.sender.id !== win.webContents.id || event.senderFrame?.parent !== null) {
          throw new Error('Unauthorized IPC sender')
        }
        return fn(...args)
      })
    }
    handle(IPC.getMiner, () => m.state)
    handle(IPC.startMiner, () => m.start())
    handle(IPC.stopMiner, () => m.stop())
    handle(IPC.setMinerAutoStart, (on) => {
      if (typeof on !== 'boolean') throw new Error('Invalid argument')
      return m.setAutoStart(on)
    })
    handle(IPC.switchMinerService, () => m.switchToService())
    handle(IPC.setMinerWorkWith, (w) => {
      const workWith = parseWorkWith(w)
      if (!workWith) throw new Error('Invalid "Work with" choice')
      return m.setWorkWith(workWith)
    })
    handle(IPC.copyLog, async (id) => {
      if (id !== 'soat') throw new Error('Only the SOAT miner log is available here')
      const lines = (await readFileTail(soatPaths(root).log).catch(() => m.state.logTail)).map((line) => redactText(line))
      clipboard.writeText(lines.join('\n'))
      return lines.length
    })
    handle(IPC.openLogsFolder, async (id) => {
      if (id !== 'soat') throw new Error('Only the SOAT miner log is available here')
      const error = await shell.openPath(soatPaths(root).dir)
      if (error) throw new Error(error)
    })

    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#soat`)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'soat' })
    void m.begin()
  })
}
