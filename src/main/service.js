'use strict';

/**
 * 服务层：把采集器 / 历史库 / 示例数据组装成渲染层直接可用的视图模型。
 * Electron 主进程与 HTTP 面板模式（scripts/serve.js）共用这一份逻辑。
 */

const os = require('os');
const path = require('path');
const collector = require('./collector');
const workbuddy = require('./workbuddy');
const history = require('./history');
const { buildDemoSnapshot } = require('./demo');

const DAYS = 14;

/**
 * 模型短名：面板列宽有限，把 "DeepSeek-V4.1-Flash" 收敛成 "V4.1-Flash"。
 * 只在名字过长时处理，完整名字仍保留在 tooltip 里。
 */
function shortModelName(name) {
  const s = String(name || '').trim();
  if (s.length <= 12) return s;
  const parts = s.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 3) return parts.slice(1).join('-');
  return `${s.slice(0, 11)}…`;
}

/** 模型 / 模块配色（模型数超过 4 个时循环取用） */
const PALETTE = ['#4c6fff', '#12b886', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#64748b'];

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function mmss(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * 会话标题清洗：harness 有时把首条消息（可能是文件路径）直接当标题，
 * 这里把「看起来像路径」的标题换成「工作区目录名 · 短 id」。
 */
function cleanTitle(title, cwd, id) {
  const t = String(title || '').trim();
  const looksPath = /[\\/]/.test(t) || /\.(md|json|txt|png|jpe?g|xlsx|pdf|zip)$/i.test(t);
  if (t && !looksPath && t.length <= 44) return t;
  const base = String(cwd || '').split(/[\\/]/).filter(Boolean).pop();
  if (base) return `${base} · ${String(id).slice(0, 6)}`;
  return `会话 ${String(id).slice(0, 6)}`;
}

class Service {
  /**
   * @param {{home?:string, wbHome?:string, dataDir:string, demo?:boolean, source?:string}} options
   */
  constructor(options) {
    this.home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.wbHome = options.wbHome || process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
    this.dataDir = options.dataDir || path.join(os.homedir(), '.tokenlens');
    this.historyFile = path.join(this.dataDir, 'history.json');
    this.wbHistoryFile = path.join(this.dataDir, 'history-workbuddy.json');
    this.demo = !!options.demo;
    this.source = options.source || 'harness';
    this.db = history.load(this.historyFile);
    this.wbDb = history.load(this.wbHistoryFile);
  }

  setDemo(flag) {
    this.demo = !!flag;
    if (flag) this.source = 'harness';
  }

  setSource(source) {
    if (!source) return;
    this.source = source;
    this.demo = source === 'demo';
  }

  setHome(home) {
    if (!home) return;
    this.home = home;
  }

  /** 采集 + 落历史 + 组装视图模型 */
  snapshot(prefs = {}) {
    const source = prefs.source || this.source || 'harness';
    if (source === 'workbuddy') return this.workbuddySnapshot(prefs);
    const demo = source === 'demo' || this.demo;
    return this.harnessSnapshot(prefs, demo);
  }

  harnessSnapshot(prefs = {}, demo = false) {
    const raw = demo ? buildDemoSnapshot() : collector.collect({ home: this.home });

    if (!demo) {
      history.merge(this.db, raw);
      history.save(this.historyFile, this.db);
    }

    const daily = history.series(this.db, raw.daily, DAYS);
    const sessions = (raw.sessions || []).filter(
      (s) => s.hasEvents || (s.totals && (s.totals.uncachedInput || s.totals.output || s.totals.cacheRead)),
    );

    const withUsage = sessions.filter((s) => {
      const t = s.totals || {};
      return (t.uncachedInput || 0) + (t.output || 0) + (t.cacheRead || 0) > 0;
    });
    const pool = (withUsage.length ? withUsage : sessions).slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    let activeId = prefs.sessionId || null;
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      activeId = pool[0] ? pool[0].id : null;
    }
    const active = sessions.find((s) => s.id === activeId) || null;

    const today = daily[daily.length - 1] || { total: 0, uncachedInput: 0, output: 0, cacheRead: 0, turns: 0 };
    const yesterday = daily[daily.length - 2] || { total: 0 };
    const week = daily.slice(-7);
    const weekTotal = week.reduce((a, d) => a + d.total, 0);
    const activeDays = week.filter((d) => d.total > 0).length || 1;

    const payload = {
      ok: true,
      mode: 'harness',
      generatedAt: Date.now(),
      demo,
      harness: raw.harness,
      source: raw.source,
      warnings: raw.warnings || [],
      sessions: sessions.map((s) => ({
        id: s.id,
        title: cleanTitle(s.title, s.cwd, s.id),
        model: s.model,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        totals: s.totals,
        turns: s.turns.length,
        delegationDepth: s.delegationDepth,
      })),
      activeId,
      active: active ? this.viewSession(active) : null,
      daily,
      totals: raw.totals,
      summary: {
        today,
        yesterday,
        deltaPct: yesterday.total ? pct(today.total - yesterday.total, yesterday.total) : null,
        weekTotal,
        weekAvg: Math.round(weekTotal / activeDays),
        cacheHitRate: pct(
          (raw.totals?.cacheRead || 0),
          (raw.totals?.cacheRead || 0) + (raw.totals?.uncachedInput || 0),
        ),
        sessions: sessions.length,
        spanDays: daily.filter((d) => d.total > 0).length,
      },
    };
    return payload;
  }

  /**
   * WorkBuddy 用量视图：聚合所有会话，按模型拆分。
   * 与 harness 的差别：没有「模块/上下文水位」，多了「模型分布」和「请求画像」。
   */
  workbuddySnapshot(prefs = {}) {
    let raw;
    try {
      raw = workbuddy.collect({ home: this.wbHome });
    } catch (err) {
      return {
        ok: false,
        mode: 'workbuddy',
        error: String(err && err.message),
        source: { home: this.wbHome, exists: false },
        warnings: [String(err && err.message)],
        sessions: [],
        models: [],
        daily: [],
        summary: { today: { total: 0 }, yesterday: { total: 0 }, deltaPct: null, weekTotal: 0, weekAvg: 0, cacheHitRate: 0, sessions: 0 },
      };
    }

    // WorkBuddy 的按日归属是精确的，只做每日合并，不做「首见归创建日」外推
    history.mergeDaily(this.wbDb, raw.daily);
    history.save(this.wbHistoryFile, this.wbDb);

    const daily = history.series(this.wbDb, raw.daily, DAYS)
      .map((d) => ({ ...d, requests: d.turns }));

    const today = daily[daily.length - 1] || {
      total: 0, uncachedInput: 0, output: 0, cacheRead: 0, requests: 0,
    };
    const yesterday = daily[daily.length - 2] || { total: 0 };
    const week = daily.slice(-7);
    const weekTotal = week.reduce((a, d) => a + d.total, 0);
    const activeDays = week.filter((d) => d.total > 0).length || 1;

    const totals = raw.totals || {};
    const models = (raw.models || []).map((m, i) => ({
      ...m,
      short: shortModelName(m.name),
      color: PALETTE[i % PALETTE.length],
      avgPerRequest: m.requests ? Math.round(m.total / m.requests) : 0,
      cacheHitRate: pct(m.cacheRead, m.cacheRead + m.uncachedInput),
    }));

    const sessions = (raw.sessions || []).map((s) => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      model: s.model,
      models: s.models,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      totals: s.totals,
      totalTokens: (s.totals?.uncachedInput || 0) + (s.totals?.cacheRead || 0) + (s.totals?.output || 0),
      requests: s.requests,
      reasoning: s.reasoning,
      credit: s.credit,
    }));

    return {
      ok: true,
      mode: 'workbuddy',
      generatedAt: Date.now(),
      demo: false,
      source: raw.source,
      warnings: raw.warnings || [],
      sessions,
      models,
      daily,
      totals,
      summary: {
        today,
        yesterday,
        deltaPct: yesterday.total ? pct(today.total - yesterday.total, yesterday.total) : null,
        weekTotal,
        weekAvg: Math.round(weekTotal / activeDays),
        cacheHitRate: pct(totals.cacheRead || 0, (totals.cacheRead || 0) + (totals.uncachedInput || 0)),
        sessions: sessions.length,
        requests: totals.requests || 0,
        models: models.length,
        credits: totals.credit || 0,
        reasoning: totals.reasoning || 0,
        avgPerRequest: totals.requests ? Math.round(totals.total / totals.requests) : 0,
        spanDays: daily.filter((d) => d.total > 0).length,
      },
    };
  }

  /** 单个会话的展示模型：模块占比、逐轮上下行、上下文水位 */
  viewSession(s) {
    const modules = ['context', 'connector', 'subagent', 'tools']
      .map((k) => s.modules[k])
      .filter(Boolean);
    const moduleTotal = modules.reduce((a, m) => a + m.tokens, 0) || 1;

    const turns = (s.turns || []).map((t) => {
      const up = (t.uncachedInput || 0) + (t.cacheRead || 0);
      const down = t.output || 0;
      return {
        turn: t.turn,
        label: `T${t.turn}`,
        prompt: t.prompt || '',
        up,
        down,
        uncachedInput: t.uncachedInput,
        cacheRead: t.cacheRead,
        output: t.output,
        steps: t.steps,
        toolCount: t.toolCount,
        connectorCount: t.connectorCount,
        subagentCount: t.subagentCount,
        modules: t.modules,
        allocated: !!t.allocated,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        durationMs: t.endedAt && t.startedAt ? t.endedAt - t.startedAt : null,
      };
    });

    const maxTurn = turns.reduce(
      (m, t) => Math.max(m, t.up, t.down), 0,
    ) || 1;

    const ctx = s.context || {};
    const window = ctx.contextWindow || 0;
    const surface = ctx.surfaceTokens || 0;

    const st = s.stats || {};
    return {
      id: s.id,
      title: cleanTitle(s.title, s.cwd, s.id),
      cwd: s.cwd,
      model: s.model,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      allocated: !!s.allocated,
      totals: s.totals,
      totalTokens: (s.totals?.uncachedInput || 0) + (s.totals?.output || 0)
        + (s.totals?.cacheRead || 0) + (s.totals?.cacheWrite || 0),
      modules: modules.map((m) => ({
        key: m.key,
        label: m.label,
        tokens: m.tokens,
        calls: m.calls || 0,
        estimated: !!m.estimated,
        schemaTokens: m.schemaTokens || 0,
        resultTokens: m.resultTokens || 0,
        pct: pct(m.tokens, moduleTotal),
      })),
      moduleTotal,
      context: {
        surfaceTokens: surface,
        contextWindow: window,
        usedPct: window ? pct(surface, window) : 0,
        systemTokens: ctx.systemTokens || 0,
        toolsTokens: ctx.toolsTokens || 0,
        messageTokens: ctx.messageTokens || 0,
        pressureTokens: ctx.pressureTokens || 0,
      },
      turns,
      maxTurn,
      stats: {
        turns: st.turns || turns.length,
        steps: st.steps || 0,
        llmMs: st.llmMs || 0,
        toolMs: st.toolMs || 0,
        toolCalls: (s.toolCalls || []).length
          || turns.reduce((a, t) => a + (t.toolCount || 0), 0),
        cacheHitRate: pct(
          s.totals?.cacheRead || 0,
          (s.totals?.cacheRead || 0) + (s.totals?.uncachedInput || 0),
        ),
      },
      toolSummary: this.summarizeTools(s.toolCalls || []),
    };
  }

  summarizeTools(calls) {
    const map = new Map();
    for (const c of calls) {
      const cur = map.get(c.name) || { name: c.name, module: c.module, calls: 0, tokens: 0 };
      cur.calls += 1;
      cur.tokens += c.tokens || 0;
      map.set(c.name, cur);
    }
    return [...map.values()]
      .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls)
      .slice(0, 6);
  }
}

module.exports = { Service, DAYS, mmss };
