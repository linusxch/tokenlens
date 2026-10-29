'use strict';

/**
 * WorkBuddy 采集器
 * ------------------------------------------------------------------
 * 数据来源：~/.workbuddy/projects/<project-slug>/<session-id>.jsonl
 *
 * 每个会话是一个 JSONL 事件流，逐条记录里 providerData 带用量信息：
 *   providerData.usage     —— 归一化后的 { inputTokens, outputTokens, totalTokens,
 *                              inputTokensDetails[].cached_tokens, outputTokensDetails[].reasoning_tokens }
 *   providerData.rawUsage  —— 原始口径 { prompt_tokens, completion_tokens,
 *                              prompt_cache_hit_tokens, prompt_cache_miss_tokens, credit, ... }
 *   providerData.model / requestModelId / requestModelName —— 模型信息
 *
 * 关键口径：
 *   - usage.inputTokens === rawUsage.prompt_tokens，**已包含**缓存命中部分；
 *     未缓存输入 = prompt_cache_miss_tokens（缺失时用 input − hit 兜底）。
 *   - 同一条 assistant 消息可能出现在 function_call / message 两种记录里，
 *     按 providerData.messageId 去重。
 *   - credit 为平台侧计量（部分记录缺省），只做展示，不做换算。
 *
 * 解析结果按 (mtime, size) 缓存，避免每 5 秒重解析十几 MB。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const fileCache = new Map(); // file -> { mtimeMs, size, parsed }

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeModelKey(name) {
  return String(name || '未知模型').trim().replace(/\s+/g, '').toLowerCase();
}

function dateKey(ts) {
  const d = new Date(ts);
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 从一条记录里抽出一次模型调用的用量 */
function stepOf(pd, ts) {
  const usage = pd.usage || {};
  const raw = pd.rawUsage || {};
  const input = num(usage.inputTokens) || num(raw.prompt_tokens);
  const output = num(usage.outputTokens) || num(raw.completion_tokens);
  const hitRaw = num(raw.prompt_cache_hit_tokens)
    || num(usage.inputTokensDetails && usage.inputTokensDetails[0] && usage.inputTokensDetails[0].cached_tokens)
    || num(raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens);
  const cacheRead = Math.min(hitRaw, input);
  const miss = num(raw.prompt_cache_miss_tokens);
  const uncachedInput = miss > 0 ? miss : Math.max(0, input - cacheRead);
  const reasoning = num(raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens)
    || num(usage.outputTokensDetails && usage.outputTokensDetails[0] && usage.outputTokensDetails[0].reasoning_tokens);

  return {
    ts,
    messageId: pd.messageId || null,
    requestId: pd.conversationRequestId || null,
    modelKey: normalizeModelKey(pd.requestModelName || pd.model),
    modelName: String(pd.requestModelName || pd.model || '未知模型').trim(),
    modelId: pd.requestModelId || pd.model || null,
    input,
    uncachedInput,
    cacheRead,
    output,
    reasoning,
    credit: num(raw.credit),
  };
}

/** 解析单个会话文件（带缓存） */
function parseSession(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.parsed;

  const parsed = {
    title: null,
    cwd: null,
    createdAt: null,
    updatedAt: null,
    firstUserText: null,
    steps: [],
    seenMessageIds: new Set(),
  };

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }

  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch (e) {
      continue;
    }
    const ts = num(rec.timestamp);
    if (ts) {
      if (!parsed.createdAt || ts < parsed.createdAt) parsed.createdAt = ts;
      if (!parsed.updatedAt || ts > parsed.updatedAt) parsed.updatedAt = ts;
    }
    if (rec.type === 'ai-title' && rec.aiTitle && !parsed.title) parsed.title = rec.aiTitle;
    if (rec.cwd && !parsed.cwd) parsed.cwd = rec.cwd;

    if (rec.type === 'message' && rec.role === 'user' && !parsed.firstUserText) {
      const content = rec.content;
      if (Array.isArray(content)) {
        const t = content.find((c) => c && (c.text || c.type === 'input_text'));
        if (t && t.text) parsed.firstUserText = String(t.text).slice(0, 200);
      } else if (typeof content === 'string') {
        parsed.firstUserText = content.slice(0, 200);
      }
    }

    const pd = rec.providerData;
    if (!pd || !pd.rawUsage) continue;
    if (pd.messageId) {
      if (parsed.seenMessageIds.has(pd.messageId)) continue;
      parsed.seenMessageIds.add(pd.messageId);
    }
    parsed.steps.push(stepOf(pd, ts));
  }

  parsed.seenMessageIds = null;
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

/** 扫描 projects 目录下所有会话文件 */
function listSessions(home) {
  const root = path.join(home, 'projects');
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return out;
  }
  for (const p of projects) {
    const pdir = path.join(root, p.name);
    let entries = [];
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ file: path.join(pdir, e.name), project: p.name, id: e.name.replace(/\.jsonl$/, '') });
      }
    }
  }
  return out;
}

/** 标题清洗：WorkBuddy 的 aiTitle 有时是「快速」这类占位词 */
function cleanTitle(t, fallback) {
  const s = String(t || '').trim();
  if (!s || s.length < 2) return fallback;
  return s.length > 46 ? `${s.slice(0, 46)}…` : s;
}

/**
 * 采集一次 WorkBuddy 用量快照。
 * @param {{home?:string}} options
 */
function collect(options = {}) {
  const home = options.home || process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
  const warnings = [];
  const exists = fs.existsSync(path.join(home, 'projects'));
  if (!exists) warnings.push(`未找到 WorkBuddy 会话目录：${path.join(home, 'projects')}`);

  const files = listSessions(home);
  const sessions = [];
  const modelMap = new Map(); // key -> aggregate
  const dayMap = new Map();
  const totals = {
    input: 0, uncachedInput: 0, cacheRead: 0, output: 0, reasoning: 0, credit: 0, requests: 0,
  };
  let missingUsage = 0;

  for (const f of files) {
    const parsed = parseSession(f.file);
    if (!parsed) continue;
    if (!parsed.steps.length) {
      missingUsage += 1;
      continue;
    }

    const sessModels = new Map();
    const sessTotals = {
      input: 0, uncachedInput: 0, cacheRead: 0, output: 0, reasoning: 0, credit: 0, requests: 0,
    };

    for (const st of parsed.steps) {
      const key = st.modelKey;
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          key, name: st.modelName, id: st.modelId, variants: new Map(),
          input: 0, uncachedInput: 0, cacheRead: 0, output: 0, reasoning: 0, credit: 0, requests: 0,
        });
      }
      const agg = modelMap.get(key);
      agg.variants.set(st.modelName, (agg.variants.get(st.modelName) || 0) + 1);
      agg.input += st.input;
      agg.uncachedInput += st.uncachedInput;
      agg.cacheRead += st.cacheRead;
      agg.output += st.output;
      agg.reasoning += st.reasoning;
      agg.credit += st.credit;
      agg.requests += 1;

      sessTotals.input += st.input;
      sessTotals.uncachedInput += st.uncachedInput;
      sessTotals.cacheRead += st.cacheRead;
      sessTotals.output += st.output;
      sessTotals.reasoning += st.reasoning;
      sessTotals.credit += st.credit;
      sessTotals.requests += 1;

      const sm = sessModels.get(key) || { key, name: st.modelName, requests: 0, total: 0 };
      sm.requests += 1;
      sm.total += st.input + st.output;
      sessModels.set(key, sm);

      const dk = dateKey(st.ts);
      if (dk) {
        if (!dayMap.has(dk)) {
          dayMap.set(dk, { date: dk, uncachedInput: 0, output: 0, cacheRead: 0, input: 0, requests: 0, sessions: new Set() });
        }
        const d = dayMap.get(dk);
        d.uncachedInput += st.uncachedInput;
        d.cacheRead += st.cacheRead;
        d.input += st.input;
        d.output += st.output;
        d.requests += 1;
        d.sessions.add(f.id);
      }
    }

    for (const k of Object.keys(totals)) totals[k] += sessTotals[k];

    const topModel = [...sessModels.values()].sort((a, b) => b.total - a.total)[0] || null;
    const fallback = `${f.project.replace(/^c-Users-\d+-/, '').replace(/-/g, ' ')}`;
    sessions.push({
      id: f.id,
      project: f.project,
      file: f.file,
      title: cleanTitle(parsed.title, cleanTitle(parsed.firstUserText, fallback)),
      cwd: parsed.cwd,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      model: topModel ? topModel.name : '—',
      models: [...sessModels.values()].sort((a, b) => b.total - a.total),
      totals: {
        uncachedInput: sessTotals.uncachedInput,
        cacheRead: sessTotals.cacheRead,
        output: sessTotals.output,
        cacheWrite: 0,
      },
      requests: sessTotals.requests,
      reasoning: sessTotals.reasoning,
      credit: sessTotals.credit,
    });
  }

  sessions.sort((a, b) => num(b.updatedAt) - num(a.updatedAt));

  const models = [...modelMap.values()].map((m) => {
    // 同一模型常有多种写法（Deepseek / DeepSeek），取出现次数最多的作为展示名
    const bestVariant = [...m.variants.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      key: m.key,
      name: bestVariant ? bestVariant[0] : m.name,
      id: m.id,
      aliases: [...m.variants.keys()],
      input: m.input,
      uncachedInput: m.uncachedInput,
      cacheRead: m.cacheRead,
      output: m.output,
      reasoning: m.reasoning,
      credit: m.credit,
      requests: m.requests,
      total: m.input + m.output,
      share: 0,
    };
  }).sort((a, b) => b.total - a.total);

  const grand = models.reduce((a, m) => a + m.total, 0) || 1;
  for (const m of models) m.share = Math.round((m.total / grand) * 1000) / 10;

  const daily = [...dayMap.values()].map((d) => ({
    date: d.date,
    input: d.input,
    uncachedInput: d.uncachedInput,
    cacheRead: d.cacheRead,
    output: d.output,
    total: d.uncachedInput + d.cacheRead + d.output,
    requests: d.requests,
    sessions: d.sessions.size,
  })).sort((a, b) => a.date.localeCompare(b.date));

  if (missingUsage) warnings.push(`${missingUsage} 个会话没有用量记录（仅有对话内容）`);

  totals.total = totals.uncachedInput + totals.cacheRead + totals.output;

  return {
    generatedAt: Date.now(),
    mode: 'workbuddy',
    source: {
      home,
      exists,
      projects: new Set(files.map((f) => f.project)).size,
      sessions: files.length,
      withUsage: sessions.length,
    },
    warnings,
    sessions,
    models,
    daily,
    totals,
  };
}

/** 清空解析缓存（--no-cache 或测试用） */
function clearCache() {
  fileCache.clear();
}

module.exports = { collect, clearCache, parseSession, listSessions };
