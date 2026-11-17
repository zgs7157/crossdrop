'use strict';

/*
 * 仓库只存放可读文本：第三方前端库与图标都由本脚本在构建前就位。
 *   1. src/vendor/peerjs.min.js  从 node_modules/peerjs 复制
 *   2. build/icon.png / icon.ico 由 scripts/make-icon.js 现场绘制
 * 已存在同名文件时不会覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const vendor = path.join(ROOT, 'src', 'vendor', 'peerjs.min.js');
const vendorSrc = path.join(ROOT, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js');

if (!fs.existsSync(vendor)) {
  if (!fs.existsSync(vendorSrc)) {
    console.error('[assets] 缺少 node_modules/peerjs，请先执行 npm install');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(vendor), { recursive: true });
  fs.copyFileSync(vendorSrc, vendor);
  console.log('[assets] copied peerjs.min.js (' + fs.statSync(vendor).size + ' bytes)');
} else {
  console.log('[assets] keep existing: src/vendor/peerjs.min.js');
}

if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
  require('./make-icon.js');
} else {
  console.log('[assets] keep existing: build/icon.ico');
}

