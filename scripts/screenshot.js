'use strict';

/* 生成界面截图（走真实主进程，状态与打包后一致） */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const TMP = path.join(os.tmpdir(), 'crossdrop-shot-' + Date.now());
fs.mkdirSync(path.join(TMP, 'userData'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'out'), { recursive: true });
app.setPath('userData', path.join(TMP, 'userData'));

const OUT_DIR = path.join(__dirname, '..', 'docs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function shot(win, file) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  console.log('saved ' + file);
}

async function waitReady(win) {
  for (let i = 0; i < 40; i += 1) {
    const state = await win.webContents.executeJavaScript(
      '({ code: window.CDApp ? window.CDApp.code() : "", status: window.CDApp ? window.CDApp.status() : "" })'
    );
    if (state.code && state.code.length === 8 && state.status.indexOf('就绪') >= 0) return state;
    await sleep(500);
  }
  return null;
}

app.whenReady().then(async function () {
  require('../electron/main.js');
  let win = null;
  for (let i = 0; i < 30; i += 1) {
    win = BrowserWindow.getAllWindows()[0];
    if (win) break;
    await sleep(200);
  }
  if (!win) {
    console.log('no window');
    app.exit(1);
    return;
  }
  win.setSize(1160, 850);
  await sleep(1500);

  const ready = await waitReady(win);
  console.log('ready=' + JSON.stringify(ready));
  await shot(win, path.join(OUT_DIR, 'screenshot-1-idle.png'));

  await win.webContents.executeJavaScript(`(function(){
    const names = ['产品原型图 v3.fig','郑州-深圳 现场记录.mp4','素材包.zip','合同扫描件.pdf'];
    const files = names.map(function(name, index){
      const size = 1024 * 1024 * (index + 1);
      const data = new Uint8Array(Math.min(size, 512 * 1024));
      return new File([data], name, {type:'application/octet-stream'});
    });
    window.CDApp.addFiles(files);
    return window.CDApp.queue().length;
  })()`);
  await sleep(900);
  await shot(win, path.join(OUT_DIR, 'screenshot-2-queue.png'));

  app.exit(0);
});
