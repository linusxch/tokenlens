'use strict';

/**
 * 无界面面板模式：不启动 Electron，直接把面板跑成 HTTP 服务，
 * 便于嵌入 harness web profile 的 iframe，或在浏览器里常驻一个标签页。
 *
 *   node scripts/serve.js --port 4317 [--demo] [--home <dsh 目录>]
 */

const { Service } = require('../src/main/service');
const { startPanelServer } = require('../src/main/panel-server');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return fallback;
};

const port = Number(getArg('port', 4317));
const home = getArg('home', undefined);
const demo = args.includes('--demo');
const source = getArg('source', demo ? 'demo' : 'harness');

const service = new Service({ home, source });

startPanelServer(service, { port }).then((res) => {
  const snap = service.snapshot({});
  console.log(`[TokenLens] 面板模式已启动`);
  console.log(`  地址   ${res.url}`);
  console.log(`  数据源 ${snap.source.home}（${snap.mode}${snap.demo ? ' · 示例' : ''}）`);
  console.log(`  会话   ${snap.sessions.length} 个 · 今日 ${snap.summary.today.total} tokens`);
  if (args.includes('--open')) {
    const { exec } = require('child_process');
    exec(`start "" "${res.url}"`);
  }
  console.log('  Ctrl+C 退出');
}).catch((err) => {
  console.error('[TokenLens] 启动失败：', err.message);
  process.exit(1);
});
