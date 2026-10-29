'use strict';

/**
 * 自检：确认运行环境能否正常读到 harness 数据。
 *   node scripts/doctor.js
 */

const os = require('os');
const path = require('path');
const zlib = require('zlib');
const collector = require('../src/main/collector');
const workbuddy = require('../src/main/workbuddy');

const line = (k, v) => console.log(`  ${String(k).padEnd(16)} ${v}`);

console.log('\nTokenLens 环境自检\n' + '='.repeat(46));
line('Node', process.versions.node);
line('zstd 支持', typeof zlib.zstdDecompressSync === 'function' ? '✓' : '✗（需 Node ≥ 22.15）');
line('平台', `${process.platform} ${process.arch}`);
line('HOME', os.homedir());

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
line('harness 目录', home);

const info = collector.readProjCache(home);
const files = collector.readSessionFiles(home);
line('投影缓存会话', `${info.size} 个`);
line('事件流会话', `${files.size} 个`);

const snap = collector.collect({ home });
line('harness 版本', snap.harness.desktopVersion || '未检出');
line('会话格式', snap.harness.sessionFormat ? `v${snap.harness.sessionFormat}` : '未检出');
line('profile', snap.harness.profile || '—');

if (snap.warnings.length) {
  console.log('\n警告：');
  snap.warnings.forEach((w) => console.log(`  ! ${w}`));
}

console.log('\n会话明细：');
if (!snap.sessions.length) {
  console.log('  （无）——先在 harness 里跑一个任务，再回来执行本命令');
} else {
  for (const s of snap.sessions) {
    const t = s.totals;
    const total = t.uncachedInput + t.output + t.cacheRead + t.cacheWrite;
    console.log(`  · ${String(s.title).slice(0, 40)}`);
    console.log(`    轮次 ${s.turns.length} · 工具调用 ${s.toolCalls.length} · 总计 ${total.toLocaleString('zh-CN')} tokens`
      + `（未缓存 ${t.uncachedInput.toLocaleString('zh-CN')} / 缓存 ${t.cacheRead.toLocaleString('zh-CN')} / 输出 ${t.output.toLocaleString('zh-CN')}）`);
    const mods = Object.values(s.modules).map((m) => `${m.label} ${m.tokens}`).join(' · ');
    console.log(`    模块 ${mods}`);
  }
}

console.log('\n每日用量：');
if (!snap.daily.length) console.log('  （无）');
snap.daily.forEach((d) => console.log(`  ${d.date}  ${String(d.total).padStart(9)}  (${d.turns} 轮)`));

// ---------------- WorkBuddy ----------------
console.log('\nWorkBuddy 用量\n' + '-'.repeat(46));
const wb = workbuddy.collect({});
line('会话目录', wb.source.home);
line('会话', `${wb.source.withUsage} 个有用量 / 共 ${wb.source.sessions} 个`);
line('请求次数', wb.totals.requests);
line('总 tokens', `${wb.totals.total.toLocaleString('zh-CN')}（未缓存 ${wb.totals.uncachedInput.toLocaleString('zh-CN')} / 缓存 ${wb.totals.cacheRead.toLocaleString('zh-CN')} / 输出 ${wb.totals.output.toLocaleString('zh-CN')}）`);
line('模型', wb.models.length ? wb.models.map((m) => `${m.name}(${m.requests})`).join(' · ') : '（无）');
if (wb.warnings.length) wb.warnings.forEach((w) => console.log(`  ! ${w}`));

console.log('\n结论：' + (snap.source.exists && snap.sessions.length
  ? '数据链路正常，可以启动浮窗（npm start）。'
  : '未读到会话数据，可先用 npm run demo 看示例面板。') + '\n');
