'use strict';

/* 端到端自测：起两个渲染窗口（同一套 UI），通过公共信令真实互传一个 8MB 文件，校验落盘内容 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const LOG_FILE = path.join(__dirname, '..', 'e2e.log');
try {
  fs.unlinkSync(LOG_FILE);
} catch {
  /* 首次运行没有日志 */
}

function log() {
  const args = Array.prototype.slice.call(arguments);
  const line = '[' + new Date().toISOString().slice(11, 23) + '] ' + args.join(' ') + '\n';
  fs.appendFileSync(LOG_FILE, line, 'utf8');
}

const TMP = path.join(os.tmpdir(), 'crossdrop-e2e-' + Date.now());
fs.mkdirSync(path.join(TMP, 'userData'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'out'), { recursive: true });
app.setPath('userData', path.join(TMP, 'userData'));
log('临时目录', TMP);

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
  win.webContents.on('did-fail-load', function (e, code, desc) {
    log(tag + ' did-fail-load ' + code + ' ' + desc);
  });
  win.webContents.on('preload-error', function (e, file, error) {
    log(tag + ' preload-error ' + file + ' ' + error);
  });
  win.webContents.on('render-process-gone', function (e, details) {
    log(tag + ' render-process-gone ' + JSON.stringify(details));
  });
}

async function run() {
  let sendWin = null;
  let recvWin = null;
  log('run start');
  try {
    sendWin = await poll('主窗口', function () { return BrowserWindow.getAllWindows()[0]; }, 30000, 250);
    log('window found');
    watch('A', sendWin);
    log('isLoading=' + sendWin.webContents.isLoading());
    if (sendWin.webContents.isLoading()) {
      await new Promise(function (resolve) { sendWin.webContents.once('did-finish-load', resolve); });
    }
    log('A 已加载');

    await sendWin.webContents.executeJavaScript(
      'window.crossdrop.setSettings({ saveDir: ' + JSON.stringify(path.join(TMP, 'out')) + ' })'
    );
    log('已设置 A 的接收目录');

    recvWin = new BrowserWindow({
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
    watch('B', recvWin);
    await recvWin.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
    log('B 已加载');

    const code = await poll('A 分配连接码', async function () {
      const value = await sendWin.webContents.executeJavaScript('window.CDApp && window.CDApp.code()');
      return value && value.length === 8 ? value : null;
    }, 45000);
    log('A 的连接码 ' + code);

    const recvCode = await poll('B 分配连接码', async function () {
      const value = await recvWin.webContents.executeJavaScript('window.CDApp && window.CDApp.code()');
      return value && value.length === 8 ? value : null;
    }, 45000);
    log('B 的连接码 ' + recvCode);

    await poll('两端信令就绪', async function () {
      const sa = await sendWin.webContents.executeJavaScript('window.CDApp.status()');
      const sb = await recvWin.webContents.executeJavaScript('window.CDApp.status()');
      if (sa.indexOf('就绪') >= 0 && sb.indexOf('就绪') >= 0) return true;
      log('就绪轮询 A=' + sa + ' B=' + sb);
      return null;
    }, 45000, 1000);

    const connectOk = await recvWin.webContents.executeJavaScript(
      'window.CDApp.connect(' + JSON.stringify(code) + ')'
    );
    log('B 发起连接：' + connectOk);

    await poll('建立连接', async function () {
      const a = await sendWin.webContents.executeJavaScript('window.CDApp.connected()');
      const b = await recvWin.webContents.executeJavaScript('window.CDApp.connected()');
      const statusA = await sendWin.webContents.executeJavaScript('window.CDApp.status()');
      log('连接轮询 A=' + a + ' B=' + b + ' status=' + statusA);
      return a && b;
    }, 45000, 1500);
    log('连接已建立');

    const size = 8 * 1024 * 1024 + 123;
    const queued = await sendWin.webContents.executeJavaScript(
      '(function () {' +
      '  const size = ' + size + ';' +
      '  const data = new Uint8Array(size);' +
      '  for (let i = 0; i < size; i += 1) data[i] = i % 251;' +
      '  const file = new File([data], "e2e-test.bin", { type: "application/octet-stream" });' +
      '  window.CDApp.addFiles([file]);' +
      '  return window.CDApp.queue().length;' +
      '})()'
    );
    log('入队数量 ' + queued);

    await sendWin.webContents.executeJavaScript('window.CDApp.send()');
    log('已触发发送');

    const received = await poll('接收完成', async function () {
      const list = await recvWin.webContents.executeJavaScript('window.CDApp.recv()');
      const done = (list || []).filter(function (item) { return item.state === 'done'; });
      if (done.length) return done[0];
      const queue = await sendWin.webContents.executeJavaScript('window.CDApp.queue()');
      log('进度 A=' + JSON.stringify(queue) + ' B=' + JSON.stringify(list));
      return null;
    }, 120000, 1500);

    log('接收结果 ' + JSON.stringify(received));

    const target = received.path;
    const stat = fs.statSync(target);
    if (stat.size !== size) throw new Error('文件大小不符：' + stat.size + ' != ' + size);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    const expect = expectedHash(size);
    if (hash !== expect) throw new Error('内容校验不一致：' + hash + ' != ' + expect);

    log('校验通过，落盘路径 ' + target);
    log('E2E RESULT: PASS');
    app.exit(0);
  } catch (error) {
    log('E2E RESULT: FAIL — ' + (error && error.stack ? error.stack : error));
    if (sendWin) {
      try {
        log('A 状态 ' + (await sendWin.webContents.executeJavaScript('window.CDApp && window.CDApp.status()')));
      } catch (e) {
        log('读取 A 状态失败 ' + e.message);
      }
    }
    app.exit(1);
  }
}

const watchdog = setTimeout(function () {
  log('E2E RESULT: FAIL — 看门狗超时 180s');
  app.exit(2);
}, 180000);
watchdog.unref();

app.whenReady().then(run);
