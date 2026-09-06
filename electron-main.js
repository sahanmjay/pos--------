// ═══════════════════════════════════════════════════════════════
// NexPOS — Electron Main Process
// Embeds the local Node.js server and opens the POS UI in a
// native BrowserWindow with silent thermal printing support.
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');

// ─── Single Instance Lock ───
// Prevent multiple NexPOS windows on a single POS terminal
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let serverInstance = null;
let serverPort = 3000;

// ─── Start the embedded HTTP server in-process ───
function startEmbeddedServer() {
  return new Promise((resolve, reject) => {
    try {
      const fs = require('fs');
      // Set user data directory for SQLite / JSON data in packaged app
      const dataDir = path.join(app.getPath('userData'), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      process.env.NEXPOS_DATA_DIR = dataDir;

      // Import server.js directly (runs in Electron's embedded Node runtime)
      const { startServer } = require('./server.js');

      // Check if server is already running (e.g. dev server already active)
      const testReq = http.get(`http://localhost:${serverPort}/`, (res) => {
        console.log(`Server already running on port ${serverPort}`);
        resolve(serverPort);
      });

      testReq.on('error', () => {
        // Start server in-process
        try {
          const srv = startServer(serverPort, (actualPort) => {
            serverInstance = srv;
            serverPort = actualPort;
            console.log(`Embedded server running directly on port ${actualPort}`);
            resolve(actualPort);
          });
        } catch (err) {
          console.error('Failed to start in-process server:', err);
          reject(err);
        }
      });

      testReq.setTimeout(400, () => testReq.destroy());
    } catch (err) {
      console.error('Server initialization error:', err);
      reject(err);
    }
  });
}

// ─── Create the main application window ───
function createWindow(port) {
  const iconPath = path.join(__dirname, 'favicon.ico');

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 600,
    title: 'NexPOS — Point of Sale',
    icon: iconPath,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // Remove default menu bar for cleaner POS look
  Menu.setApplicationMenu(null);

  // Load the app
  mainWindow.loadURL(`http://localhost:${port}/`);

  // Show window when content is ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Focus on startup
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F11 = Toggle Fullscreen (Kiosk mode for dedicated POS terminals)
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
    // F12 = DevTools (only in dev mode)
    if (input.key === 'F12' && input.type === 'keyDown' && !app.isPackaged) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    // Ctrl+P = Prevent browser print dialog (we use silent print)
    if (input.control && input.key === 'p' && input.type === 'keyDown') {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC Handlers for Native Features ───
function setupIPC() {
  // Silent thermal receipt printing
  ipcMain.handle('pos:print-silent', async (event, options = {}) => {
    try {
      if (!mainWindow) return { success: false, error: 'No window' };

      const printers = mainWindow.webContents.getPrintersAsync
        ? await mainWindow.webContents.getPrintersAsync()
        : [];

      // Find thermal printer (common names)
      const thermalKeywords = ['thermal', 'pos', 'receipt', 'xp-', 'ep-', '80mm', '58mm', 'star ', 'epson tm', 'bixolon'];
      let targetPrinter = options.printerName || '';

      if (!targetPrinter && printers.length > 0) {
        // Try to find a thermal printer by name
        const thermal = printers.find(p =>
          thermalKeywords.some(kw => p.name.toLowerCase().includes(kw))
        );
        targetPrinter = thermal ? thermal.name : printers[0].name;
      }

      return new Promise((resolve) => {
        mainWindow.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: targetPrinter,
            margins: { marginType: 'none' },
            pageSize: options.pageSize || { width: 80000, height: 297000 }, // 80mm x ~297mm
            ...(options.copies && { copies: options.copies })
          },
          (success, failureReason) => {
            resolve({
              success,
              printer: targetPrinter,
              error: failureReason || null
            });
          }
        );
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // List available printers
  ipcMain.handle('pos:get-printers', async () => {
    try {
      if (!mainWindow) return [];
      const printers = mainWindow.webContents.getPrintersAsync
        ? await mainWindow.webContents.getPrintersAsync()
        : [];
      return printers.map(p => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: p.isDefault,
        status: p.status
      }));
    } catch (err) {
      return [];
    }
  });

  // Toggle fullscreen / kiosk mode
  ipcMain.handle('pos:toggle-fullscreen', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return mainWindow.isFullScreen();
    }
    return false;
  });

  // Get app info
  ipcMain.handle('pos:get-app-info', () => {
    return {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node
    };
  });

  // Open external URL
  ipcMain.handle('pos:open-external', (event, url) => {
    shell.openExternal(url);
  });

  // Auto-Updater controls
  ipcMain.handle('pos:check-updates', async () => {
    if (!app.isPackaged) return { status: 'dev-mode' };
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('pos:restart-and-install', () => {
    autoUpdater.quitAndInstall();
  });
}

// ─── GitHub Releases Auto-Updater ───
function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[AutoUpdater] Development mode — auto-update check skipped.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking GitHub Releases for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('pos:update-status', {
        status: 'available',
        version: info.version
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[AutoUpdater] App is up to date.');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('pos:update-status', {
        status: 'downloading',
        percent: Math.round(progress.percent)
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded successfully:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('pos:update-status', {
        status: 'downloaded',
        version: info.version
      });

      // Show native restart prompt
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'NexPOS Update Ready',
        message: `A new version (v${info.version}) has been downloaded!`,
        detail: 'Would you like to restart NexPOS now to apply the update automatically?',
        buttons: ['Restart Now', 'Later (on exit)'],
        defaultId: 0,
        cancelId: 1
      }).then((res) => {
        if (res.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.warn('[AutoUpdater] Check failed:', err ? err.message : 'Unknown error');
  });

  // Check for updates 5 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.warn('[AutoUpdater] Initial check error:', e.message);
    });
  }, 5000);
}

// ─── App Lifecycle ───
app.whenReady().then(async () => {
  setupIPC();

  try {
    const port = await startEmbeddedServer();
    serverPort = port;
    createWindow(port);
    setupAutoUpdater();
  } catch (err) {
    dialog.showErrorBox(
      'NexPOS Startup Error',
      `Failed to start the local server:\n${err.message}\n\nPlease ensure no other NexPOS instance is running.`
    );
    app.quit();
  }
});

// macOS: re-create window when dock icon clicked (not typical for POS but good practice)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createWindow(serverPort);
  }
});

// Second instance focus (single-instance lock)
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Quit gracefully
app.on('window-all-closed', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  app.quit();
});

app.on('before-quit', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
});
