'use strict';

/* 中继链路自测：本地起自建服务，两个窗口全部走中继互传 8MB 文件，校验落盘内容 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const PORT = 9123;
const TOKEN = 'e2e-token';
const MODE = process.env.CD_E2E_MODE === 'auto' ? 'auto' : 'relay';
const LOG_FILE = path.join(__dirname, '..', 'e2e-relay.log');
try {
  fs.unlinkSync(LOG_FILE);
} catch {
  /* 首次运行 */
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString().slice(11, 23) + '] ' + args.join(' ') + '\n', 'utf8');
}

const TMP = path.join(os.tmpdir(), 'crossdrop-relay-' + Date.now());
fs.mkdirSync(path.join(TMP, 'userData'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'out'), { recursive: true });
app.setPath('userData', path.join(TMP, 'userData'));

require('../electron/main.js');

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function poll(label, fn, timeout, interval) {
  const limit = timeout || 45000;
  const step = interval || 350;
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < limit) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(step);
  }
  throw new Error('等待超时：' + label + (lastError ? ' / 最后错误：' + lastError.message : ''));
}

function expectedHash(size) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) data[i] = i % 251;
  return crypto.createHash('sha256').update(data).digest('hex');
}

function watch(tag, win) {
  win.webContents.on('console-message', function (event, level, message) {
    const text = event && typeof event === 'object' && event.message ? event.message : message;
    log(tag + ' console> ' + (text || ''));
  });
}

function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--port', String(PORT), '--token', TOKEN], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', function (chunk) { log('server> ' + String(chunk).trim()); });
  proc.stderr.on('data', function (chunk) { log('server! ' + String(chunk).trim()); });
  return proc;
}

async function run() {
  let server = null;
  let a = null;
  let b = null;
  log('run start');
  try {
    server = startServer();
    await sleep(1200);

    a = await poll('主窗口', function () { return BrowserWindow.getAllWindows()[0]; }, 30000, 250);
    watch('A', a);
    if (a.webContents.isLoading()) {
      await new Promise(function (resolve) { a.webContents.once('did-finish-load', resolve); });
    }

    const settings = {
      saveDir: path.join(TMP, 'out'),
      relayUrl: 'ws://127.0.0.1:' + PORT + '/ws',
      relayToken: TOKEN,
      linkMode: MODE
    };
    if (MODE === 'auto') {
      /* 故意把信令指到一个空端口：直连必定失败，用来验证自动转中继 */
      settings.signalMode = 'custom';
      settings.signalHost = '127.0.0.1';
      settings.signalPort = 9;
      settings.signalSecure = false;
    }

    await a.webContents.executeJavaScript('window.crossdrop.setSettings(' + JSON.stringify(settings) + ')');
    log('已写入配置，模式 ' + MODE);

    b = new BrowserWindow({
      show: false,
      width: 1000,
      height: 760,
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    watch('B', b);
    await b.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
    log('B 已加载');

    await a.webContents.reload();
    await new Promise(function (resolve) { a.webContents.once('did-finish-load', resolve); });
    log('A 已重载，设置生效');

    await poll('A 拿到连接码', async function () {
      const value = await a.webContents.executeJavaScript('window.CDApp && window.CDApp.code()');
      return value && value.length === 8 ? value : null;
    }, 40000);
    const code = await a.webContents.executeJavaScript('window.CDApp.code()');
    log('A 连接码 ' + code);

    await poll('B 拿到连接码', async function () {
      const value = await b.webContents.executeJavaScript('window.CDApp && window.CDApp.code()');
      return value && value.length === 8 ? value : null;
    }, 40000);

    const ok = await b.webContents.executeJavaScript('window.CDApp.connect(' + JSON.stringify(code) + ')');
    log('B 发起连接：' + ok);

    await poll('中继连接建立', async function () {
      const ca = await a.webContents.executeJavaScript('window.CDApp.connected()');
      const cb = await b.webContents.executeJavaScript('window.CDApp.connected()');
      log('连接轮询 A=' + ca + ' B=' + cb);
      return ca && cb;
    }, 40000, 1000);
    log('中继通道已建立');

    const transportText = await a.webContents.executeJavaScript('document.getElementById("transportText").textContent');
    log('A 通道类型：' + transportText);

    const size = 8 * 1024 * 1024 + 123;
    await a.webContents.executeJavaScript(
      '(function () {' +
      '  const size = ' + size + ';' +
      '  const data = new Uint8Array(size);' +
      '  for (let i = 0; i < size; i += 1) data[i] = i % 251;' +
      '  const file = new File([data], "relay-test.bin", { type: "application/octet-stream" });' +
      '  window.CDApp.addFiles([file]);' +
      '  return window.CDApp.queue().length;' +
      '})()'
    );
    await a.webContents.executeJavaScript('window.CDApp.send()');
    log('已触发发送');

    const received = await poll('接收完成', async function () {
      const list = await b.webContents.executeJavaScript('window.CDApp.recv()');
      const done = (list || []).filter(function (item) { return item.state === 'done'; });
      if (done.length) return done[0];
      const queue = await a.webContents.executeJavaScript('window.CDApp.queue()');
      log('进度 A=' + JSON.stringify(queue) + ' B=' + JSON.stringify(list));
      return null;
    }, 150000, 1500);

    log('接收结果 ' + JSON.stringify(received));

    const stat = fs.statSync(received.path);
    if (stat.size !== size) throw new Error('文件大小不符：' + stat.size + ' != ' + size);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(received.path)).digest('hex');
    if (hash !== expectedHash(size)) throw new Error('内容校验不一致：' + hash);

    log('校验通过，落盘路径 ' + received.path);
    log('RELAY E2E RESULT: PASS');
    if (server) server.kill();
    app.exit(0);
  } catch (error) {
    log('RELAY E2E RESULT: FAIL — ' + (error && error.stack ? error.stack : error));
    if (a) {
      try {
        log('A 状态 ' + (await a.webContents.executeJavaScript('window.CDApp && window.CDApp.status()')));
      } catch (e) {
        log('读取 A 状态失败 ' + e.message);
      }
    }
    if (server) server.kill();
    app.exit(1);
  }
}

const watchdog = setTimeout(function () {
  log('RELAY E2E RESULT: FAIL — 看门狗超时 200s');
  app.exit(2);
}, 200000);
watchdog.unref();

app.whenReady().then(run);
