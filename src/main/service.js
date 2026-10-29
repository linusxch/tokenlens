'use strict';

/**
 * 服务层：把采集器 / 历史库 / 示例数据组装成渲染层直接可用的视图模型。
 * Electron 主进程与 HTTP 面板模式（scripts/serve.js）共用这一份逻辑。
 */

const os = require('os');
const path = require('path');
const collector = require('./collector');
const history = require('./history');
const { buildDemoSnapshot } = require('./demo');

const DAYS = 14;

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
   * @param {{home?:string, dataDir:string, demo?:boolean}} options
   */
  constructor(options) {
    this.home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dataDir = options.dataDir || path.join(os.homedir(), '.tokenlens');
    this.historyFile = path.join(this.dataDir, 'history.json');
    this.demo = !!options.demo;
    this.db = history.load(this.historyFile);
  }

  setDemo(flag) {
    this.demo = !!flag;
  }

  setHome(home) {
    if (!home) return;
    this.home = home;
  }

  /** 采集 + 落历史 + 组装视图模型 */
  snapshot(prefs = {}) {
    const raw = this.demo ? buildDemoSnapshot() : collector.collect({ home: this.home });

    if (!this.demo) {
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
      generatedAt: Date.now(),
      demo: !!this.demo,
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
