'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const APP_DIR = path.join(__dirname, '..');
const IS_DEV = !app.isPackaged;

let mainWindow = null;
let settings = null;
const receiveSessions = new Map();

/* ---------------------------------------------------------------- 设置存储 */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings() {
  return {
    saveDir: '',
    signalMode: 'cloud',
    signalHost: '',
    signalPort: 443,
    signalPath: '/',
    signalKey: 'peerjs',
    signalSecure: true,
    useStun: true,
    turnUrl: '',
    turnUser: '',
    turnSecret: ''
  };
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = Object.assign(base, raw && typeof raw === 'object' ? raw : {});
  } catch {
    settings = base;
  }
  if (!settings.saveDir) {
    settings.saveDir = path.join(app.getPath('downloads'), 'CrossDrop');
  }
  return settings;
}

async function persistSettings(patch) {
  if (patch && typeof patch === 'object') {
    settings = Object.assign(settings, patch);
  }
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

/* ------------------------------------------------------------ 接收文件落盘 */

function sanitizeName(name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  const cleaned = base.replace(/^\.+/, '').slice(0, 180);
  return cleaned || 'file';
}

function sanitizeSegments(rel) {
  return String(rel || '')
    .split(/[\\/]+/)
    .map(function (segment) {
      return segment.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    })
    .filter(function (segment) {
      return segment && segment !== '.' && segment !== '..';
    })
    .slice(0, 8);
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let index = 1;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem} (${index})${ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

ipcMain.handle('recv:begin', async (_event, payload) => {
  const root = path.resolve(settings && settings.saveDir ? settings.saveDir : app.getPath('downloads'));
  const segments = sanitizeSegments(payload && payload.rel);
  let dir = path.resolve.apply(path, [root].concat(segments));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    dir = root;
  }
  await fsp.mkdir(dir, { recursive: true });
  const name = sanitizeName(payload && payload.name);
  const target = await uniqueTarget(dir, name);
  const handle = await fsp.open(target, 'w');
  const id = crypto.randomUUID();
  receiveSessions.set(id, {
    handle,
    target,
    chain: Promise.resolve(),
    written: 0,
    closed: false
  });
  return { id, path: target };
});

ipcMain.handle('recv:chunk', async (_event, payload) => {
  const session = receiveSessions.get(payload && payload.id);
  if (!session || session.closed) return false;
  const data = payload.data;
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer ? data.buffer : data, data.byteOffset || 0, data.byteLength || data.length);
  session.chain = session.chain.then(async () => {
    if (session.closed) return;
    await session.handle.write(buffer, 0, buffer.length);
    session.written += buffer.length;
  });
  await session.chain;
  return true;
});

ipcMain.handle('recv:end', async (_event, id) => {
  const session = receiveSessions.get(id);
  if (!session) return null;
  session.closed = true;
  try {
    await session.chain;
    await session.handle.close();
    receiveSessions.delete(id);
    return { path: session.target, size: session.written };
  } catch (error) {
    receiveSessions.delete(id);
    return { path: session.target, size: session.written, error: String(error) };
  }
});

ipcMain.handle('recv:abort', async (_event, id) => {
  const session = receiveSessions.get(id);
  if (!session) return false;
  session.closed = true;
  try {
    await session.chain;
  } catch {
    /* 忽略队列中已失败的分片 */
  }
  try {
    await session.handle.close();
  } catch {
    /* 文件已关闭 */
  }
  receiveSessions.delete(id);
  try {
    await fsp.unlink(session.target);
  } catch {
    /* 清理失败不阻塞流程 */
  }
  return true;
});

/* ------------------------------------------------------------------- 窗口 */

function createWindow() {
  const iconPath = path.join(APP_DIR, 'build', 'icon.ico');
  const options = {
    width: 1160,
    height: 850,
    minWidth: 900,
    minHeight: 660,
    backgroundColor: '#F2F9F7',
    title: 'CrossDrop 跨网快传',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  };
  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) options.icon = image;
  }

  mainWindow = new BrowserWindow(options);
  mainWindow.loadFile(path.join(APP_DIR, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId('com.zgs7157.crossdrop');

  app.whenReady().then(() => {
    loadSettings();
    Menu.setApplicationMenu(null);

    ipcMain.handle('system:info', () => ({
      platform: process.platform,
      version: app.getVersion(),
      saveDir: settings.saveDir,
      desktop: true
    }));

    ipcMain.handle('settings:get', () => settings || loadSettings());

    ipcMain.handle('settings:set', async (_event, patch) => persistSettings(patch));

    ipcMain.handle('dialog:pickSaveDir', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择接收文件的保存位置',
        defaultPath: settings.saveDir || app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || !result.filePaths.length) return null;
      await persistSettings({ saveDir: result.filePaths[0] });
      return settings.saveDir;
    });

    ipcMain.handle('shell:show', (_event, target) => {
      if (typeof target === 'string' && target.length) shell.showItemInFolder(target);
      return true;
    });

    ipcMain.handle('shell:openPath', async (_event, target) => {
      if (typeof target !== 'string' || !target.length) return false;
      const error = await shell.openPath(target);
      return !error;
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
