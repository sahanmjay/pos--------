// ═══════════════════════════════════════════════════════════════
// NexPOS — Electron Preload Script
// Exposes a safe, sandboxed API bridge to the renderer process.
// The web app can detect Electron mode via window.electronAPI.
// ═══════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Identity ───
  isElectron: true,

  // ─── Silent Thermal Printing ───
  // Print the current page silently to a thermal receipt printer
  silentPrint: (options = {}) => ipcRenderer.invoke('pos:print-silent', options),

  // List all available printers connected to this machine
  getPrinters: () => ipcRenderer.invoke('pos:get-printers'),

  // ─── Window Controls ───
  toggleFullscreen: () => ipcRenderer.invoke('pos:toggle-fullscreen'),

  // ─── App Info ───
  getAppInfo: () => ipcRenderer.invoke('pos:get-app-info'),

  // ─── External Links ───
  openExternal: (url) => ipcRenderer.invoke('pos:open-external', url),

  // ─── Auto-Updater ───
  checkForUpdates: () => ipcRenderer.invoke('pos:check-updates'),
  restartAndInstall: () => ipcRenderer.invoke('pos:restart-and-install'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('pos:update-status', (event, data) => callback(data));
  }
});
