/* ------------------------------------------------------------------
   TokenLens 渲染层
   两种数据源、一套 UI：
     · Harness   —— 上下文/连接器/子智能体模块归因、逐轮上下行
     · WorkBuddy —— 按模型聚合、请求画像、会话明细
   同一份代码同时服务 Electron 浮窗（window.tl 由 preload 注入）
   与浏览器/面板模式（回落到 /api/snapshot）。
------------------------------------------------------------------- */

const state = {
  payload: null,
  sessionId: null,
  source: 'harness', // harness | workbuddy | demo
  refreshMs: 5000,
  timer: null,
  compact: false,
  alwaysOnTop: true,
  loading: false,
};

const el = (id) => document.getElementById(id);

/* ---------------- 数字格式 ---------------- */
function fmt(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  if (abs < 1e6) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (abs < 1e9) {
    const m = v / 1e6;
    return `${m >= 100 ? Math.round(m) : m.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  return `${(v / 1e9).toFixed(2)}B`;
}

function fmtFull(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

function fmtPct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  return `${n.toFixed(digits).replace(/\.0$/, '')}%`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MODULE_COLOR = {
  context: 'var(--c-context)',
  connector: 'var(--c-connector)',
  subagent: 'var(--c-subagent)',
  tools: 'var(--c-tools)',
};

/* ---------------- 数据获取 ---------------- */
async function fetchSnapshot() {
  const payloadReq = { source: state.source, sessionId: state.sessionId };
  if (window.tl && window.tl.snapshot) return window.tl.snapshot(payloadReq);
  const qs = new URLSearchParams({ source: state.source });
  if (state.sessionId) qs.set('session', state.sessionId);
  const res = await fetch(`/api/snapshot?${qs.toString()}`);
  return res.json();
}

function schedule() {
  if (state.timer) clearInterval(state.timer);
  if (!state.refreshMs) return;
  state.timer = setInterval(load, state.refreshMs);
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  try {
    const payload = await fetchSnapshot();
    state.payload = payload;
    if (payload.mode !== 'workbuddy' && payload.activeId && payload.activeId !== state.sessionId) {
      state.sessionId = payload.activeId;
    }
    render(payload);
  } catch (err) {
    el('footMeta').textContent = '读取失败';
    console.error(err);
  } finally {
    state.loading = false;
  }
}

/* ---------------- 顶层渲染 ---------------- */
function render(p) {
  if (!p || !p.ok) {
    if (p && p.mode === 'workbuddy') {
      el('wbModelList').innerHTML = `<div class="turn-empty">${escapeHtml(p.error || '暂无 WorkBuddy 数据')}</div>`;
      el('footMeta').textContent = '读取失败';
    }
    return;
  }

  const isWb = p.mode === 'workbuddy';
  el('hmBody').classList.toggle('hidden', isWb || state.compact);
  el('wbBody').classList.toggle('hidden', !isWb || state.compact);

  if (isWb) renderWorkbuddy(p);
  else renderHarness(p);

  const todayTotal = p.summary?.today?.total || 0;
  el('compactValue').textContent = fmt(todayTotal);
  el('compactSub').textContent = isWb
    ? `WorkBuddy 今日 · ${p.summary.requests || 0} 次请求`
    : `今日 · 缓存命中 ${fmtPct(p.summary?.cacheHitRate, 0)}`;

  el('sourceLine').textContent = p.demo
    ? '示例数据'
    : (p.source && p.source.home) || '—';
}

/* ================= Harness ================= */
function renderHarness(p) {
  const hasData = p.active && (p.active.turns.length || p.active.moduleTotal > 0);
  el('emptyState').classList.toggle('hidden', !!hasData || !!p.demo);

  const hv = p.harness || {};
  el('harnessTag').textContent = hv.desktopVersion ? `harness ${hv.desktopVersion}` : 'harness 未检出';
  el('harnessTag').title = `${hv.home || ''}\nsession 格式 v${hv.sessionFormat || '?'}\nprofile: ${hv.profile || '—'}`;

  renderHero(p);
  renderModules(p.active);
  renderContext(p.active);
  renderTurns(p.active);
  renderDaily(p.daily || [], { chart: 'dailyChart', chip: 'dailyChip', stats: 'dailyStats' });
  renderFooter(p);
}

function renderHero(p) {
  const s = p.summary;
  el('todayTotal').textContent = fmt(s.today.total);
  el('todayTotal').title = `${fmtFull(s.today.total)} tokens`;

  const delta = el('todayDelta');
  if (s.deltaPct == null) {
    const active = p.active;
    if (s.today.total === 0 && active && active.totalTokens > 0) {
      delta.innerHTML = `本会话 <b>${fmt(active.totalTokens)}</b> · ${active.turns.length} 轮`;
    } else {
      delta.innerHTML = `输入 ${fmt(s.today.uncachedInput)} · 输出 ${fmt(s.today.output)}`;
    }
  } else {
    const positive = s.deltaPct >= 0;
    const cls = positive ? 'up' : 'down';
    const arrow = positive ? '▲' : '▼';
    delta.innerHTML = `<span class="${cls}">${arrow} ${fmtPct(Math.abs(s.deltaPct), 0)}</span> 较昨日 · 输入 ${fmt(s.today.uncachedInput)}`;
  }
  el('cacheRate').textContent = fmtPct(s.cacheHitRate, 0);
  el('weekTotal').textContent = fmt(s.weekTotal);
  el('weekTotal').title = `近 7 日合计 ${fmtFull(s.weekTotal)}，日均 ${fmtFull(s.weekAvg)}`;
}

function renderModules(active) {
  const list = el('moduleList');
  list.innerHTML = '';
  if (!active) return;

  const total = active.moduleTotal || 1;
  el('moduleTotalChip').textContent = `合计 ${fmt(active.moduleTotal)}`;

  for (const m of active.modules) {
    const row = document.createElement('div');
    row.className = `module-row${m.tokens ? '' : ' is-empty'}`;
    const width = Math.max(m.tokens / total * 100, m.tokens ? 1.5 : 0);
    row.innerHTML = `
      <div class="module-name"><i style="background:${MODULE_COLOR[m.key] || 'var(--text-3)'}"></i>${escapeHtml(m.label)}</div>
      <div class="module-track"><div class="module-bar" style="background-color:${MODULE_COLOR[m.key]}"></div></div>
      <div class="module-val">${m.tokens ? fmt(m.tokens) : '—'}<small>${m.tokens ? fmtPct(m.pct, 0) : ''}</small></div>
    `;
    list.appendChild(row);
    requestAnimationFrame(() => {
      const bar = row.querySelector('.module-bar');
      if (bar) bar.style.width = `${width}%`;
    });
    if (m.tokens) {
      row.addEventListener('mouseenter', (e) => showTip(
        e,
        `${m.label}　${fmt(m.tokens)} tokens（${fmtPct(m.pct)}）\n`
        + `schema 占用 ${fmt(m.schemaTokens)} · 结果 ${fmt(m.resultTokens)}\n`
        + `调用 ${m.calls} 次${m.estimated ? '\n※ 该模块为归因估算值' : ''}`,
      ));
      row.addEventListener('mouseleave', hideTip);
    }
  }

  const legend = el('moduleLegend');
  const estimated = active.modules.some((m) => m.estimated && m.tokens > 0);
  legend.innerHTML = '<span>上下文含系统提示与消息正文</span>'
    + `<span>共 ${active.stats.turns} 轮 · ${active.stats.toolCalls} 次工具调用</span>`
    + (estimated ? '<span>※ 连接器/子智能体为归因估算</span>' : '');
}

function renderContext(active) {
  if (!active) return;
  const c = active.context;
  const usedPct = Math.min(c.usedPct || 0, 100);
  el('ctxChip').textContent = c.contextWindow
    ? `${fmt(c.surfaceTokens)} / ${fmt(c.contextWindow)}`
    : `${fmt(c.surfaceTokens)} tokens`;
  el('ctxChip').title = c.contextWindow
    ? `上下文窗口占用 ${fmtPct(c.usedPct, 2)}`
    : '未检测到上下文窗口大小';
  requestAnimationFrame(() => {
    el('gaugeFill').style.width = `${Math.max(usedPct, c.surfaceTokens ? 1.2 : 0)}%`;
  });

  const parts = [
    ['系统提示', c.systemTokens],
    ['工具定义', c.toolsTokens],
    ['消息正文', c.messageTokens],
  ].filter((x) => x[1] > 0);
  el('ctxSplit').innerHTML = parts.length
    ? parts.map(([k, v]) => `<span>${k} <b>${fmt(v)}</b></span>`).join('')
    : '<span>暂无上下文细分</span>';
}

function renderTurns(active) {
  const box = el('turnList');
  box.innerHTML = '';
  if (!active || !active.turns.length) {
    box.innerHTML = '<div class="turn-empty">该会话暂无轮次记录</div>';
    return;
  }

  // 上下行共用一条平方根标尺：既保留量级差异，又让小数值（输出通常只有输入的几十分之一）可见
  const sharedMax = Math.max(...active.turns.map((t) => Math.max(t.up, t.down)), 1);
  const scale = (v) => (v > 0 ? Math.sqrt(v / sharedMax) * 100 : 0);

  for (const t of active.turns) {
    const row = document.createElement('div');
    row.className = 'turn';
    row.innerHTML = `
      <div class="turn-id">${escapeHtml(t.label)}</div>
      <div class="turn-bars">
        <div class="turn-line">
          <div class="turn-track"><div class="turn-bar up"></div></div>
          <div class="turn-num up">${t.up ? fmt(t.up) : '—'}</div>
        </div>
        <div class="turn-line">
          <div class="turn-track"><div class="turn-bar down"></div></div>
          <div class="turn-num down">${t.down ? fmt(t.down) : '—'}</div>
        </div>
      </div>
    `;
    box.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector('.turn-bar.up').style.width = `${Math.max(scale(t.up), t.up ? 2 : 0)}%`;
      row.querySelector('.turn-bar.down').style.width = `${Math.max(scale(t.down), t.down ? 2 : 0)}%`;
    });

    const tip = [
      `第 ${t.turn} 轮${t.prompt ? `　${t.prompt.slice(0, 60)}` : ''}`,
      `上行输入 ${fmtFull(t.up)}（未缓存 ${fmtFull(t.uncachedInput)} · 缓存 ${fmtFull(t.cacheRead)}）`,
      `下行输出 ${fmtFull(t.down)}`,
      `步骤 ${t.steps} · 工具 ${t.toolCount} · 连接器 ${t.connectorCount} · 子智能体 ${t.subagentCount}`,
      t.durationMs ? `耗时 ${Math.round(t.durationMs / 1000)}s` : '',
      t.allocated ? '※ 该轮为总量分摊结果' : '',
      '（上下行共用平方根标尺）',
    ].filter(Boolean).join('\n');
    row.addEventListener('mouseenter', (e) => showTip(e, tip));
    row.addEventListener('mouseleave', hideTip);
  }
}

/* ================= WorkBuddy ================= */
function renderWorkbuddy(p) {
  const s = p.summary || {};
  const hasData = (p.models && p.models.length) || (p.sessions && p.sessions.length);
  el('emptyState').classList.toggle('hidden', !!hasData);
  el('emptyBody').textContent = '在 WorkBuddy 里跑一个任务，这里会出现按模型拆分的用量。';

  el('harnessTag').textContent = `WorkBuddy · ${p.summary.models || 0} 模型`;
  el('harnessTag').title = `${p.source?.home || ''}\n会话 ${p.source?.sessions || 0} 个 · 请求 ${p.summary.requests || 0} 次`
    + '\n数据来自 ~/.workbuddy/projects/*/*.jsonl';

  // Hero
  el('wbToday').textContent = fmt(s.today?.total);
  el('wbToday').title = `${fmtFull(s.today?.total)} tokens`;
  const sub = el('wbTodaySub');
  if (s.deltaPct != null) {
    const up = s.deltaPct >= 0;
    sub.innerHTML = `<span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmtPct(Math.abs(s.deltaPct), 0)}</span> 较昨日 · ${s.today.requests || 0} 次请求`;
  } else {
    sub.innerHTML = `${s.today?.requests || 0} 次请求 · 输出 ${fmt(s.today?.output)}`;
  }
  el('wbCache').textContent = fmtPct(s.cacheHitRate, 0);
  el('wbWeek').textContent = fmt(s.weekTotal || 0);
  el('wbWeek').title = `近 7 日合计 ${fmtFull(s.weekTotal)}，日均 ${fmtFull(s.weekAvg)}`;

  // 模型分布
  const list = el('wbModelList');
  list.innerHTML = '';
  const models = p.models || [];
  const total = models.reduce((a, m) => a + m.total, 0) || 1;
  el('wbModelChip').textContent = `${models.length} 个模型`;

  if (!models.length) {
    list.innerHTML = '<div class="turn-empty">暂无模型调用记录</div>';
  }

  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'module-row';
    row.innerHTML = `
      <div class="module-name" title="${escapeHtml(m.name)}"><i style="background:${m.color}"></i>${escapeHtml(m.short || m.name)}</div>
      <div class="module-track"><div class="module-bar" style="background-color:${m.color}"></div></div>
      <div class="module-val">${fmt(m.total)}<small>${fmtPct(m.share, 0)}</small></div>
    `;
    list.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector('.module-bar').style.width = `${Math.max(m.share, m.total ? 1.5 : 0)}%`;
    });
    row.addEventListener('mouseenter', (e) => showTip(
      e,
      `${m.name}\n`
      + `合计 ${fmtFull(m.total)}（占比 ${fmtPct(m.share)}）\n`
      + `未缓存输入 ${fmtFull(m.uncachedInput)} · 缓存命中 ${fmtFull(m.cacheRead)}\n`
      + `输出 ${fmtFull(m.output)}${m.reasoning ? `（其中推理 ${fmtFull(m.reasoning)}）` : ''}\n`
      + `请求 ${m.requests} 次 · 平均每次 ${fmtFull(m.avgPerRequest)}\n`
      + `缓存命中率 ${fmtPct(m.cacheHitRate)}`
      + (m.aliases && m.aliases.length > 1 ? `\n合并写法：${m.aliases.join(' / ')}` : ''),
    ));
    row.addEventListener('mouseleave', hideTip);
  }

  el('wbModelLegend').innerHTML = models.length
    ? `<span>按 输入+输出 排序</span><span>共 ${fmtFull(total)} tokens</span><span>${s.requests || 0} 次请求</span>`
    : '';

  // 请求画像
  el('wbReqChip').textContent = `${s.requests || 0} 次请求`;
  const hit = Math.min(s.cacheHitRate || 0, 100);
  requestAnimationFrame(() => {
    el('wbGauge').style.width = `${Math.max(hit, 1.2)}%`;
  });
  el('wbMetrics').innerHTML = [
    `<span>缓存命中 <b>${fmtPct(s.cacheHitRate, 1)}</b></span>`,
    `<span>平均每次 <b>${fmt(s.avgPerRequest)}</b></span>`,
    `<span>推理输出 <b>${fmt(s.reasoning)}</b></span>`,
    s.credits ? `<span>平台计量 <b>${s.credits.toFixed(2)}</b></span>` : '',
  ].filter(Boolean).join('');

  // 会话列表
  const box = el('wbSessionList');
  box.innerHTML = '';
  const sessions = p.sessions || [];
  el('wbSessionChip').textContent = `${sessions.length} 个会话`;
  const maxSess = Math.max(...sessions.map((x) => x.totalTokens), 1);

  if (!sessions.length) {
    box.innerHTML = '<div class="turn-empty">暂无会话</div>';
  }

  for (const sess of sessions) {
    const row = document.createElement('div');
    row.className = 'sess';
    const model0 = (sess.models && sess.models[0]) || null;
    const color = model0 ? colorOfModel(p.models, model0.key) : 'var(--text-3)';
    row.innerHTML = `
      <div class="sess-main">
        <div class="sess-title">${escapeHtml(sess.title)}</div>
        <div class="sess-meta">
          <i class="sess-dot" style="background:${color}"></i>${escapeHtml(sess.model)}
          <span>·</span>${sess.requests} 请求
          <span>·</span>${fmtTime(sess.updatedAt)}
        </div>
      </div>
      <div class="sess-val">${fmt(sess.totalTokens)}</div>
    `;
    row.style.setProperty('--w', `${Math.max((sess.totalTokens / maxSess) * 100, sess.totalTokens ? 3 : 0)}%`);
    box.appendChild(row);
    requestAnimationFrame(() => row.classList.add('show'));
    row.addEventListener('mouseenter', (e) => showTip(
      e,
      `${sess.title}\n`
      + `合计 ${fmtFull(sess.totalTokens)} tokens · ${sess.requests} 次请求\n`
      + `未缓存 ${fmtFull(sess.totals?.uncachedInput)} · 缓存 ${fmtFull(sess.totals?.cacheRead)} · 输出 ${fmtFull(sess.totals?.output)}\n`
      + (sess.models || []).map((m) => `${m.name}：${m.requests} 次 / ${fmtFull(m.total)}`).join('\n'),
    ));
    row.addEventListener('mouseleave', hideTip);
  }

  renderDaily(p.daily || [], {
    chart: 'wbDailyChart', chip: 'wbDailyChip', stats: 'wbDailyStats', unit: 'requests',
  });

  // WorkBuddy 视图为全局聚合，不做单会话切换
  el('sessionSelect').style.display = 'none';
  el('footMeta').textContent = `${sessions.length} 会话 · ${s.requests || 0} 请求 · ${models.length} 模型`;
}

function colorOfModel(models, key) {
  const hit = (models || []).find((m) => m.key === key);
  return hit ? hit.color : 'var(--text-3)';
}

/* ================= 每日图表（两种数据源共用） ================= */
function renderDaily(daily, ids) {
  const box = el(ids.chart);
  if (!box) return;
  box.innerHTML = '';
  if (!daily.length) return;
  const max = Math.max(...daily.map((d) => d.total), 1);
  const today = daily[daily.length - 1];

  for (const d of daily) {
    const wrap = document.createElement('div');
    wrap.className = `day${d.isToday ? ' today' : ''}${d.total === 0 ? ' dim' : ''}`;
    const hInput = d.uncachedInput / max * 100;
    const hOutput = d.output / max * 100;
    const hCache = d.cacheRead / max * 100;
    wrap.innerHTML = `
      <div class="day-stack">
        <div class="day-seg output" style="height:0"></div>
        <div class="day-seg input" style="height:0"></div>
        <div class="day-seg cache" style="height:0"></div>
      </div>
      <div class="day-label">${d.isToday ? '今天' : d.label}</div>
    `;
    box.appendChild(wrap);
    requestAnimationFrame(() => {
      const seg = wrap.querySelectorAll('.day-seg');
      seg[0].style.height = `${hOutput}%`;
      seg[1].style.height = `${hInput}%`;
      seg[2].style.height = `${hCache}%`;
    });
    const req = ids.unit === 'requests' ? d.requests : d.turns;
    wrap.addEventListener('mouseenter', (e) => showTip(
      e,
      `${d.date}${d.isToday ? '（今天）' : ''}\n`
      + `合计 ${fmtFull(d.total)} tokens\n`
      + `未缓存输入 ${fmtFull(d.uncachedInput)}\n`
      + `输出 ${fmtFull(d.output)}\n`
      + `缓存命中 ${fmtFull(d.cacheRead)}\n`
      + `${req || 0} ${ids.unit === 'requests' ? '次请求' : '轮'} · ${d.sessions || 0} 个会话`,
    ));
    wrap.addEventListener('mouseleave', hideTip);
  }

  const chip = el(ids.chip);
  if (chip) chip.textContent = `${daily.length} 天 · 今日 ${fmt(today.total)}`;

  const sum = daily.reduce((a, d) => a + d.total, 0);
  const activeDays = daily.filter((d) => d.total > 0).length || 1;
  const peak = daily.reduce((m, d) => (d.total > m.total ? d : m), daily[0]);
  const stats = el(ids.stats);
  if (stats) {
    stats.innerHTML = `
      <div class="ds-item"><span class="ds-label">${daily.length} 天合计</span><span class="ds-value">${fmt(sum)}</span></div>
      <div class="ds-item"><span class="ds-label">日均（按活跃天）</span><span class="ds-value">${fmt(Math.round(sum / activeDays))}</span></div>
      <div class="ds-item"><span class="ds-label">峰值</span><span class="ds-value">${fmt(peak.total)}<small>${peak.isToday ? '今天' : peak.label}</small></span></div>
    `;
  }
}

/* ---------------- 底部栏 ---------------- */
function renderFooter(p) {
  const sel = el('sessionSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  sel.style.display = p.sessions.length ? '' : 'none';
  for (const s of p.sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const t = (s.totals.uncachedInput || 0) + (s.totals.output || 0) + (s.totals.cacheRead || 0);
    opt.textContent = `${s.title.slice(0, 26)} · ${fmt(t)}`;
    sel.appendChild(opt);
  }
  if (p.activeId) sel.value = p.activeId;
  else if (prev) sel.value = prev;

  const active = p.active;
  el('footMeta').textContent = active
    ? `${fmtTime(active.updatedAt)} · ${active.model || '未知模型'}`
    : `${p.sessions.length} 个会话`;
}

/* ---------------- 提示框 ---------------- */
function showTip(evt, text) {
  const tip = el('tooltip');
  tip.textContent = text;
  tip.classList.remove('hidden');
  const pad = 10;
  const rect = tip.getBoundingClientRect();
  let x = evt.clientX + 12;
  let y = evt.clientY + 12;
  if (x + rect.width + pad > window.innerWidth) x = window.innerWidth - rect.width - pad;
  if (y + rect.height + pad > window.innerHeight) y = evt.clientY - rect.height - 10;
  tip.style.left = `${Math.max(pad, x)}px`;
  tip.style.top = `${Math.max(pad, y)}px`;
}

function hideTip() {
  el('tooltip').classList.add('hidden');
}

/* ---------------- 交互 ---------------- */
function setSeg(group, active) {
  [...group.children].forEach((b) => b.classList.toggle('on', b === active));
}

function bindUI() {
  el('btnRefresh').addEventListener('click', async () => {
    const btn = el('btnRefresh');
    btn.classList.add('spin');
    setTimeout(() => btn.classList.remove('spin'), 700);
    await load();
  });

  el('btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    el('moreMenu').classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    const menu = el('moreMenu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) menu.classList.add('hidden');
  });

  el('btnCollapse').addEventListener('click', () => setCompact(true));
  el('btnExpand').addEventListener('click', () => setCompact(false));
  el('btnClose').addEventListener('click', () => {
    if (window.tl && window.tl.closeWindow) window.tl.closeWindow();
    else window.close();
  });

  el('segSource').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setSeg(el('segSource'), btn);
    state.source = btn.dataset.source;
    if (window.tl && window.tl.setSource) window.tl.setSource(state.source);
    load();
  });

  el('segRefresh').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setSeg(el('segRefresh'), btn);
    state.refreshMs = Number(btn.dataset.ms);
    if (window.tl && window.tl.savePrefs) window.tl.savePrefs({ refreshMs: state.refreshMs });
    schedule();
    if (state.refreshMs) load();
  });

  el('segPin').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setSeg(el('segPin'), btn);
    state.alwaysOnTop = btn.dataset.pin === '1';
    if (window.tl && window.tl.setAlwaysOnTop) window.tl.setAlwaysOnTop(state.alwaysOnTop);
  });

  el('btnOpenHome').addEventListener('click', () => {
    const p = state.payload;
    if (!p || !p.source || !p.source.home) return;
    if (window.tl && window.tl.openPath) window.tl.openPath(p.source.home);
  });

  el('sessionSelect').addEventListener('change', (e) => {
    state.sessionId = e.target.value;
    if (window.tl && window.tl.savePrefs) window.tl.savePrefs({ sessionId: state.sessionId });
    load();
  });

  el('btnDemo').addEventListener('click', () => {
    state.source = 'demo';
    [...el('segSource').children].forEach((b) => b.classList.toggle('on', b.dataset.source === 'demo'));
    load();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el('moreMenu').classList.add('hidden');
      if (state.compact) setCompact(false);
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      load();
    }
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey)) {
      // 快速切换数据源
      e.preventDefault();
      const order = ['harness', 'workbuddy', 'demo'];
      state.source = order[(order.indexOf(state.source) + 1) % order.length];
      [...el('segSource').children].forEach((b) => b.classList.toggle('on', b.dataset.source === state.source));
      if (window.tl && window.tl.setSource) window.tl.setSource(state.source);
      load();
    }
  });
}

async function setCompact(flag) {
  state.compact = !!flag;
  document.getElementById('app').classList.toggle('compact-mode', state.compact);
  el('hmBody').classList.toggle('hidden', state.compact || state.source === 'workbuddy');
  el('wbBody').classList.toggle('hidden', state.compact || state.source !== 'workbuddy');
  el('compactBar').classList.toggle('hidden', !state.compact);
  el('btnCollapse').classList.toggle('hidden', state.compact);
  if (window.tl && window.tl.setCompact) window.tl.setCompact(state.compact);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bindUI();

  if (window.tl && window.tl.getPrefs) {
    try {
      const prefs = await window.tl.getPrefs();
      if (prefs) {
        if (prefs.sessionId) state.sessionId = prefs.sessionId;
        if (prefs.source) state.source = prefs.source;
        if (typeof prefs.refreshMs === 'number') state.refreshMs = prefs.refreshMs;
        if (typeof prefs.alwaysOnTop === 'boolean') state.alwaysOnTop = prefs.alwaysOnTop;
        if (prefs.theme) document.body.dataset.theme = prefs.theme;
      }
    } catch (e) { /* 首次启动 */ }

    [...el('segSource').children].forEach((b) => {
      b.classList.toggle('on', b.dataset.source === state.source);
    });
    [...el('segRefresh').children].forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.ms) === state.refreshMs);
    });
    [...el('segPin').children].forEach((b) => {
      b.classList.toggle('on', (b.dataset.pin === '1') === state.alwaysOnTop);
    });

    if (window.tl.onSourceChanged) {
      window.tl.onSourceChanged((source) => {
        if (!source || source === state.source) return;
        state.source = source;
        [...el('segSource').children].forEach((b) => {
          b.classList.toggle('on', b.dataset.source === source);
        });
        load();
      });
    }
  } else {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.body.dataset.theme = 'dark';
    }
    el('btnClose').classList.add('hidden');
  }

  await load();
  schedule();
}

boot();
