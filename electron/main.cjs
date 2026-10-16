// Electron main process for MultiPaint.
//
// The app is a Vite single-page web app. In the packaged desktop build we serve
// the built bundle over a custom, secure `app://` scheme (NOT file://) so it
// gets a stable web origin — that's what lets IndexedDB autosave, localStorage
// (palette / setups / recent), and the mesh Web Worker all behave exactly like
// they do in the browser. Updates come from GitHub Releases via electron-updater.

const { app, BrowserWindow, protocol, ipcMain, shell, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const isDev = !app.isPackaged;
const DIST = path.join(__dirname, '..', 'dist');

// Register the custom scheme as standard + secure BEFORE the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow = null;

/** Serve the built dist/ over app://local/… , refusing anything outside dist. */
function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.join(DIST, rel);
    // path-traversal guard: resolved file must stay inside DIST
    if (!filePath.startsWith(DIST + path.sep) && filePath !== path.join(DIST, 'index.html')) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1b1d21',
    title: 'MultiPaint',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links (docs, socials) in the real browser, not a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://local/');
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- auto-update (electron-updater, reads GitHub Releases) ----

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

let updater = null;
function setupUpdater() {
  if (isDev) return; // no update feed in dev
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // dependency not installed in this build
  }
  updater = autoUpdater;
  updater.autoDownload = true;          // once an update is found, fetch it
  updater.autoInstallOnAppQuit = true;  // and apply it on next quit as a fallback

  updater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  updater.on('update-available', (info) => send('update:status', { state: 'available', version: info?.version }));
  updater.on('update-not-available', (info) => send('update:status', { state: 'none', version: info?.version }));
  updater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p?.percent || 0) }));
  updater.on('update-downloaded', (info) => send('update:status', { state: 'downloaded', version: info?.version }));
  updater.on('error', (err) => send('update:status', { state: 'error', message: String(err?.message || err) }));

  // A quiet check shortly after launch; the UI button can trigger more.
  setTimeout(() => { updater.checkForUpdates().catch(() => {}); }, 4000);
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  if (!updater) return { ok: false, reason: isDev ? 'dev' : 'unavailable' };
  try {
    const r = await updater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
});

ipcMain.on('update:install', () => {
  if (updater) { try { updater.quitAndInstall(); } catch { /* ignore */ } }
});

app.whenReady().then(() => {
  if (!isDev) registerAppProtocol();
  createWindow();
  setupUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
