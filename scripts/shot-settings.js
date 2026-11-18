'use strict';

/* 设置面板截图：展示自建服务与连接方式 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const TMP = path.join(os.tmpdir(), 'crossdrop-shot-settings-' + Date.now());
fs.mkdirSync(path.join(TMP, 'userData'), { recursive: true });
app.setPath('userData', path.join(TMP, 'userData'));

const OUT_DIR = path.join(__dirname, '..', 'docs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

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
  await sleep(1600);

  await win.webContents.executeJavaScript(`(function(){
    document.getElementById('btnSettings').click();
    document.getElementById('inpRelayUrl').value = 'ws://relay.example.com:9000/ws';
    document.getElementById('inpRelayToken').value = 'crossdrop2026';
    return true;
  })()`);
  await sleep(600);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'screenshot-3-settings.png'), image.toPNG());
  console.log('saved settings shot');
  app.exit(0);
});
