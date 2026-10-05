'use strict';

// 定时自动刷新调度器（窗口级优先，实例级兜底）。
// 每 5s 轮询 Local API browser/active 得到 {user_id, debug_port}；
// 对每个运行中的实例拉取 /json/list，逐个 page 目标决定是否刷新：
//   - 窗口级配置（configs[pid].windows[targetId]）存在时以其为准
//   - 否则继承实例级配置，范围由 scope 决定：
//       'all'    实例级默认应用到全部窗口
//       'active' 实例级默认仅应用到活动窗口（/json/list 首个 page）
// 每个窗口独立计时（nextFireAt），连续失败 3 次熔断该实例调度并写错误日志。

const fs = require('fs');
const path = require('path');
const http = require('http');

const ACTIVE_POLL_MS = 5000;
const TICK_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function fetchJson(url, timeoutMs = 3000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 通过 CDP WebSocket 刷新单个目标。WebSocket 可注入便于测试。
async function reloadTarget(wsUrl, WebSocketImpl = global.WebSocket) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (error) {
      return reject(error);
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) { /* ignore */ }
      reject(new Error('reload timeout'));
    }, 15000);
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch (_) { return; }
      if (msg.id === 1) {
        clearTimeout(timer);
        try { ws.close(); } catch (_) { /* ignore */ }
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(true);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    };
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 999999901, method: 'Debugger.enable', params: {} }));
        ws.send(JSON.stringify({ id: 999999902, method: 'Debugger.setSkipAllPauses', params: { skip: true } }));
      } catch (_) { /* ignore */ }
      ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
    };
  });
}

class Refresher {
  constructor(options = {}) {
    this.localApiBase = options.localApiBase || 'http://127.0.0.1:50325';
    this.apiKey = options.apiKey || '';
    this.configFile = options.configFile;
    this.errorLogFile = options.errorLogFile;
    this.WebSocketImpl = options.WebSocketImpl || global.WebSocket;
    this.clock = options.clock || (() => Date.now());
    this.configs = this.configFile ? loadJson(this.configFile, {}) : {};
    this.active = new Map(); // profileId -> debug_port
    this.lastFire = new Map(); // profileId -> epoch ms
    this.failures = new Map(); // profileId -> consecutive failures
    this.paused = new Set(); // 熔断的窗口
    this.retryAt = new Map(); // profileId -> next retry timestamp
    this.ticking = false;
    this.pollTimer = null;
    this.tickTimer = null;
    this.reloadFn = options.reloadFn || reloadTarget;
  }

  loadConfigs() {
    if (this.configFile) this.configs = loadJson(this.configFile, {});
    return this.configs;
  }

  getConfig(profileId) {
    const cfg = this.configs[profileId];
    if (!cfg) return { intervalSec: 0, scope: 'active', enabled: false, windows: {} };
    return { scope: 'active', enabled: false, windows: {}, ...cfg };
  }

  setConfig(profileId, { intervalSec, scope, enabled }) {
    const current = this.getConfig(profileId);
    const next = {
      ...current,
      intervalSec: intervalSec === undefined ? current.intervalSec : Math.max(0, Number(intervalSec) || 0),
      scope: scope === undefined ? current.scope : (scope === 'all' ? 'all' : 'active'),
      enabled: enabled === undefined ? current.enabled : Boolean(enabled),
    };
    if (next.enabled && next.intervalSec < 5) next.enabled = false;
    this.configs[profileId] = next;
    if (this.configFile) saveJson(this.configFile, this.configs);
    if (!next.enabled) {
      this.failures.delete(profileId);
      this.paused.delete(profileId);
      this.retryAt.delete(profileId);
    }
    return next;
  }

  // 窗口级覆盖：intervalSec<=0 表示继承实例级间隔；enabled 缺省视为启用
  setWindowConfig(profileId, targetId, { intervalSec, enabled } = {}) {
    const cfg = this.getConfig(profileId);
    cfg.windows = cfg.windows || {};
    const cur = cfg.windows[targetId] || {};
    const next = {
      intervalSec: intervalSec === undefined ? (cur.intervalSec || 0) : Math.max(0, Number(intervalSec) || 0),
      enabled: enabled === undefined ? (cur.enabled === undefined ? true : cur.enabled) : Boolean(enabled),
    };
    if (next.enabled && next.intervalSec > 0 && next.intervalSec < 5) next.enabled = false;
    cfg.windows[targetId] = next;
    this.configs[profileId] = cfg;
    if (this.configFile) saveJson(this.configFile, this.configs);
    this.lastFire.delete(`${profileId}|${targetId}`);
    return next;
  }

  // 清除窗口级覆盖，回归实例级默认
  clearWindowConfig(profileId, targetId) {
    const cfg = this.getConfig(profileId);
    if (cfg.windows && cfg.windows[targetId]) {
      delete cfg.windows[targetId];
      this.configs[profileId] = cfg;
      if (this.configFile) saveJson(this.configFile, this.configs);
    }
    this.lastFire.delete(`${profileId}|${targetId}`);
    return this.getConfig(profileId);
  }

  // 计算某窗口的有效刷新配置（供 API/前端展示与倒计时）
  windowState(profileId, targetId, pageIndex = 0, running = true) {
    const cfg = this.getConfig(profileId);
    const win = cfg.windows && cfg.windows[targetId];
    let enabled = false;
    let intervalSec = 0;
    let source = 'off';
    if (win) {
      source = 'window';
      if (win.enabled === false) {
        enabled = false;
        intervalSec = 0;
      } else {
        enabled = true;
        intervalSec = win.intervalSec >= 5 ? win.intervalSec : cfg.intervalSec;
      }
    } else if (cfg.enabled) {
      const inScope = cfg.scope === 'all' || pageIndex === 0;
      if (inScope && cfg.intervalSec >= 5) {
        enabled = true;
        intervalSec = cfg.intervalSec;
        source = 'instance';
      }
    }
    const last = this.lastFire.get(`${profileId}|${targetId}`) || 0;
    const nextFireAt = enabled && running ? (last ? last + intervalSec * 1000 : this.clock()) : null;
    return { enabled, intervalSec, source, lastFireAt: last || null, nextFireAt };
  }

  start() {
    this.pollActive();
    this.pollTimer = setInterval(() => this.pollActive(), ACTIVE_POLL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
    this.tickTimer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
  }

  async pollActive() {
    try {
      const data = await fetchJson(`${this.localApiBase}/api/browser/active`, 3000,
        this.apiKey ? { 'api-key': this.apiKey } : {});
      const list = (data && data.data && data.data.list) || [];
      const next = new Map();
      for (const item of list) {
        if (item.user_id && item.debug_port) next.set(item.user_id, item.debug_port);
      }
      this.active = next;
    } catch (_) { /* local api 暂不可达，保持上次快照 */ }
  }

  logError(profileId, message) {
    if (!this.errorLogFile) return;
    try {
      fs.mkdirSync(path.dirname(this.errorLogFile), { recursive: true });
      fs.appendFileSync(this.errorLogFile, `${JSON.stringify({ ts: this.clock(), profileId, message })}\n`);
    } catch (_) { /* ignore */ }
  }

  async listPages(port) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
    return (Array.isArray(targets) ? targets : [])
      .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      .map((t) => ({ ...t, id: t.id || t.webSocketDebuggerUrl }));
  }

  // 立即刷新该实例当前所有应刷新的窗口（窗口级优先，实例级兜底）
  async refreshProfile(profileId, port) {
    const pages = await this.listPages(port);
    if (!pages.length) throw new Error('no page targets');
    let count = 0;
    for (let i = 0; i < pages.length; i++) {
      const st = this.windowState(profileId, pages[i].id, i, true);
      if (!st.enabled || !st.intervalSec) continue;
      await this.reloadFn(pages[i].webSocketDebuggerUrl, this.WebSocketImpl);
      this.lastFire.set(`${profileId}|${pages[i].id}`, this.clock());
      count += 1;
    }
    if (!count) throw new Error('no refreshable targets');
    return count;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
    const now = this.clock();
    for (const profileId of Object.keys(this.configs)) {
      if (this.paused.has(profileId)) {
        const retryAt = this.retryAt.get(profileId) || 0;
        if (now < retryAt) continue;
        this.paused.delete(profileId);
        this.failures.delete(profileId);
      }
      if (now < (this.retryAt.get(profileId) || 0)) continue;
      const port = this.active.get(profileId);
      if (!port) continue; // 实例停止 → 调度暂停
      let pages;
      try {
        pages = await this.listPages(port);
      } catch (_) {
        continue;
      }
      for (let i = 0; i < pages.length; i++) {
        const target = pages[i];
        const st = this.windowState(profileId, target.id, i, true);
        if (!st.enabled || !st.intervalSec) continue;
        const key = `${profileId}|${target.id}`;
        const last = this.lastFire.get(key) || 0;
        if (now - last < st.intervalSec * 1000) continue;
        try {
          await this.reloadFn(target.webSocketDebuggerUrl, this.WebSocketImpl);
          this.failures.delete(profileId);
          this.retryAt.delete(profileId);
          this.lastFire.set(key, this.clock());
        } catch (error) {
          const count = (this.failures.get(profileId) || 0) + 1;
          this.failures.set(profileId, count);
          this.retryAt.set(profileId, this.clock() + Math.min(MAX_RETRY_DELAY_MS, 1000 * (2 ** Math.min(count, 5))));
          this.logError(profileId, `refresh failed (${count}): ${error.message}`);
          if (count >= 3) {
            this.paused.add(profileId);
            this.logError(profileId, 'refresh circuit opened: retry scheduled automatically');
          }
        }
      }
    }
    } finally {
      this.ticking = false;
    }
  }

  // 给 targets 列表附加每个窗口的刷新状态（来源/间隔/下次刷新时间）
  decorateTargets(profileId, targets) {
    const pages = Array.isArray(targets) ? targets : [];
    const running = this.active.has(profileId);
    return pages.map((t, i) => ({ ...t, refresh: this.windowState(profileId, t.id, i, running) }));
  }

  resume(profileId) {
    this.paused.delete(profileId);
    this.failures.delete(profileId);
    this.retryAt.delete(profileId);
    const prefix = `${profileId}|`;
    for (const key of [...this.lastFire.keys()]) {
      if (key.startsWith(prefix)) this.lastFire.delete(key);
    }
  }

  // 清理已不存在窗口的计时/配置，避免长期运行后状态泄漏
  pruneWindows(profileId, liveTargetIds) {
    const live = new Set(liveTargetIds || []);
    const cfg = this.getConfig(profileId);
    let dirty = false;
    if (cfg.windows) {
      for (const tid of Object.keys(cfg.windows)) {
        if (!live.has(tid)) { delete cfg.windows[tid]; dirty = true; }
      }
    }
    const prefix = `${profileId}|`;
    for (const key of [...this.lastFire.keys()]) {
      if (key.startsWith(prefix) && !live.has(key.slice(prefix.length))) this.lastFire.delete(key);
    }
    if (dirty) {
      this.configs[profileId] = cfg;
      if (this.configFile) saveJson(this.configFile, this.configs);
    }
  }

  status() {
    const out = {};
    for (const [profileId, cfg] of Object.entries(this.configs)) {
      out[profileId] = {
        ...cfg,
        running: this.active.has(profileId),
        paused: this.paused.has(profileId),
      };
    }
    return out;
  }
}

module.exports = { Refresher, reloadTarget, fetchJson, loadJson, saveJson };
