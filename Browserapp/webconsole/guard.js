'use strict';

// 实例资源异常增长守护。
// 每 sampleSec 扫描 procRoot 下进程 cmdline，按 --user-data-dir=<profileDir> 归属实例，
// 聚合进程树 RSS / CPU / 进程数；触发规则时写 JSONL 日志并调用 onTerminate 终止实例。
//
// 规则（默认值可通过 configure 覆盖）：
//   rss_limit      实例 RSS 绝对上限（默认 1536MB）
//   growth         RSS 每分钟增幅 > growthPctPerMin 且连续 growthWindows 个窗口成立
//   cpu_sustained  CPU > cpuLimitPct 持续 cpuSustainSec
//   proc_count     实例进程数超过 procLimit（默认 200）

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  sampleSec: 5,
  // 2026-10-05 事故复盘：1536MB 在多标签登录流程（GitHub/抖音 OAuth）下轻松超过，
  // guard 会在登录最后一步反复杀实例，与 keeper 拉起形成死循环。
  // 现仅作应急刹车：正常上限守护由 keeper 内存守护（单实例 2.5G 持续 45s）承担。
  rssLimitMb: 4096,
  growthPctPerMin: 15,
  growthWindows: 3,
  cpuLimitPct: 98,
  cpuSustainSec: 900,
  procLimit: 200,
};

function readPid(pid, procRoot) {
  const out = { cmdline: '', rssKb: 0, ticks: 0 };
  try {
    out.cmdline = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0').filter(Boolean).join(' ');
  } catch (_) { return null; }
  try {
    const status = fs.readFileSync(path.join(procRoot, String(pid), 'status'), 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (m) out.rssKb = Number(m[1]);
  } catch (_) { /* kernel thread or exited */ }
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // comm 可能含空格与括号，取最后一个 ')' 之后的部分
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest[11]=utime rest[12]=stime（ppid=rest[1] 起，state 是 rest[0]）
    out.ticks = Number(rest[11]) + Number(rest[12]);
  } catch (_) { /* ignore */ }
  return out;
}

function scanProc(procRoot, marker) {
  const pids = [];
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch (_) {
    return pids;
  }
  const needle = `--user-data-dir=${marker}`;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const info = readPid(name, procRoot);
    if (info && info.cmdline.includes(needle)) pids.push({ pid: Number(name), ...info });
  }
  return pids;
}

class Guard {
  constructor(options = {}) {
    this.configure(options.config || {});
    this.procRoot = options.procRoot || '/proc';
    this.logFile = options.logFile;
    this.onTerminate = options.onTerminate || (async () => ({ result: 'noop' }));
    this.clock = options.clock || (() => Date.now());
    this.samples = new Map(); // profileId -> [{t, rssKb, cpuSec, procs}]
    this.cpuSustained = new Map(); // profileId -> seconds over limit
    this.growthStrikes = new Map(); // profileId -> consecutive growth windows
    this.growthBase = new Map(); // profileId -> {t, rssKb} 窗口起点
    this.events = []; // 最近事件环形缓冲
    this.timer = null;
    this.busy = false;
  }

  configure(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    return this.config;
  }

  start() {
    if (this.timer || !this.config.enabled) return;
    const interval = Math.max(1, this.config.sampleSec) * 1000;
    this.timer = setInterval(() => {
      this.sampleOnce().catch((error) => this.logEvent({
        kind: 'guard-error', rule: 'sample', error: String(error && error.message || error),
      }));
    }, interval);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(profileId, snapshot) {
    const list = (this.samples.get(profileId) || []);
    list.push(snapshot);
    if (list.length > 720) list.shift();
    this.samples.set(profileId, list);
  }

  snapshotFor(profileId) {
    const list = this.samples.get(profileId);
    const last = list && list[list.length - 1];
    return last ? {
      rssMb: Math.round(last.rssKb / 1024),
      cpuPct: Math.round(last.cpuPct * 10) / 10,
      procs: last.procs,
    } : null;
  }

  recentEvents(limit = 50) {
    return this.events.slice(-limit).reverse();
  }

  logEvent(event) {
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`);
    } catch (_) { /* 日志失败不影响守护 */ }
  }

  // 一次采样 + 规则评估；instances: [{id, profileDirectory}]
  async sampleOnce(instances) {
    if (this.busy) return [];
    this.busy = true;
    try {
      const triggered = [];
      const now = this.clock();
      for (const inst of instances || []) {
        if (!inst.profileDirectory) continue;
        const procs = scanProc(this.procRoot, inst.profileDirectory);
        if (!procs.length) continue;
        const rssKb = procs.reduce((sum, p) => sum + p.rssKb, 0);
        const ticks = procs.reduce((sum, p) => sum + p.ticks, 0);
        const list = this.samples.get(inst.id) || [];
        const last = list[list.length - 1];
        const elapsed = last ? (now - last.t) / 1000 : 0;
        // CLK_TCK=100 → ticks/100 = CPU 秒
        const cpuPct = elapsed > 0 ? ((ticks - last.ticks) / 100) / elapsed * 100 : 0;
        const snapshot = { t: now, rssKb, ticks, cpuPct: Math.max(0, cpuPct), procs: procs.length };
        this.record(inst.id, snapshot);

        const rule = this.evaluate(inst.id, snapshot);
        if (rule) {
          triggered.push({ id: inst.id, rule, snapshot });
          await this.handleTrigger(inst, rule, snapshot, procs);
        }
      }
      return triggered;
    } finally {
      this.busy = false;
    }
  }

  evaluate(profileId, snap) {
    const cfg = this.config;
    const rssMb = snap.rssKb / 1024;

    if (rssMb > cfg.rssLimitMb) return 'rss_limit';
    if (snap.procs > cfg.procLimit) return 'proc_count';

    // CPU 持续超限
    if (snap.cpuPct > cfg.cpuLimitPct) {
      const over = (this.cpuSustained.get(profileId) || 0) + cfg.sampleSec;
      this.cpuSustained.set(profileId, over);
      if (over >= cfg.cpuSustainSec) return 'cpu_sustained';
    } else {
      this.cpuSustained.set(profileId, 0);
    }

    // 每分钟增幅窗口
    const base = this.growthBase.get(profileId);
    if (!base) {
      this.growthBase.set(profileId, { t: snap.t, rssKb: snap.rssKb });
    } else if (snap.t - base.t >= 60000) {
      const growPct = base.rssKb > 0 ? (snap.rssKb - base.rssKb) / base.rssKb * 100 : 0;
      if (growPct > cfg.growthPctPerMin) {
        const strikes = (this.growthStrikes.get(profileId) || 0) + 1;
        this.growthStrikes.set(profileId, strikes);
        if (strikes >= cfg.growthWindows) return 'growth';
      } else {
        this.growthStrikes.set(profileId, 0);
      }
      this.growthBase.set(profileId, { t: snap.t, rssKb: snap.rssKb });
    }

    return null;
  }

  async handleTrigger(inst, rule, snap, procs) {
    const event = {
      kind: 'guard-trigger', ts: this.clock(), profileId: inst.id, rule,
      metrics: {
        rssMb: Math.round(snap.rssKb / 1024),
        cpuPct: Math.round(snap.cpuPct * 10) / 10,
        procs: snap.procs,
      },
      pids: procs.map((p) => p.pid).slice(0, 50),
      action: 'stop',
    };
    this.logEvent(event);
    try {
      const result = await this.onTerminate(inst.id);
      event.result = result && result.ok ? 'ok' : 'failed';
    } catch (error) {
      event.result = 'failed';
      event.error = String(error && error.message || error);
    }
    this.logEvent({ kind: 'guard-action', ts: this.clock(), profileId: inst.id, rule, result: event.result });
    // 清理该实例的窗口状态，避免终止后旧数据再次触发
    this.samples.delete(inst.id);
    this.cpuSustained.delete(inst.id);
    this.growthStrikes.delete(inst.id);
    this.growthBase.delete(inst.id);
    return event;
  }
}

module.exports = { Guard, scanProc, readPid, DEFAULTS };
