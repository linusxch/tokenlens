'use strict';

/**
 * TokenLens 采集器
 * ------------------------------------------------------------------
 * 从 DeepSeek Harness (dsh) 的本地运行目录读取 token 用量：
 *
 *   1) ~/.dsh/storages/session_projcache/sessions/session-*.json
 *      会话投影缓存（record.rows.*），含官方口径的 tokenUsage / contextBreakdown /
 *      contextPressure / sessionStats，是「准数」来源。
 *
 *   2) ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd
 *      追加写入的事件流。每一段 append 是独立的 zstd frame，必须逐帧解压
 *      （Node 的 zlib.zstdDecompressSync 只解第一帧，直接读会丢数据）。
 *      事件流用于：逐轮 usage、tool/call 与 tool/result、时间戳。
 *
 * 兼容策略：所有字段读取都走「多候选键名 + 缺省容错」，未知事件类型直接忽略。
 * 因此 harness 升级只要仍写 v4 事件流就不会崩，最坏情况是某些面板降级为空。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 老版本 Electron(Node < 22.15) 没有 zstd API，此时只能读投影缓存里的准数 */
const ZSTD_OK = typeof zlib.zstdDecompressSync === 'function';

/** 已知的连接器 / MCP 类工具指纹（工具名或 description 命中即视为连接器） */
const CONNECTOR_HINTS = [
  'mcp__', 'tencent-docs', 'docsmcp', 'tmeet', 'meeting', 'agent-mail', 'agentmail',
  'wecom', 'feishu', 'lark', 'dingtalk', 'notion', 'jirap', 'tapd', 'qichacha',
  'pkulaw', 'webdav', 'library_search', 'space-library', 'weixinpay', 'sheetagent',
  'cloudservice', 'google-drive', 'onedrive', 'slack', 'github_', 'gitlab_',
];

/** 子智能体 / 团队类工具指纹 */
const SUBAGENT_HINTS = [
  'agent', 'task', 'subagent', 'spawn', 'delegate', 'team_', 'colleague',
  'dispatch', 'workflow', 'parallel',
];

function uniq(arr) {
  return [...new Set(arr)];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 从一组可能的键名里取第一个有效数字 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of keys) {
    const n = Number(obj[k]);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* zstd 多帧解压                                                       */
/* ------------------------------------------------------------------ */

/**
 * 逐帧解压一个「追加写」的 .jsonl.zstd。
 * 帧之间以 zstd magic 分隔；用 magic 扫描 + 逐帧解压 + 失败兜底。
 */
function readZstdJsonl(file) {
  if (!ZSTD_OK) return [];
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return [];
  }
  const offsets = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const i = buf.indexOf(ZSTD_MAGIC, cursor);
    if (i === -1) break;
    offsets.push(i);
    cursor = i + 4;
  }
  if (!offsets.length) return [];

  let text = '';
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch (e) {
      /* 单帧损坏（例如最后一次写入未落盘）不影响其它帧 */
    }
  }

  const events = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev === 'object') events.push(ev);
    } catch (e) {
      /* 半行 / 截断行，跳过 */
    }
  }
  events.sort((a, b) => num(a.seq) - num(b.seq));
  return events;
}

/* ------------------------------------------------------------------ */
/* 文本 → token 估算（CJK 感知）                                       */
/* ------------------------------------------------------------------ */

/**
 * 粗略 token 估算：CJK 约 1.5 字符/token，拉丁字母约 4 字符/token。
 * 用于「工具 schema / 工具结果」这类官方没有给出 token 数的部分，
 * 所有使用该估算的数值在 UI 上都会标注为「估算」。
 */
function estimateTokens(input) {
  if (input == null) return 0;
  const text = typeof input === 'string' ? input : safeStringify(input);
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk / 1.5 + other / 3.5);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 工具 → 模块归类                                                     */
/* ------------------------------------------------------------------ */

function classifyTool(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'tools';
  if (CONNECTOR_HINTS.some((h) => n.includes(h))) return 'connector';
  // 带命名空间前缀的（plugin__tool）大多来自插件 / 连接器
  if (n.includes('__')) return 'connector';
  if (SUBAGENT_HINTS.some((h) => n.includes(h))) return 'subagent';
  return 'tools';
}

/* ------------------------------------------------------------------ */
/* 单会话事件流解析                                                    */
/* ------------------------------------------------------------------ */

function textOfMessage(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      return part.text || part.content || '';
    })
    .filter(Boolean)
    .join('\n');
}

function usageToBuckets(usage) {
  if (!usage) return null;
  const cacheRead = pick(usage, [
    'cacheReadTokens', 'cache_read_input_tokens', 'cachedInputTokens',
    'cacheRead', 'cachedTokens',
  ]);
  const input = pick(usage, [
    'uncachedInputTokens', 'inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens',
  ]);
  const output = pick(usage, ['outputTokens', 'completionTokens', 'output_tokens', 'completion_tokens']);
  const cacheWrite = pick(usage, ['cacheWriteTokens', 'cache_creation_input_tokens', 'cacheWrite']);
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  return {
    uncachedInput: input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/**
 * 把一次会话的事件流折叠成「轮次 + 模块归因 + 时间轴」。
 */
function reduceEvents(events) {
  const turns = new Map();
  const toolCalls = new Map();
  const meta = {
    id: null,
    cwd: null,
    createdAt: null,
    delegationDepth: 0,
    agentPreset: null,
    models: [],
    toolsSeen: new Set(),
  };
  const moduleAgg = {
    context: { schemaTokens: 0, resultTokens: 0, calls: 0 },
    connector: { schemaTokens: 0, resultTokens: 0, calls: 0 },
    subagent: { schemaTokens: 0, resultTokens: 0, calls: 0 },
    tools: { schemaTokens: 0, resultTokens: 0, calls: 0 },
  };
  let schemaSamples = 0;
  let lastTime = null;

  const ensureTurn = (turnNo, at) => {
    const key = num(turnNo) || 0;
    if (!turns.has(key)) {
      turns.set(key, {
        turn: key,
        startedAt: at || null,
        endedAt: null,
        uncachedInput: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        steps: 0,
        prompt: '',
        response: '',
        modules: {
          context: 0, connector: 0, subagent: 0, tools: 0,
        },
        toolCount: 0,
        subagentCount: 0,
        connectorCount: 0,
      });
    }
    return turns.get(key);
  };

  for (const ev of events) {
    const type = String(ev.type || '');
    const data = ev.data || {};
    const at = num(ev.time) || null;
    if (at) lastTime = at;

    switch (type) {
      case 'session':
        meta.id = ev.id || data.id || meta.id;
        meta.cwd = ev.cwd || data.cwd || meta.cwd;
        meta.createdAt = num(ev.createdAt) || meta.createdAt;
        meta.delegationDepth = num(ev.delegationDepth);
        meta.agentPreset = ev.agentPreset || meta.agentPreset;
        break;

      case 'model/selection': {
        const m = data.model ? `${data.provider || '?'}/${data.model}` : null;
        if (m && meta.models[meta.models.length - 1] !== m) meta.models.push(m);
        break;
      }

      case 'turn/start':
        ensureTurn(data.turn, at);
        break;

      case 'turn/end': {
        const t = ensureTurn(data.turn, at);
        t.endedAt = at;
        break;
      }

      case 'step/start': {
        const t = ensureTurn(data.turn, at);
        t.steps += 1;
        break;
      }

      case 'user/message': {
        const t = ensureTurn(data.turn ?? turns.size, at);
        const txt = textOfMessage(data);
        if (txt && !t.prompt) t.prompt = txt;
        if (txt) t.modules.context += estimateTokens(txt);
        break;
      }

      case 'assistant/message': {
        const t = ensureTurn(data.turn ?? turns.size, at);
        const txt = textOfMessage(data.message);
        if (txt) {
          t.response += txt;
          t.modules.context += estimateTokens(txt);
        }
        // 官方口径：assistant/message.data.usage 是逐 step 的真实用量，
        // 其累计值与 projcache 的 tokenUsage.totals 完全一致。
        const b = usageToBuckets(data.usage || data.message?.usage);
        if (b) {
          t.uncachedInput += b.uncachedInput;
          t.output += b.output;
          t.cacheRead += b.cacheRead;
          t.cacheWrite += b.cacheWrite;
          t.usageSteps = (t.usageSteps || 0) + 1;
        }
        break;
      }

      case 'assistant/attempt': {
        const t = ensureTurn(data.turn, at);
        const stream = Array.isArray(data.stream) ? data.stream : [];
        let last = null;
        for (const item of stream) {
          if (item && item.chunk && item.chunk.type === 'usage') {
            const b = usageToBuckets(item.chunk.usage);
            if (b) last = b;
          }
        }
        // 仅作为兜底：只有当该轮没有任何 assistant/message 用量时才采用
        if (last) {
          t._attempt = t._attempt || { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          t._attempt.uncachedInput += last.uncachedInput;
          t._attempt.output += last.output;
          t._attempt.cacheRead += last.cacheRead;
        }
        break;
      }

      case 'request/header': {
        const tools = data.header && Array.isArray(data.header.tools) ? data.header.tools : null;
        if (tools && tools.length) {
          // 只采样一次（首次完整请求头），避免重复计入
          if (schemaSamples === 0) {
            for (const tool of tools) {
              const name = tool && (tool.name || tool.function?.name);
              if (!name) continue;
              meta.toolsSeen.add(name);
              const module = classifyTool(name);
              const tokens = estimateTokens(tool) + 12; // 12 ≈ 结构开销
              moduleAgg[module].schemaTokens += tokens;
            }
          }
          schemaSamples += 1;
        }
        break;
      }

      case 'tool/call': {
        const t = ensureTurn(data.turn, at);
        const name = data.name || 'unknown';
        const module = classifyTool(name);
        t.toolCount += 1;
        if (module === 'connector') t.connectorCount += 1;
        if (module === 'subagent') t.subagentCount += 1;
        moduleAgg[module].calls += 1;
        toolCalls.set(data.callId || `${name}-${ev.seq}`, {
          callId: data.callId || null,
          name,
          module,
          at,
          tokens: 0,
          turn: num(data.turn),
        });
        break;
      }

      case 'tool/result': {
        const key = data.toolCallId || data.callId;
        const call = key ? toolCalls.get(key) : null;
        const tokens = estimateTokens(textOfMessage(data.message) || data.content);
        if (call) {
          call.tokens = tokens;
          moduleAgg[call.module].resultTokens += tokens;
          const t = ensureTurn(call.turn, call.at);
          t.modules[call.module] += tokens;
        } else {
          moduleAgg.tools.resultTokens += tokens;
        }
        break;
      }

      case 'developer/message': {
        // 工具注册等系统注入，计入上下文
        const cost = estimateTokens(textOfMessage(data.message));
        const t = ensureTurn(data.turn ?? turns.size, at);
        t.modules.context += cost;
        break;
      }

      default: {
        // 子智能体相关事件：尽量吸收到 subagent 模块
        if (type.startsWith('subagent')) {
          const t = ensureTurn(data.turn ?? turns.size, at);
          t.modules.subagent += 1;
          t.subagentCount += 1;
        }
        break;
      }
    }
  }

  const turnList = [...turns.values()].sort((a, b) => a.turn - b.turn);

  // 兜底：该轮没有 assistant/message 用量时，回落到 attempt 流里的 usage
  for (const t of turnList) {
    if (!t.uncachedInput && !t.output && t._attempt) {
      t.uncachedInput = t._attempt.uncachedInput;
      t.output = t._attempt.output;
      t.cacheRead = t._attempt.cacheRead;
      t.cacheWrite = t._attempt.cacheWrite;
    }
    delete t._attempt;
  }

  const calls = [...toolCalls.values()];
  return { meta, turns: turnList, toolCalls: calls, moduleAgg, lastTime };
}

/* ------------------------------------------------------------------ */
/* 会话投影缓存（准数）                                                */
/* ------------------------------------------------------------------ */

function readProjCache(home) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return out;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
      const record = doc.record || {};
      const rows = record.rows || {};
      const identity = record.identity || {};
      const id = (file.match(/session-([0-9a-f-]+)\.json/i) || [])[1] || file;
      const val = (k) => (rows[k] ? rows[k].val : undefined);
      const usage = val('tokenUsage') || {};
      const totals = usage.totals || {};
      out.set(id, {
        id,
        file: full,
        title: typeof val('title') === 'string' ? val('title') : null,
        cwd: identity.cwd || (val('workingDirectory') || {}).cwd || null,
        createdAt: num(identity.createdAt),
        formatVersion: num(identity.formatVersion),
        totals: {
          uncachedInput: pick(totals, ['uncachedInputTokens', 'inputTokens']),
          output: pick(totals, ['outputTokens']),
          cacheRead: pick(totals, ['cacheReadTokens']),
          cacheWrite: pick(totals, ['cacheWriteTokens']),
        },
        context: val('contextPressure') || null,
        breakdown: (val('contextBreakdown') || {}).breakdown || null,
        stats: val('sessionStats') || null,
        subagent: val('subagent') || null,
        model: (val('modelSelection') || {}).lastUsed || null,
        outline: val('turnOutline') || null,
      });
    } catch (e) {
      /* 缓存文件半写状态，忽略 */
    }
  }
  return out;
}

/** 会话事件目录：sessions/<projectSlug>/<session-id>/session.v4.jsonl.zstd */
function readSessionFiles(home) {
  const root = path.join(home, 'sessions');
  const map = new Map();
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return map;
  }
  for (const project of projects) {
    const pdir = path.join(root, project.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (e) {
      continue;
    }
    for (const s of sessions) {
      const sdir = path.join(pdir, s.name);
      let entries = [];
      try {
        entries = fs.readdirSync(sdir);
      } catch (e) {
        continue;
      }
      const zst = entries.find((f) => /\.jsonl\.zstd$/.test(f));
      if (!zst) continue;
      const id = s.name.replace(/^session-/, '');
      map.set(id, { id, dir: sdir, file: path.join(sdir, zst), project: project.name });
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Harness 环境信息                                                    */
/* ------------------------------------------------------------------ */

function readHarnessInfo(home) {
  const info = {
    home,
    desktopVersion: null,
    sessionFormat: null,
    profile: null,
    bundles: [],
    electronVersion: process.versions.electron || null,
    node: process.versions.node,
  };
  try {
    const rt = JSON.parse(fs.readFileSync(
      path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'), 'utf8'));
    info.desktopVersion = rt.desktopVersion || null;
  } catch (e) { /* 非标准安装 */ }

  for (const p of ['desktop', 'web']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(
        path.join(home, 'profiles', p, 'package.json'), 'utf8'));
      if (!info.profile) {
        info.profile = p;
        info.bundles = (pkg.dsh?.profile?.bundles || []).slice(0, 12);
      }
    } catch (e) { /* ignore */ }
  }

  // 会话格式版本：取任一事件流首行
  const files = readSessionFiles(home);
  for (const [, s] of files) {
    const ev = readZstdJsonl(s.file).find((e) => e.type === 'session');
    if (ev) {
      info.sessionFormat = ev.version || null;
      if (!info.desktopVersion && ev.harnessVersion) info.desktopVersion = ev.harnessVersion;
      break;
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                          */
/* ------------------------------------------------------------------ */

function dateKey(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 当事件流没有逐轮用量、但缓存在总量时，按上下文规模分摊到轮次（UI 标注为「分摊」） */
function allocateTotals(turns, totals) {
  if (!turns.length) return false;
  const hasReal = turns.some((t) => t.uncachedInput || t.output || t.cacheRead);
  if (hasReal) return false;
  if (!totals.uncachedInput && !totals.output && !totals.cacheRead) return false;
  const weights = turns.map((t) => Math.max(1, t.modules.context));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  turns.forEach((t, i) => {
    const w = weights[i] / wsum;
    t.uncachedInput = Math.round(totals.uncachedInput * w);
    t.output = Math.round(totals.output * w);
    t.cacheRead = Math.round(totals.cacheRead * w);
    t.allocated = true;
  });
  return true;
}

/**
 * 采集一次快照。
 * @param {{home?:string, days?:number}} options
 */
function collect(options = {}) {
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const warnings = [];
  const harness = readHarnessInfo(home);
  const cacheMap = readProjCache(home);
  const fileMap = readSessionFiles(home);

  if (!fs.existsSync(home)) warnings.push(`未找到 harness 目录：${home}`);
  if (!ZSTD_OK) warnings.push(`当前运行时 Node ${process.versions.node} 不支持 zstd，仅显示会话准数（逐轮与日统计不可用）`);

  const sessions = [];
  const ids = uniq([...fileMap.keys(), ...cacheMap.keys()]);

  for (const id of ids) {
    const cache = cacheMap.get(id) || null;
    const file = fileMap.get(id) || null;
    const events = file ? readZstdJsonl(file.file) : [];
    const reduced = events.length ? reduceEvents(events) : null;

    const totals = cache?.totals || {
      uncachedInput: reduced ? reduced.turns.reduce((a, t) => a + t.uncachedInput, 0) : 0,
      output: reduced ? reduced.turns.reduce((a, t) => a + t.output, 0) : 0,
      cacheRead: reduced ? reduced.turns.reduce((a, t) => a + t.cacheRead, 0) : 0,
      cacheWrite: reduced ? reduced.turns.reduce((a, t) => a + t.cacheWrite, 0) : 0,
    };

    const turns = reduced?.turns || [];
    const allocated = allocateTotals(turns, totals);
    const moduleAgg = reduced?.moduleAgg || {
      context: { schemaTokens: 0, resultTokens: 0, calls: 0 },
      connector: { schemaTokens: 0, resultTokens: 0, calls: 0 },
      subagent: { schemaTokens: 0, resultTokens: 0, calls: 0 },
      tools: { schemaTokens: 0, resultTokens: 0, calls: 0 },
    };

    const breakdown = cache?.breakdown || null;
    const contextTokens = breakdown
      ? num(breakdown.systemTokens) + num(breakdown.messageTokens)
      : turns.reduce((a, t) => a + t.modules.context, 0);

    /**
     * 归因规则：
     *  - 工具 schema 是真实的上下文占用，但只有在「该模块真的有调用」时才计入该模块；
     *    没被调用的 schema 一律回到上下文桶，避免出现「子智能体 3000 tokens 但一次都没用」。
     *  - 连接器 / 子智能体 / 工具执行 的数值 = 该模块 schema（有调用时）+ 工具结果 token（估算）。
     */
    const schemaTotal = ['context', 'connector', 'subagent', 'tools']
      .reduce((a, k) => a + num(moduleAgg[k].schemaTokens), 0);
    let schemaAttributed = 0;
    const tokensOf = (key) => {
      const agg = moduleAgg[key];
      const useSchema = num(agg.calls) > 0 ? num(agg.schemaTokens) : 0;
      schemaAttributed += useSchema;
      return useSchema + num(agg.resultTokens);
    };

    const modules = {
      context: { key: 'context', label: '上下文', tokens: 0, schemaTokens: 0, resultTokens: 0, calls: 0, estimated: !breakdown },
      connector: { key: 'connector', label: '连接器', tokens: tokensOf('connector'), schemaTokens: moduleAgg.connector.schemaTokens, resultTokens: moduleAgg.connector.resultTokens, calls: moduleAgg.connector.calls, estimated: true },
      subagent: { key: 'subagent', label: '子智能体', tokens: tokensOf('subagent'), schemaTokens: moduleAgg.subagent.schemaTokens, resultTokens: moduleAgg.subagent.resultTokens, calls: moduleAgg.subagent.calls, estimated: true },
      tools: { key: 'tools', label: '工具执行', tokens: tokensOf('tools'), schemaTokens: moduleAgg.tools.schemaTokens, resultTokens: moduleAgg.tools.resultTokens, calls: moduleAgg.tools.calls, estimated: true },
    };
    // 未被调用的工具 schema + 系统提示 + 消息正文，共同构成「上下文」
    modules.context.tokens = contextTokens + (schemaTotal - schemaAttributed);
    modules.context.resultTokens = modules.context.tokens;
    modules.context.schemaTokens = schemaTotal - schemaAttributed;
    modules.context.calls = turns.length;

    const contextWindow = num(cache?.context?.contextWindow) || 0;
    const surfaceTokens = num(cache?.context?.surfaceTokens) || num(breakdown?.surfaceTokens);

    const lastTurn = turns.length ? turns[turns.length - 1] : null;

    sessions.push({
      id,
      title: cache?.title || `会话 ${id.slice(0, 8)}`,
      cwd: cache?.cwd || reduced?.meta.cwd || null,
      createdAt: cache?.createdAt || reduced?.meta.createdAt || null,
      updatedAt: reduced?.lastTime || cache?.createdAt || null,
      delegationDepth: reduced?.meta.delegationDepth || 0,
      agentPreset: reduced?.meta.agentPreset || null,
      model: cache?.model
        ? `${cache.model.provider || ''}/${cache.model.model || ''}`.replace(/^\//, '')
        : (reduced?.meta.models.slice(-1)[0] || null),
      totals,
      turns: turns.map((t) => ({
        turn: t.turn,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        uncachedInput: t.uncachedInput,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        steps: t.steps,
        toolCount: t.toolCount,
        subagentCount: t.subagentCount,
        connectorCount: t.connectorCount,
        modules: t.modules,
        prompt: (t.prompt || '').slice(0, 240),
      })),
      modules,
      context: {
        surfaceTokens,
        contextWindow,
        pressureTokens: num(cache?.context?.pressureTokens),
        systemTokens: num(breakdown?.systemTokens),
        toolsTokens: num(breakdown?.toolsTokens),
        messageTokens: num(breakdown?.messageTokens),
      },
      stats: cache?.stats || null,
      toolCalls: (reduced?.toolCalls || []).slice(-80),
      toolsSeen: [...(reduced?.meta.toolsSeen || [])],
      allocated,
      hasEvents: events.length > 0,
    });
  }

  sessions.sort((a, b) => num(b.updatedAt) - num(a.updatedAt));

  // ---- 每日统计：按轮次结束时间归日 ----
  const dayMap = new Map();
  for (const s of sessions) {
    for (const t of s.turns) {
      const key = dateKey(t.endedAt || t.startedAt || s.createdAt);
      if (!key) continue;
      if (!dayMap.has(key)) {
        dayMap.set(key, { date: key, uncachedInput: 0, output: 0, cacheRead: 0, turns: 0, sessions: new Set() });
      }
      const d = dayMap.get(key);
      d.uncachedInput += t.uncachedInput;
      d.output += t.output;
      d.cacheRead += t.cacheRead;
      d.turns += 1;
      d.sessions.add(s.id);
    }
  }
  const daily = [...dayMap.values()]
    .map((d) => ({
      date: d.date,
      uncachedInput: d.uncachedInput,
      output: d.output,
      cacheRead: d.cacheRead,
      total: d.uncachedInput + d.output + d.cacheRead,
      turns: d.turns,
      sessions: d.sessions.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sum = (k) => sessions.reduce((a, s) => a + num(s.totals[k]), 0);
  const allTotals = {
    uncachedInput: sum('uncachedInput'),
    output: sum('output'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
  };
  allTotals.total = allTotals.uncachedInput + allTotals.output + allTotals.cacheRead + allTotals.cacheWrite;

  return {
    generatedAt: Date.now(),
    source: {
      home,
      exists: fs.existsSync(home),
      cachedSessions: cacheMap.size,
      eventSessions: fileMap.size,
    },
    harness,
    sessions,
    daily,
    totals: allTotals,
    warnings,
  };
}

module.exports = {
  collect,
  readZstdJsonl,
  readProjCache,
  readSessionFiles,
  estimateTokens,
  classifyTool,
  dateKey,
};
