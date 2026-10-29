'use strict';

/**
 * 打包成 Windows 可直接运行的应用（免安装绿色版）
 *   node scripts/build-win.js [--zip] [--electron=<electron 目录>]
 *
 * 做法：把一个 Electron 运行时目录整份拷出来当骨架，把本项目的应用文件放进
 * resources/app，重命名主程序为 TokenLens.exe，再用 resedit 改写 PE 资源
 * （图标 + 版本信息），最后可选打成一个 zip。
 *
 * 为什么不引 electron-builder：它要联网拉 Electron 与 NSIS/codesign 工具链，
 * 而本机已自带运行时；这里直接复用，离线也能产出可双击的 exe。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = 'TokenLens';
const OUT_DIR = path.join(ROOT, 'dist', `${APP_NAME}-win64`);
const APP_FILES = ['src', 'assets', 'package.json', 'README.md', 'RELEASE.md', 'LICENSE'];
/** 只保留这两个语言包，其余 55 个能省下 45MB */
const KEEP_LOCALES = new Set(['en-US.pak', 'zh-CN.pak']);

const args = process.argv.slice(2);
const wantZip = args.includes('--zip');
const electronArg = (args.find((a) => a.startsWith('--electron=')) || '').split('=')[1];

/* ---------------- 找运行时 ---------------- */
function findElectronDir() {
  const list = [
    electronArg,
    process.env.TOKENLENS_ELECTRON_DIR,
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'electron'),
  ].filter(Boolean);
  for (const dir of list) {
    if (fs.existsSync(path.join(dir, 'electron.exe'))) return dir;
  }
  return null;
}

/* ---------------- 工具 ---------------- */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyTree(src, dest, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (filter && !filter(src, name, true)) continue;
      copyTree(path.join(src, name), path.join(dest, name), filter);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const f = path.join(d, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else total += st.size;
    }
  };
  if (fs.existsSync(p)) walk(p);
  return total;
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- PE 资源（图标 + 版本信息） ---------------- */
function brandExecutable(exePath) {
  let ResEdit;
  try {
    ResEdit = require('resedit');
  } catch (e) {
    try {
      const toolsRequire = createRequire(path.join(ROOT, '..', '.tools', 'build', 'noop.js'));
      ResEdit = toolsRequire('resedit');
    } catch (e2) {
      console.warn('[build] 未安装 resedit，跳过图标与版本信息（npm i -D resedit 可启用）');
      return false;
    }
  }

  const icoPath = path.join(ROOT, 'assets', 'icon.ico');
  if (!fs.existsSync(icoPath)) {
    console.warn('[build] 缺少 assets/icon.ico，跳过图标写入（先跑 npm run icon）');
  }

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  if (fs.existsSync(icoPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((i) => i.data),
    );
  }

  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length) {
    const vi = viList[0];
    const [maj, min, patch] = PKG.version.split('.').map((x) => parseInt(x, 10) || 0);
    vi.setFileVersion(maj, min, patch, 0);
    vi.setProductVersion(maj, min, patch, 0);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: APP_NAME,
      FileDescription: 'TokenLens · Token 用量浮窗',
      CompanyName: '柒仔',
      LegalCopyright: 'MIT © 2026 柒仔',
      OriginalFilename: `${APP_NAME}.exe`,
      InternalName: APP_NAME,
      FileVersion: PKG.version,
      ProductVersion: PKG.version,
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return true;
}

/* ---------------- ZIP（store/deflate 混合，支持大文件） ---------------- */
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

function zipDir(srcDir, outFile) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else files.push({ full, rel, size: st.size });
    }
  };
  walk(srcDir, '');

  const d = new Date();
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dosDate = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);

  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const crc = crc32(data);
    // 实测主程序能压到 44%（215MB → 94MB），值得花几秒；只给超大文件留 store 兜底
    const store = data.length > 512 * 1024 * 1024;
    const payload = store ? data : zlib.deflateRawSync(data, { level: 6 });
    const method = store ? 0 : 8;
    const nameBuf = Buffer.from(f.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    fs.writeSync(fd, local);
    fs.writeSync(fd, nameBuf);
    fs.writeSync(fd, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0x81a40000, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeSync(fd, centralBuf);
  fs.writeSync(fd, eocd);
  fs.closeSync(fd);

  return { count: files.length, size: fs.statSync(outFile).size };
}

/* ---------------- 主流程 ---------------- */
function main() {
  const electronDir = findElectronDir();
  if (!electronDir) {
    console.error([
      '未找到 Electron 运行时目录（应包含 electron.exe）。',
      '可用 --electron=<目录> 指定，或先 npm install electron。',
    ].join('\n'));
    process.exit(1);
  }
  console.log(`[build] 运行时：${electronDir}`);

  rmrf(OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 拷运行时骨架
  for (const name of fs.readdirSync(electronDir)) {
    const src = path.join(electronDir, name);
    const dest = path.join(OUT_DIR, name);
    if (name === 'locales') {
      fs.mkdirSync(dest, { recursive: true });
      for (const pak of fs.readdirSync(src)) {
        if (KEEP_LOCALES.has(pak)) fs.copyFileSync(path.join(src, pak), path.join(dest, pak));
      }
      continue;
    }
    if (name === 'electron.exe') continue;
    if (name === 'resources') continue;
    copyTree(src, dest);
  }

  // 2) resources/app 放应用本体（不用 asar，便于用户查看与改配置）
  const appDir = path.join(OUT_DIR, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of APP_FILES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(appDir, entry));
  }

  // 3) 主程序改名
  const exeSrc = path.join(electronDir, 'electron.exe');
  const exeDest = path.join(OUT_DIR, `${APP_NAME}.exe`);
  fs.copyFileSync(exeSrc, exeDest);

  const branded = brandExecutable(exeDest);
  console.log(`[build] PE 资源：${branded ? '图标 + 版本信息已写入' : '未改写'}`);

  // 4) 附带图标与说明
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(OUT_DIR, 'icon.png'));

  const size = dirSize(OUT_DIR);
  const exeSize = fs.statSync(exeDest).size;
  console.log(`[build] 输出目录：${OUT_DIR}`);
  console.log(`[build] 体积：${mb(size)}（主程序 ${mb(exeSize)}）`);

  if (wantZip) {
    const zipPath = path.join(ROOT, 'dist', `${APP_NAME}-${PKG.version}-win64-portable.zip`);
    rmrf(zipPath);
    const r = zipDir(OUT_DIR, zipPath);
    console.log(`[build] 压缩包：${zipPath}（${r.count} 个文件，${mb(r.size)}）`);
  }

  console.log(`\n双击运行：${path.join(OUT_DIR, `${APP_NAME}.exe`)}`);
  console.log('（首次启动若被 SmartScreen 拦一次，点「更多信息 → 仍要运行」即可，未做代码签名）');
}

main();
