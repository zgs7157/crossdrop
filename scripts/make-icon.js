'use strict';

/*
 * 从代码生成应用图标（无第三方依赖）：
 *   build/icon.png   512×512 透明底圆角方形 + 白色双向箭头
 *   build/icon.ico   多尺寸（16/24/32/48/64/128/256）供 Windows 使用
 *
 * 图形全部用解析几何画出来，4× 超采样后缩放，边缘足够干净。
 * 用法：node scripts/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------ 形状定义 */

const RADIUS = 0.215; // 圆角半径（相对边长）
const GRAD_FROM = [44, 186, 166]; // 左上
const GRAD_TO = [20, 105, 100]; // 右下
const ARROW_WHITE = [255, 255, 255];

// 每支箭头：轴（胶囊）起点/终点 + 三角箭头底边/顶点
const ARROWS = [
  {
    shaft: [0.190, 0.313, 0.610, 0.313],
    r: 0.058,
    headBase: 0.585,
    headTip: 0.800,
    headHalf: 0.118
  },
  {
    shaft: [0.390, 0.687, 0.810, 0.687],
    r: 0.058,
    headBase: 0.415,
    headTip: 0.200,
    headHalf: 0.118
  }
];

function roundedRectCoverage(x, y) {
  const dx = Math.max(RADIUS - x, 0, x - (1 - RADIUS));
  const dy = Math.max(RADIUS - y, 0, y - (1 - RADIUS));
  return Math.hypot(dx, dy) <= RADIUS;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function arrowCoverage(x, y, a) {
  const [sx0, sy0, sx1, sy1] = a.shaft;
  if (segmentDistance(x, y, sx0, sy0, sx1, sy1) <= a.r) return true;

  const dir = a.headTip > a.headBase ? 1 : -1;
  const baseX = a.headBase;
  const tipX = a.headTip;
  const midY = (sy0 + sy1) / 2;
  return pointInTriangle(
    x,
    y,
    baseX,
    midY - a.headHalf,
    baseX,
    midY + a.headHalf,
    tipX,
    midY
  ) || (dir !== 0 && pointInTriangle(x, y, baseX + dir * 0.001, midY - a.headHalf, baseX + dir * 0.001, midY + a.headHalf, tipX, midY));
}

/* ------------------------------------------------------------ 渲染 */

function render(size, scale) {
  const S = size * scale;
  const out = Buffer.alloc(S * S * 4);

  for (let py = 0; py < S; py++) {
    const y = (py + 0.5) / S;
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / S;
      const i = (py * S + px) * 4;

      if (!roundedRectCoverage(x, y)) continue;

      const t = Math.min(1, Math.max(0, (x + y) / 2)); // 对角渐变
      let r = GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
      let g = GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
      let b = GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;

      for (const a of ARROWS) {
        if (arrowCoverage(x, y, a)) {
          r = ARROW_WHITE[0];
          g = ARROW_WHITE[1];
          b = ARROW_WHITE[2];
          break;
        }
      }

      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }

  return downsample(out, S, size, scale);
}

function downsample(src, S, size, scale) {
  const dst = Buffer.alloc(size * size * 4);
  const area = scale * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * S + (x * scale + sx)) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
        }
      }

      const o = (y * size + x) * 4;
      if (a === 0) {
        dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
        continue;
      }
      dst[o] = Math.round(r / a);
      dst[o + 1] = Math.round(g / a);
      dst[o + 2] = Math.round(b / a);
      dst[o + 3] = Math.round((a / area) * 255);
    }
  }

  return dst;
}

/* ------------------------------------------------------------ PNG / ICO */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/* ------------------------------------------------------------ 输出 */

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const samples = new Map();

for (const size of SIZES) samples.set(size, encodePng(size, render(size, size <= 64 ? 8 : 4)));
samples.set(512, encodePng(512, render(512, 2)));

fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), samples.get(512));
fs.writeFileSync(
  path.join(ROOT, 'build', 'icon.ico'),
  encodeIco(SIZES.map((size) => ({ size, png: samples.get(size) })))
);

console.log('[icon] build/icon.png ' + samples.get(512).length + ' bytes');
console.log('[icon] build/icon.ico ' + fs.statSync(path.join(ROOT, 'build', 'icon.ico')).size + ' bytes');
