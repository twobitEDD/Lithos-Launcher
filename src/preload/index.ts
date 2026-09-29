import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type LauncherApi } from '@shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The renderer gets these named calls only; no raw ipcRenderer, no Node APIs.
const api: LauncherApi = {
  getState: (network) => ipcRenderer.invoke(IPC.getState, network),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  install: (network) => ipcRenderer.invoke(IPC.install, network),
  getReleases: (network, id, recheck) => ipcRenderer.invoke(IPC.getReleases, network, id, recheck),
  useVersion: (network, id, version) => ipcRenderer.invoke(IPC.useVersion, network, id, version),
  startNode: (network) => ipcRenderer.invoke(IPC.startNode, network),
  stopNode: () => ipcRenderer.invoke(IPC.stopNode),
  getProc: (id) => ipcRenderer.invoke(IPC.getProc, id),
  getLogs: (id) => ipcRenderer.invoke(IPC.getLogs, id),
  getNodeInfo: () => ipcRenderer.invoke(IPC.getNodeInfo),
  openNodePanel: () => ipcRenderer.invoke(IPC.openNodePanel),
  openFolder: (network) => ipcRenderer.invoke(IPC.openFolder, network),
  stopStrayNode: (network) => ipcRenderer.invoke(IPC.stopStrayNode, network),
  startClient: (network) => ipcRenderer.invoke(IPC.startClient, network),
  stopClient: () => ipcRenderer.invoke(IPC.stopClient),
  restartClient: (network) => ipcRenderer.invoke(IPC.restartClient, network),
  openLithosPanel: () => ipcRenderer.invoke(IPC.openLithosPanel),
  getClientSettings: (network) => ipcRenderer.invoke(IPC.getClientSettings, network),
  setClientSettings: (network, patch) => ipcRenderer.invoke(IPC.setClientSettings, network, patch),
  getClientStats: () => ipcRenderer.invoke(IPC.getClientStats),
  getNodeSettings: (network) => ipcRenderer.invoke(IPC.getNodeSettings, network),
  setNodeSettings: (network, patch) => ipcRenderer.invoke(IPC.setNodeSettings, network, patch),
  getSystemCheck: (network) => ipcRenderer.invoke(IPC.getSystemCheck, network),
  openLink: (name) => ipcRenderer.invoke(IPC.openLink, name),
  getLauncherInfo: () => ipcRenderer.invoke(IPC.getLauncherInfo),
  setHeap: (heap) => ipcRenderer.invoke(IPC.setHeap, heap),
  chooseInstallRoot: () => ipcRenderer.invoke(IPC.chooseInstallRoot),
  resetInstallRoot: () => ipcRenderer.invoke(IPC.resetInstallRoot),
  pickFolder: (title) => ipcRenderer.invoke(IPC.pickFolder, title),
  getConfigInfo: (network) => ipcRenderer.invoke(IPC.getConfigInfo, network),
  openConfig: (network, name, reveal) => ipcRenderer.invoke(IPC.openConfig, network, name, reveal),
  copyApiKey: (network, name) => ipcRenderer.invoke(IPC.copyApiKey, network, name),
  replaceApiKey: (network, name, key) => ipcRenderer.invoke(IPC.replaceApiKey, network, name, key),
  inspectImport: (network, nodeFolder, clientFolder) =>
    ipcRenderer.invoke(IPC.inspectImport, network, nodeFolder, clientFolder),
  applyImport: (network, options) => ipcRenderer.invoke(IPC.applyImport, network, options),
  clearImport: (network) => ipcRenderer.invoke(IPC.clearImport, network),
  scrubOldSecrets: (network) => ipcRenderer.invoke(IPC.scrubOldSecrets, network),
  getWallet: () => ipcRenderer.invoke(IPC.getWallet),
  focusWallet: (network) => ipcRenderer.invoke(IPC.focusWallet, network),
  createWallet: (password) => ipcRenderer.invoke(IPC.createWallet, password),
  restoreWallet: (mnemonic, password) => ipcRenderer.invoke(IPC.restoreWallet, mnemonic, password),
  pickKeystore: () => ipcRenderer.invoke(IPC.pickKeystore),
  importKeystore: (password) => ipcRenderer.invoke(IPC.importKeystore, password),
  unlockWallet: (password, remember) => ipcRenderer.invoke(IPC.unlockWallet, password, remember),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  setSensitive: (on) => ipcRenderer.invoke(IPC.setSensitive, on),
  onProgress: (cb) => subscribe(IPC.progress, cb),
  onProcState: (cb) => subscribe(IPC.procState, cb),
  onLogs: (cb) => subscribe(IPC.logs, cb),
  onNodeInfo: (cb) => subscribe(IPC.nodeInfo, cb),
  onWallet: (cb) => subscribe(IPC.wallet, cb),
  onClientStats: (cb) => subscribe(IPC.clientStats, cb)
}

contextBridge.exposeInMainWorld('lithos', api)
