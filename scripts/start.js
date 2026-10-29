'use strict';

/**
 * 启动器：优先用项目内的 electron，其次复用 DeepSeek Harness 自带的 Electron 运行时，
 * 最后才回落到 PATH 上的 electron。这样「零安装」也能跑起来。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function candidates() {
  const list = [];
  if (process.env.TOKENLENS_ELECTRON) list.push({ exe: process.env.TOKENLENS_ELECTRON, label: 'TOKENLENS_ELECTRON' });

  const local = path.join(ROOT, 'node_modules', 'electron', 'dist');
  list.push({ exe: path.join(local, 'electron.exe'), label: 'node_modules/electron' });
  list.push({ exe: path.join(local, 'electron'), label: 'node_modules/electron' });

  const dsh = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  list.push({ exe: path.join(dsh, 'electron', 'electron.exe'), label: 'harness 内置 electron' });

  return list;
}

function findElectron() {
  for (const c of candidates()) {
    if (exists(c.exe)) return c;
  }
  return null;
}

const found = findElectron();
if (!found) {
  console.error([
    '未找到可用的 Electron 运行时。',
    '可以任选一种方式：',
    '  1) npm install          # 安装项目内的 electron',
    '  2) 设置 TOKENLENS_ELECTRON=<electron.exe 路径>',
    '  3) 确保 DeepSeek Harness 已安装（自带 Electron 运行时）',
  ].join('\n'));
  process.exit(1);
}

const passArgs = process.argv.slice(2);

// 从某些 IDE / 终端继承来的 ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node，
// 表现为 require('electron') 找不到模块，这里必须清掉。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(found.exe, [ROOT, ...passArgs], {
  stdio: 'inherit',
  windowsHide: false,
  env,
});

console.log(`[TokenLens] 运行时：${found.label}\n[TokenLens] ${found.exe}`);

child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('[TokenLens] 启动失败：', err.message);
  process.exit(1);
});
