'use strict';

/**
 * 历史库：把每日用量持久化到本地，保证「日统计条形图」跨天累积。
 *
 * 设计要点：
 *  - 事件流只保留在 harness 目录里，用户清理会话后就没了；历史库是独立副本。
 *  - 每天的数值按字段取「较大值」合并（用量只增不减），因此重复采集不会翻倍。
 *  - 同时记录每个会话最后一次看到的累计值，用于计算「今日增量」和异常回退提示。
 */

const fs = require('fs');
const path = require('path');

const VERSION = 1;

function emptyDb() {
  return { version: VERSION, updatedAt: 0, days: {}, sessions: {} };
}

function load(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const db = JSON.parse(raw);
    if (!db || typeof db !== 'object') return emptyDb();
    db.days = db.days || {};
    db.sessions = db.sessions || {};
    return db;
  } catch (e) {
    return emptyDb();
  }
}

function save(file, db) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db.updatedAt = Date.now();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    /* 磁盘只读等情况：静默降级为内存态 */
  }
}

function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 只合并每日序列（按字段取大值，避免重复采集翻倍）。
 * WorkBuddy 有精确的按日归属，只需要这一层，不需要「首见归创建日」的外推。
 */
function mergeDaily(db, daily) {
  for (const day of daily || []) {
    const cur = db.days[day.date] || { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    const total = (day.uncachedInput || 0) + (day.output || 0) + (day.cacheRead || 0);
    db.days[day.date] = {
      uncachedInput: Math.max(cur.uncachedInput || 0, day.uncachedInput || 0),
      output: Math.max(cur.output || 0, day.output || 0),
      cacheRead: Math.max(cur.cacheRead || 0, day.cacheRead || 0),
      cacheWrite: Math.max(cur.cacheWrite || 0, day.cacheWrite || 0),
      turns: Math.max(cur.turns || 0, day.turns || day.requests || 0),
      sessions: Math.max(cur.sessions || 0, day.sessions || 0),
      total: Math.max(cur.total || 0, total),
    };
  }
  return db;
}

/**
 * 合并一次采集快照到历史库。
 * @param {object} db
 * @param {object} snapshot collector.collect() 的返回值
 * @returns {object} db
 */
function merge(db, snapshot) {
  mergeDaily(db, snapshot.daily);

  for (const s of snapshot.sessions || []) {
    const prev = db.sessions[s.id];
    const t = s.totals || {};
    const has = (t.uncachedInput || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) > 0;
    if (!prev && has) {
      // 首次见到：把历史用量归到会话创建当天，避免全堆到今天
      const day = s.createdAt ? new Date(s.createdAt) : new Date();
      const key = todayKey(day);
      const cur = db.days[key] || { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, sessions: 0, total: 0 };
      cur.uncachedInput = Math.max(cur.uncachedInput || 0, t.uncachedInput || 0);
      cur.output = Math.max(cur.output || 0, t.output || 0);
      cur.cacheRead = Math.max(cur.cacheRead || 0, t.cacheRead || 0);
      cur.total = (cur.uncachedInput || 0) + (cur.output || 0) + (cur.cacheRead || 0);
      db.days[key] = cur;
    }
    db.sessions[s.id] = {
      totals: {
        uncachedInput: t.uncachedInput || 0,
        output: t.output || 0,
        cacheRead: t.cacheRead || 0,
        cacheWrite: t.cacheWrite || 0,
      },
      seenAt: Date.now(),
      title: s.title || null,
    };
  }
  return db;
}

/**
 * 取最近 N 天的序列（含空白天，保证条形图连续）。
 */
function series(db, liveDaily, days = 14, now = new Date()) {
  const map = new Map();
  for (const [date, v] of Object.entries(db.days || {})) map.set(date, { ...v });
  for (const d of liveDaily || []) {
    const cur = map.get(d.date) || {};
    map.set(d.date, {
      ...cur,
      uncachedInput: Math.max(cur.uncachedInput || 0, d.uncachedInput || 0),
      output: Math.max(cur.output || 0, d.output || 0),
      cacheRead: Math.max(cur.cacheRead || 0, d.cacheRead || 0),
      turns: Math.max(cur.turns || 0, d.turns || 0),
      sessions: Math.max(cur.sessions || 0, d.sessions || 0),
    });
  }

  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = todayKey(d);
    const v = map.get(key) || {};
    const uncachedInput = v.uncachedInput || 0;
    const output = v.output || 0;
    const cacheRead = v.cacheRead || 0;
    out.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      weekday: d.getDay(),
      uncachedInput,
      output,
      cacheRead,
      total: uncachedInput + output + cacheRead,
      turns: v.turns || 0,
      sessions: v.sessions || 0,
      isToday: i === 0,
    });
  }
  return out;
}

module.exports = { load, save, merge, mergeDaily, series, todayKey, emptyDb };
