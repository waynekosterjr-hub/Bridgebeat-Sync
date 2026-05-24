const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');

// Start the existing Express server from the desktop app process.
require('./server.js');

const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const startUrl = baseUrl;

let mainWindow = null;
let tray = null;
let openAtLogin = app.getLoginItemSettings().openAtLogin;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 900,
    minHeight: 700,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nativeWindowOpen: true,
    },
  });

  mainWindow.loadURL(startUrl);

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl) || url.startsWith('https://accounts.google.com') || url.startsWith('https://accounts.spotify.com')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function getTrayIcon() {
  const iconPath = path.join(__dirname, 'public', 'assets', 'brand-logo-final.png');
  const image = nativeImage.createFromPath(iconPath);
  return image.resize({ width: 16, height: 16 });
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Bridgebeat Sync',
      type: 'normal',
      click: () => {
        if (!mainWindow) createMainWindow();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: openAtLogin ? 'Disable autostart' : 'Enable autostart',
      type: 'normal',
      click: () => {
        openAtLogin = !openAtLogin;
        app.setLoginItemSettings({ openAtLogin });
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      type: 'normal',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Bridgebeat Sync');
}

function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.on('double-click', () => {
    if (!mainWindow) createMainWindow();
    mainWindow.show();
    mainWindow.focus();
  });
  updateTrayMenu();
}

app.on('ready', () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.bridgebeat.sync');
  }

  createMainWindow();
  createTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
