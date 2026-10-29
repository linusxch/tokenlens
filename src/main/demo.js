'use strict';

/**
 * 示例数据：用于首次安装 / 会话被清理后预览完整面板。
 * 确定性随机（固定种子），每次生成结果一致，便于截图与自测。
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 每次生成都用同一粒种子重建序列，保证刷新时数值稳定
let rand = mulberry32(20261029);

const SESSION_TITLES = [
  '重构 collector 的多帧 zstd 解析',
  '给浮窗加置顶与托盘菜单',
  '梳理连接器工具的 schema 开销',
  '修每日统计跨天累加的口径',
  '生成 RELEASE.md 与兼容矩阵',
];

function ms(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0).getTime();
}

function buildDaily(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const base = weekend ? 0.35 : 1;
    const wobble = 0.55 + rand() * 0.9;
    const uncachedInput = Math.round(base * wobble * (90000 + rand() * 260000));
    const output = Math.round(uncachedInput * (0.03 + rand() * 0.05));
    const cacheRead = Math.round(uncachedInput * (0.4 + rand() * 0.5));
    out.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: d.getDay(),
      uncachedInput,
      output,
      cacheRead,
      total: uncachedInput + output + cacheRead,
      turns: Math.round(2 + rand() * 9),
      sessions: 1 + Math.round(rand() * 2),
      isToday: i === 0,
    });
  }
  return out;
}

function buildSession(index) {
  const turnCount = 3 + Math.floor(rand() * 4);
  const turns = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalCache = 0;
  for (let t = 1; t <= turnCount; t += 1) {
    const uncachedInput = Math.round(12000 + rand() * 52000 * t * 0.55);
    const output = Math.round(600 + rand() * 3400);
    const cacheRead = Math.round(uncachedInput * (0.3 + rand() * 0.45));
    totalIn += uncachedInput;
    totalOut += output;
    totalCache += cacheRead;
    const connector = Math.round(rand() * 9000);
    const subagent = t % 3 === 0 ? Math.round(4000 + rand() * 22000) : Math.round(rand() * 900);
    const tools = Math.round(1200 + rand() * 15000);
    turns.push({
      turn: t,
      startedAt: ms(2026, 10, 20 + index, 9 + t, 5),
      endedAt: ms(2026, 10, 20 + index, 9 + t, 48),
      uncachedInput,
      output,
      cacheRead,
      cacheWrite: 0,
      steps: 2 + Math.floor(rand() * 4),
      toolCount: Math.round(rand() * 6),
      subagentCount: t % 3 === 0 ? 2 : 0,
      connectorCount: Math.round(rand() * 3),
      modules: { context: Math.round(uncachedInput * 0.42), connector, subagent, tools },
      prompt: [
        '看一下当前会话的上下文占用，顺便把连接器的开销拆出来',
        '把浮窗改成无边框置顶，加托盘菜单',
        '每日统计要能跨天累积，别每天清零',
        '生成 release 说明，标注兼容的 harness 版本',
        '子智能体的用量单独占一行',
        '缓存命中率也一起显示',
        '把这几个数字对齐到同一口径',
      ][(t - 1) % 7],
    });
  }

  const modules = {
    context: { key: 'context', label: '上下文', tokens: Math.round(totalIn * 0.38), schemaTokens: 8600, resultTokens: 0, calls: turnCount, estimated: false },
    connector: { key: 'connector', label: '连接器', tokens: turns.reduce((a, t) => a + t.modules.connector, 0), schemaTokens: 12400, resultTokens: 0, calls: turns.reduce((a, t) => a + t.connectorCount, 0), estimated: true },
    subagent: { key: 'subagent', label: '子智能体', tokens: turns.reduce((a, t) => a + t.modules.subagent, 0), schemaTokens: 3100, resultTokens: 0, calls: turns.reduce((a, t) => a + t.subagentCount, 0), estimated: true },
    tools: { key: 'tools', label: '工具执行', tokens: turns.reduce((a, t) => a + t.modules.tools, 0), schemaTokens: 5200, resultTokens: 0, calls: turns.reduce((a, t) => a + t.toolCount, 0), estimated: true },
  };

  return {
    id: `demo-${index + 1}`,
    title: SESSION_TITLES[index % SESSION_TITLES.length],
    cwd: 'C:\\Users\\demo\\deepseek-harness\\default-workspace',
    createdAt: ms(2026, 10, 20 + index, 9, 0),
    updatedAt: ms(2026, 10, 20 + index, 15, 30),
    delegationDepth: 0,
    model: index % 3 === 0 ? 'deepseek/deepseek-flash' : 'workbuddy/hy4-preview-f',
    totals: { uncachedInput: totalIn, output: totalOut, cacheRead: totalCache, cacheWrite: 0 },
    turns,
    modules,
    context: {
      surfaceTokens: Math.round(totalIn * 0.22) + 9000,
      contextWindow: 960000,
      pressureTokens: Math.round(totalIn * 0.1),
      systemTokens: 4800,
      toolsTokens: 29000,
      messageTokens: Math.round(totalIn * 0.2),
    },
    stats: {
      turns: turnCount,
      steps: turnCount * 3,
      toolCalls: turns.reduce((a, t) => a + t.toolCount, 0),
      llmMs: 0,
      toolMs: 0,
    },
    toolCalls: [],
    toolsSeen: [],
    allocated: false,
    hasEvents: true,
  };
}

function buildDemoSnapshot() {
  rand = mulberry32(20261029);
  const sessions = [0, 1, 2, 3, 4].map(buildSession);
  const totals = sessions.reduce((a, s) => ({
    uncachedInput: a.uncachedInput + s.totals.uncachedInput,
    output: a.output + s.totals.output,
    cacheRead: a.cacheRead + s.totals.cacheRead,
    cacheWrite: 0,
    total: a.total + s.totals.uncachedInput + s.totals.output + s.totals.cacheRead,
  }), { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

  return {
    generatedAt: Date.now(),
    demo: true,
    source: { home: '（示例数据）', exists: true, cachedSessions: sessions.length, eventSessions: sessions.length },
    harness: {
      home: '（示例数据）',
      desktopVersion: '0.2.1-rc.2',
      sessionFormat: 4,
      profile: 'desktop',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-pet'],
      electronVersion: null,
      node: process.versions.node,
    },
    sessions,
    daily: buildDaily(14),
    totals,
    warnings: [],
  };
}

module.exports = { buildDemoSnapshot };
