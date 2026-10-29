'use strict';

/**
 * 生成应用图标（无第三方依赖，纯 Node 手写 PNG）。
 * 输出：assets/icon.png (256)、assets/tray.png (32)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制 ---------- */
function roundRect(buf, W, x0, y0, w, h, r, color) {
  const [cr, cg, cb, ca] = color;
  for (let y = Math.floor(y0); y < y0 + h; y += 1) {
    for (let x = Math.floor(x0); x < x0 + w; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      const dx = Math.max(x0 + r - x, x - (x0 + w - r), 0);
      const dy = Math.max(y0 + r - y, y - (y0 + h - r), 0);
      const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h
        && (dx === 0 || dy === 0 || dx * dx + dy * dy <= r * r);
      if (!inside) continue;
      const i = (y * W + x) * 4;
      buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = ca;
    }
  }
}

function gradientRect(buf, W, x0, y0, w, h, r, c1, c2) {
  const tmp = Buffer.alloc(buf.length);
  for (let y = Math.floor(y0); y < y0 + h; y += 1) {
    const t = (y - y0) / Math.max(1, h - 1);
    const col = [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
      255,
    ];
    roundRect(tmp, W, x0, y, w, 1, Math.min(r, 1), col);
  }
  for (let i = 0; i < buf.length; i += 4) {
    if (tmp[i + 3] > 0) {
      const a = tmp[i + 3] / 255;
      buf[i] = Math.round(tmp[i] * a + buf[i] * (1 - a));
      buf[i + 1] = Math.round(tmp[i + 1] * a + buf[i + 1] * (1 - a));
      buf[i + 2] = Math.round(tmp[i + 2] * a + buf[i + 2] * (1 - a));
      buf[i + 3] = Math.max(buf[i + 3], tmp[i + 3]);
    }
  }
}

/** 4x 超采样绘制后降采样，得到干净的圆角与描边 */
function drawIcon(size) {
  const SS = 4;
  const W = size * SS;
  const big = Buffer.alloc(W * W * 4, 0);

  // 底板：蓝紫渐变圆角方块
  gradientRect(big, W, 0, 0, W, W, W * 0.225, [76, 111, 255], [124, 77, 255]);

  // 底部微光
  const glow = Buffer.alloc(big.length);
  roundRect(glow, W, W * 0.14, W * 0.62, W * 0.72, W * 0.26, W * 0.09, [255, 255, 255, 34]);
  for (let i = 0; i < big.length; i += 4) {
    if (glow[i + 3] > 0) {
      const a = glow[i + 3] / 255;
      big[i] = Math.round(255 * a + big[i] * (1 - a));
      big[i + 1] = Math.round(255 * a + big[i + 1] * (1 - a));
      big[i + 2] = Math.round(255 * a + big[i + 2] * (1 - a));
    }
  }

  // 三根柱子（token 用量条）
  const bars = [
    { x: 0.22, h: 0.30, c: [255, 255, 255, 235] },
    { x: 0.42, h: 0.46, c: [255, 255, 255, 245] },
    { x: 0.62, h: 0.62, c: [255, 255, 255, 255] },
  ];
  const bw = W * 0.14;
  const baseY = W * 0.76;
  for (const b of bars) {
    const h = W * b.h;
    roundRect(big, W, W * b.x, baseY - h, bw, h, bw * 0.45, b.c);
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          const al = big[i + 3] / 255;
          r += big[i] * al; g += big[i + 1] * al; b += big[i + 2] * al; a += al;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, out);
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), drawIcon(256));
fs.writeFileSync(path.join(dir, 'tray.png'), drawIcon(32));
fs.writeFileSync(path.join(dir, 'icon@16.png'), drawIcon(16));
console.log('icons written to', dir);
