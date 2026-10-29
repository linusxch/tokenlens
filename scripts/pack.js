'use strict';

/**
 * 打包：把可运行目录压成一个 zip（纯 Node 实现的 ZIP 写入，不依赖外部命令）。
 *   node scripts/pack.js        → dist/tokenlens-<version>.zip
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const INCLUDE = ['src', 'assets', 'scripts', 'package.json', 'README.md', 'RELEASE.md', 'LICENSE'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.data', '.shots']);

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

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function walk(rel, out = []) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return out;
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(full))) return out;
    for (const child of fs.readdirSync(full)) walk(path.posix.join(rel, child), out);
  } else {
    out.push(rel);
  }
  return out;
}

const files = [];
for (const entry of INCLUDE) walk(entry, files);

const now = new Date();
const { time, date } = dosTime(now);
const localParts = [];
const centralParts = [];
let offset = 0;

for (const rel of files) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  const crc = crc32(data);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  localParts.push(local, name, comp);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0x81a40000, 38); // 0644 << 16
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);

  offset += local.length + name.length + comp.length;
}

const centralBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...localParts, centralBuf, eocd]);
const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outFile = path.join(distDir, `tokenlens-${PKG.version}.zip`);
fs.writeFileSync(outFile, zip);

console.log(`[pack] ${files.length} 个文件 → ${path.relative(ROOT, outFile)} (${(zip.length / 1024).toFixed(1)} KB)`);
