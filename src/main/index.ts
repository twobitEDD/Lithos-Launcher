import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session } from 'electron'
import { IPC, type ProcState } from '@shared/types'
import { ClientController } from './clientController'
import { LauncherDeferral } from './deferral'
import { Importer } from './importer'
import { Installer } from './installer'
import { registerIpc } from './ipc'
import { ChainCopyCoordinator } from './chainCopyService'
import { ChainSeedService } from './chainSeedService'
import { LanPeerCoordinator } from './lanPeerService'
import { installRoot } from './layout'
import { MinerController, minerAutoStart } from './minerController'
import { NodeAutoStarter } from './nodeAutoStart'
import { NodeController } from './nodeController'
import { loadSettings, settings, updateSettings } from './settings'
import { runSoatService } from './soatService'
import { rootFromArgv, soatModeFromArgv } from './soatServiceManager'
import { runSoatWindow } from './soatWindow'
import { LauncherTray } from './tray'
import { errorMessage } from './util'
import { Vault } from './vault'
import { WalletManager } from './wallet'

app.enableSandbox()
// The UI is simple enough to draw in software. Staying off the GPU keeps the launcher out of the
// miner's way (VRAM, driver time) and drops the GPU process's memory.
app.disableHardwareAcceleration()

// Dev/testing: a custom install root gets its own launcher profile (vault, caches, instance lock).
if (!app.isPackaged && process.env.LITHOS_LAUNCHER_ROOT) {
  app.setPath('userData', join(installRoot(), '.launcher-profile'))
}

// launcher.json (install folder, heap overrides, adopted data folders) is read before anything else.
loadSettings()

const soatMode = soatModeFromArgv(process.argv)
/**
 * The Windows installer runs `Lithos Launcher.exe --lithos-quit-for-update` before it replaces the
 * files, so a running launcher stops the node through its API instead of being terminated (which
 * on Windows also terminates the node, leaving hours of state recovery for its next start).
 */
const QUIT_FOR_UPDATE_FLAG = '--lithos-quit-for-update'
if (soatMode === 'service') {
  // The background SOAT service: no window, its own profile, outlives the launcher.
  app.setPath('userData', join(app.getPath('appData'), 'lithos-soat-service'))
  app.dock?.hide()
  void runSoatService(rootFromArgv(process.argv) ?? installRoot(), (code) => app.exit(code))
} else if (soatMode === 'window') {
  runSoatWindow(rootFromArgv(process.argv) ?? installRoot())
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (process.argv.includes(QUIT_FOR_UPDATE_FLAG)) {
  // No launcher was running: nothing to stop.
  app.quit()
} else {
  main()
}

/** How long the window gets to ask for node auto-start (with its network) before main does it. */
const NODE_AUTO_START_FALLBACK_MS = 8000

/** The user already chose "Close anyway" for an unconfirmed seed phrase; don't ask twice. */
let seedCloseConfirmed = false
/** A close or quit question is on screen; further close clicks wait for its answer. */
let closePromptOpen = false

/** Asks before closing over an unconfirmed seed phrase. True means close anyway. */
async function confirmSeedClose(win: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Stay', 'Close anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Seed phrase not confirmed',
    message: 'You have not confirmed your seed phrase yet.',
    detail: 'If you close now, the launcher cannot show these words again. Without them, funds in this wallet cannot be recovered.'
  })
  return response === 1
}

/** Unpackaged runs are this working copy, so the title is not the installed 0.1.0 AppImage. */
const windowTitle = app.isPackaged ? 'Lithos Launcher' : 'Lithos Launcher (own)'

function createWindow(): BrowserWindow {
  // Never larger than the usable screen (panels and docks excluded), even for the minimum size.
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1200, area.width),
    height: Math.min(780, area.height),
    // Small enough for a 1280x720 or 1366x768 screen with panels; the page scrolls below its natural height.
    minWidth: Math.min(860, area.width),
    minHeight: Math.min(540, area.height),
    show: false,
    title: windowTitle,
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    backgroundColor: '#060913',
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
  win.once('ready-to-show', () => win.show())
  if (!app.isPackaged) {
    win.on('page-title-updated', (event) => {
      event.preventDefault()
    })
  }

  // The renderer blocks unloading while an unconfirmed seed phrase is on screen. The window stays
  // open while the (non-blocking) question is up; "Close anyway" closes it again with the guard lifted.
  win.webContents.on('will-prevent-unload', (event) => {
    if (seedCloseConfirmed) {
      event.preventDefault() // proceed with closing
      return
    }
    if (closePromptOpen) return
    closePromptOpen = true
    void confirmSeedClose(win)
      .then((close) => {
        if (!close || win.isDestroyed()) return
        seedCloseConfirmed = true
        win.close()
      })
      .finally(() => (closePromptOpen = false))
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function main(): void {
  let win: BrowserWindow | null = null
  let quitting = false
  /** The window was closed but the node/client keep running from the tray. */
  let backgrounded = false
  /** An unconfirmed seed phrase is on screen (the renderer reports this). */
  let seedOnScreen = false
  let openWindow: () => void = () => {}

  let quitForUpdate: () => void = () => app.quit()
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(QUIT_FOR_UPDATE_FLAG)) quitForUpdate()
    else openWindow()
  })

  // No navigation, popups or webviews: the UI is one local page.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  app.on('window-all-closed', () => {
    if (!backgrounded) app.quit()
  })

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark'
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    if (app.isPackaged) Menu.setApplicationMenu(null)

    const root = installRoot()
    const vault = new Vault()
    await vault.load()

    const send = (channel: string, payload: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    const installer = new Installer(root, vault, (p) => send(IPC.progress, p))
    const logSink: { write: (line: string) => void } = { write: () => undefined }
    const deferral = new LauncherDeferral(
      root,
      (remote) => send(IPC.remoteLauncher, remote),
      (line) => logSink.write(line)
    )
    const guard = (): Promise<void> => deferral.assertCanStartLocal()
    let chainCopy: ChainCopyCoordinator | null = null
    const nodeGuard = async (): Promise<void> => {
      if (chainCopy?.blocksNodeStart()) {
        throw new Error('The blockchain is being copied from another computer. The node starts again when that is done.')
      }
      await guard()
    }
    const node = new NodeController(root, vault, (info) => send(IPC.nodeInfo, info), nodeGuard)
    logSink.write = (line) => node.proc.log(line)
    const lanPeers = new LanPeerCoordinator(
      root,
      node,
      (status) => send(IPC.lanPeers, status),
      (line) => logSink.write(line)
    )
    node.proc.on('state', (s) => send(IPC.procState, s))
    node.proc.on('logs', (chunk) => send(IPC.logs, chunk))
    const wallet = new WalletManager(root, node, vault)
    wallet.on('state', (s) => send(IPC.wallet, s))
    const skipSyncGate = !app.isPackaged && process.env.LITHOS_LAUNCHER_SKIP_SYNC_GATE === '1'
    const client = new ClientController(
      root,
      vault,
      node,
      wallet,
      skipSyncGate,
      (s) => send(IPC.clientStats, s),
      (c) => send(IPC.commitments, c),
      guard
    )
    client.proc.on('state', (s) => send(IPC.procState, s))
    client.proc.on('logs', (chunk) => send(IPC.logs, chunk))
    wallet.setPauseMining(() => client.stop())
    let refreshTray = (): void => undefined
    let minerStatus: string | null = null
    // The miner itself runs in the background SOAT service; this only shows it and sends Start/Stop.
    const miner = new MinerController(
      root,
      (s) => {
        send(IPC.miner, s)
        if (s.status !== minerStatus) {
          minerStatus = s.status
          refreshTray()
        }
      },
      (line) => client.proc.log(line),
      {
        network: () => settings().nodeNetwork ?? 'mainnet',
        initialAutoStart: minerAutoStart,
        saveAutoStart: (on) =>
          updateSettings((s) => {
            if (on) delete s.soatMiner
            else s.soatMiner = { autoStart: false }
          })
      }
    )

    const chainSeed = new ChainSeedService(
      root,
      node,
      () => chainCopy?.seedChanged(),
      (line) => logSink.write(line)
    )
    chainCopy = new ChainCopyCoordinator(
      root,
      node,
      client,
      chainSeed,
      (status) => send(IPC.chainCopy, status),
      (line) => logSink.write(line)
    )

    const importer = new Importer(root)
    const nodeAutoStart = new NodeAutoStarter(root, vault, node, installer, deferral)
    registerIpc({
      window: () => win,
      root,
      vault,
      installer,
      node,
      wallet,
      client,
      importer,
      skipSyncGate,
      onSensitive: (on) => (seedOnScreen = on),
      quit: () => requestQuit(),
      deferral,
      lanPeers,
      chainCopy,
      miner,
      nodeAutoStart
    })
    nodeAutoStart.fallbackAfter(NODE_AUTO_START_FALLBACK_MS)
    node.proc.on('state', (s: ProcState) => {
      if (s.status !== 'running' || !s.network || settings().nodeNetwork === s.network) return
      const network = s.network
      void updateSettings((next) => {
        next.nodeNetwork = network
      }).catch(() => undefined)
    })
    deferral.begin()
    lanPeers.attach()
    chainSeed.attach()
    chainCopy.attach()
    void miner.begin()

    const tray = new LauncherTray({
      open: () => openWindow(),
      quit: () => app.quit(),
      states: () => ({ node: node.proc.state, client: client.proc.state, miner: miner.state })
    })
    node.proc.on('state', () => tray.refresh())
    client.proc.on('state', () => tray.refresh())
    refreshTray = () => tray.refresh()

    const anyRunning = (): boolean => node.proc.alive || client.proc.alive || miner.alive
    const runningText = (): string =>
      client.proc.alive
        ? 'The node and the Lithos Client are'
        : node.proc.alive
          ? 'The node is'
          : 'The SOAT miner is'

    /**
     * Closing the window while the node or client runs asks whether to keep mining in the
     * background. Backgrounding destroys the window (and its renderer's memory); the tray reopens it.
     */
    const askOnClose = async (w: BrowserWindow): Promise<void> => {
      closePromptOpen = true
      try {
        if (seedOnScreen && !(await confirmSeedClose(w))) return
        const { response } = await dialog.showMessageBox(w, {
          type: 'question',
          buttons: ['Keep running in the background', 'Stop and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          title: 'Lithos is still running',
          message: `${runningText()} still running.`,
          detail:
            'Keep mining in the background, or stop everything safely and quit. To bring the window back, use the ' +
            'Lithos icon in the system tray or start Lithos Launcher again.'
        })
        if (w.isDestroyed()) return
        if (response === 0) {
          backgrounded = true
          tray.show()
          holdSessionSentinel(true)
          w.destroy()
        } else if (response === 1) {
          seedCloseConfirmed = true
          app.quit()
        }
      } finally {
        closePromptOpen = false
      }
    }

    /**
     * Windows logoff, restart or shutdown (and installers using the Restart Manager): hold it
     * while the node shuts down through its API. Windows otherwise terminates this process, and
     * with it the node, without running the node's shutdown hooks.
     */
    const guardSessionEnd = (w: BrowserWindow): void => {
      if (process.platform !== 'win32') return
      w.on('query-session-end', (event) => {
        if (!anyRunning()) return
        event.preventDefault()
        node.proc.log(`Windows is ending the session (${event.reasons.join(', ') || 'unknown reason'}); stopping safely first`)
        if (!quitting) app.quit()
      })
      w.on('session-end', () => {
        if (!quitting) app.quit()
      })
    }
    /** While backgrounded there is no window, so a hidden one receives the session-end messages. */
    let sessionSentinel: BrowserWindow | null = null
    const holdSessionSentinel = (on: boolean): void => {
      if (process.platform !== 'win32') return
      if (!on) {
        if (sessionSentinel && !sessionSentinel.isDestroyed()) sessionSentinel.destroy()
        sessionSentinel = null
        return
      }
      if (sessionSentinel && !sessionSentinel.isDestroyed()) return
      sessionSentinel = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        skipTaskbar: true,
        title: windowTitle,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
      })
      guardSessionEnd(sessionSentinel)
    }

    const attachClose = (w: BrowserWindow): void => {
      guardSessionEnd(w)
      w.on('close', (event) => {
        if (quitting || !anyRunning()) return
        event.preventDefault()
        if (!closePromptOpen) void askOnClose(w)
      })
      w.on('closed', () => {
        if (win === w) win = null
      })
    }

    /** The window's own Quit button: confirms first if anything is running, then stops it all safely. */
    const requestQuit = async (): Promise<void> => {
      const w = win
      if (!w || w.isDestroyed() || quitting || !anyRunning()) {
        app.quit()
        return
      }
      if (closePromptOpen) return
      closePromptOpen = true
      try {
        const { response } = await dialog.showMessageBox(w, {
          type: 'question',
          buttons: ['Stop and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Quit Lithos Launcher',
          message: `${runningText()} running.`,
          detail: 'Quitting stops them safely first, which can take a little while.'
        })
        if (response === 0) app.quit()
      } finally {
        closePromptOpen = false
      }
    }

    openWindow = () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        return
      }
      backgrounded = false
      win = createWindow()
      attachClose(win)
      holdSessionSentinel(false)
    }
    openWindow()

    quitForUpdate = () => {
      if (seedOnScreen) {
        // Never close over an unconfirmed seed phrase; the installer waits and asks the user.
        openWindow()
        return
      }
      node.proc.log('The installer asked the launcher to quit for an update; stopping everything safely first')
      seedCloseConfirmed = true
      app.quit()
    }

    // Never leave processes running unattended: stop the client, then the node, cleanly before exiting.
    let stopAllDone = false
    app.on('before-quit', (event) => {
      if (stopAllDone) return
      if (!quitting && !anyRunning()) {
        void miner.shutdown()
        return
      }
      // A second quit (tray, installer, Windows shutdown) while stopping waits for the same stop;
      // quitting now would terminate the node mid-shutdown.
      event.preventDefault()
      if (quitting) return
      quitting = true
      // The miner mines into the client, and the client depends on the node, so they stop in that
      // order; a failure in one must not skip the next.
      const stopAll = async (): Promise<void> => {
        await miner.shutdown().catch((err: unknown) => client.proc.log(`Stopping the miner failed: ${errorMessage(err)}`))
        await client.stop().catch((err: unknown) => client.proc.log(`Stopping failed: ${errorMessage(err)}`))
        await node.stop().catch((err: unknown) => node.proc.log(`Stopping failed: ${errorMessage(err)}`))
      }
      void stopAll().finally(() => {
        stopAllDone = true
        app.quit()
      })
    })
  })
}
