'use strict';
// Desktop app: starts the PocketFerry server and shows its dashboard in a window.
const path = require('path');
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const { start, MEDIA_EXT } = require('./server');

// Name and icon while running from source. The built app (npm run dist) takes both
// from package.json and build/icon.png.
app.setName('PocketFerry');
const DEV_ICON = app.isPackaged ? undefined : path.join(__dirname, 'build', 'icon.png');

let win = null;
let ferry = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      ferry = await start({
        configDir: app.getPath('userData'),
        chooseFolder: async () => {
          const r = await dialog.showOpenDialog(win, {
            title: 'Where should PocketFerry save photos and videos from the phone?',
            properties: ['openDirectory', 'createDirectory'],
          });
          return r.canceled ? null : r.filePaths[0];
        },
        chooseFiles: async () => {
          const r = await dialog.showOpenDialog(win, {
            title: 'Choose photos and videos to send to the phone',
            buttonLabel: 'Add',
            defaultPath: app.getPath('pictures'),
            // Only macOS can offer files and folders in the same dialog.
            properties: ['openFile', 'multiSelections', ...(process.platform === 'darwin' ? ['openDirectory'] : [])],
            filters: [{ name: 'Photos and videos', extensions: [...MEDIA_EXT].map((e) => e.slice(1)) }],
          });
          return r.canceled ? null : r.filePaths;
        },
        openFolder: (dir) => shell.openPath(dir),
      });
    } catch (e) {
      dialog.showErrorBox('PocketFerry could not start', String((e && e.message) || e));
      return app.quit();
    }

    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    if (DEV_ICON && process.platform === 'darwin' && app.dock) app.dock.setIcon(DEV_ICON);
    win = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 380,
      minHeight: 560,
      title: 'PocketFerry',
      ...(DEV_ICON && process.platform !== 'darwin' ? { icon: DEV_ICON } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    // The window only ever shows the local dashboard.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(ferry.dashboardUrl)) e.preventDefault();
    });
    win.loadURL(ferry.dashboardUrl);
    win.on('closed', () => { win = null; });
  });

  // Closing the window stops all transfers, on every platform, so nothing keeps
  // listening on the network without a visible window.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (ferry) ferry.close(); });
}
