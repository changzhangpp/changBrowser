'use strict';

// keeper.js — OpenBrowser 全链路守护（root 运行，15s 巡检）
//
// 职责：
// 1. Xvfb :99 不在 → 拉起
// 2. 桌面客户端（Local API 50325）不在/连续无响应 → 杀掉残留进程并拉起
// 3. webconsole（50327）不在 → 拉起
// 4. opsbox（8002）不在 → 拉起
// 5. 期望存活实例（keeper-state.json，由控制台 start/stop 维护）死亡 → 调 Local API 重启
//    - 控制台「停止」/守护规则 stop/删除实例 → 从期望集合移除，keeper 不再拉起
// 6. 内存守护：实例内存总和逼近系统上限（7G）且存在失控实例（>2.5G）→ 终止并重启该实例，记录日志
//
// 与 guard 的关系：guard 做资源超限保护性停止；keeper 只做「死了复活」，两者不冲突。

const { execFile, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = '/workspace/OpenBrowser/Browserapp';
const STATE_FILE = '/home/openbrowser/.config/openbrowser/console/keeper-state.json';
const API_KEY_FILE = '/home/openbrowser/.config/openbrowser/local-api-key.txt';
const LOOP_SEC = 15;
const CLIENT_HANG_LIMIT = 3;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[keeper]', ...a);

function pgrep(pattern) {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', pattern], (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.toString().split('\n').map((s) => parseInt(s, 10)).filter((n) => n > 0));
    });
  });
}

function killPids(pids) {
  return new Promise((resolve) => {
    if (!pids.length) return resolve();
    execFile('kill', ['-9', ...pids], () => resolve());
  });
}

// 以 uid 1000 启动 detached 进程
function spawnUser(cmd, args, cwd) {
  const child = spawn('setpriv', [
    '--reuid=1000', '--regid=1000', '--clear-groups', 'env',
    'HOME=/home/openbrowser', 'ELECTRON_DISABLE_SANDBOX=1', 'DISPLAY=:99',
    'OPENBROWSER_NETLOG=1',
    cmd, ...args,
  ], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  log('spawned(uid1000):', cmd, args.join(' '), '@', cwd);
}

function probe(port, reqPath, headers, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 100);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function localApi(method, reqPath, body, timeoutMs) {
  return new Promise((resolve) => {
    let key = '';
    try { key = fs.readFileSync(API_KEY_FILE, 'utf8').trim(); } catch (_) {}
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: 50325, path: reqPath, method,
      headers: { 'api-key': key, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: timeoutMs || 8000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

// ===== 各服务恢复动作 =====

async function ensureXvfb() {
  const pids = await pgrep('^Xvfb :99|Xvfb :99 ');
  if (pids.length) return;
  const child = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac', '-nolisten', 'tcp'], { detached: true, stdio: 'ignore' });
  child.unref();
  log('Xvfb 已拉起');
}

let clientFails = 0;
let clientRestarting = false;

async function ensureClient() {
  if (clientRestarting) return null;
  const ok = await probe(50325, '/api/browser/active', {});
  if (ok) { clientFails = 0; return null; }
  clientFails += 1;
  const pids = await pgrep('scripts/run-app\\.js|OpenBrowser$');
  if (!pids.length) {
    log('桌面客户端不在 → 拉起');
    clientRestarting = true;
    spawnUser('node', ['scripts/run-app.js'], BASE);
    setTimeout(() => { clientRestarting = false; clientFails = 0; }, 20000);
    return null;
  }
  if (clientFails >= CLIENT_HANG_LIMIT) {
    log(`Local API 连续 ${clientFails} 次无响应且进程存在 → 判定卡死，强制重启客户端`);
    await killPids(pids);
    clientFails = 0;
    clientRestarting = true;
    setTimeout(() => {
      spawnUser('node', ['scripts/run-app.js'], BASE);
      setTimeout(() => { clientRestarting = false; }, 20000);
    }, 1500);
  } else {
    log(`Local API 无响应 ${clientFails}/${CLIENT_HANG_LIMIT}`);
  }
  return null;
}

async function ensureConsole() {
  const ok = await probe(50327, '/favicon.ico');
  if (ok) return;
  const pids = await pgrep('node webconsole/server\\.js');
  if (pids.length) {
    // 进程在但端口死 → 僵尸，清掉下次循环拉起
    if (!(await probe(50327, '/favicon.ico', {}, 6000))) {
      log('webconsole 进程存在但端口无响应 → 清理残留');
      await killPids(pids);
    }
    return;
  }
  log('webconsole 不在 → 拉起');
  spawnUser('node', ['webconsole/server.js'], BASE);
}

async function ensureOpsbox() {
  const ok = await probe(8002, '/');
  if (ok) return;
  const pids = await pgrep('uvicorn app:app');
  if (pids.length) { await killPids(pids); }
  log('opsbox 不在 → 拉起');
  const child = spawn('python3', ['-m', 'uvicorn', 'app:app', '--host', '0.0.0.0', '--port', '8002'], {
    cwd: '/workspace/OpenBrowser/opsbox', detached: true, stdio: 'ignore',
  });
  child.unref();
}

// ===== 期望存活实例 =====

const startLocks = new Map(); // id -> cooldown ts
const starting = new Set();
const cdpFails = new Map(); // id -> consecutive CDP probe failures

async function restartInstance(id, reason) {
  if (starting.has(id)) return;
  const until = startLocks.get(id) || 0;
  if (Date.now() < until) return;
  starting.add(id);
  log(`实例 ${id} ${reason} → 重启`);
  try {
    await localApi('POST', '/api/browser/stop', { profile_id: id }, 20000);
    const result = await localApi('POST', '/api/browser/start', { profile_id: id }, 90000);
    if (!result || result.code !== 0) {
      log(`实例 ${id} 重启失败：${(result && result.msg) || '无响应'}，60s 内不再尝试`);
      startLocks.set(id, Date.now() + 60000);
    } else {
      log(`实例 ${id} 已恢复`);
      cdpFails.delete(id);
    }
  } finally {
    starting.delete(id);
  }
}

async function ensureInstances(activeList) {
  const state = readState();
  const activeById = new Map((activeList || []).map((x) => [x.user_id || x.id, x]).filter(([id]) => id));
  // 自动纳管：桌面客户端直接启动的实例也纳入守护（显式 stop 的实例保持 false 不复活）
  let dirty = false;
  for (const id of activeById.keys()) {
    if (!(id in state)) {
      state[id] = true;
      dirty = true;
      log(`自动纳入守护: ${id}`);
    }
  }
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      try { fs.chownSync(STATE_FILE, 1000, 1000); } catch (_) { /* 控制台(uid1000)需要可写此文件 */ }
    } catch (_) { /* ignore */ }
  }
  const want = Object.keys(state).filter((k) => state[k]);
  if (!want.length) return;
  for (const id of want) {
    const running = activeById.get(id);
    if (running) {
      if (!running.debug_port) continue;
      const healthy = await probe(running.debug_port, '/json/version', {}, 3000);
      if (healthy) {
        cdpFails.delete(id);
        continue;
      }
      const failures = (cdpFails.get(id) || 0) + 1;
      cdpFails.set(id, failures);
      log(`实例 ${id} CDP 无响应 ${failures}/3`);
      if (failures >= 3) await restartInstance(id, 'CDP 连续无响应');
      continue;
    }
    if (starting.has(id)) continue;
    const until = startLocks.get(id) || 0;
    if (Date.now() < until) continue;
    starting.add(id);
    log(`实例 ${id} 期望存活但已死亡 → 重启`);
    localApi('POST', '/api/browser/start', { profile_id: id }, 90000).then((r) => {
      if (!r || r.code !== 0) {
        log(`实例 ${id} 重启失败：${(r && r.msg) || '无响应'}，60s 内不再尝试`);
        startLocks.set(id, Date.now() + 60000);
      } else {
        log(`实例 ${id} 已复活`);
      }
    }).finally(() => starting.delete(id));
  }
}

// ===== 内存守护 =====

const MEM_TOTAL_LIMIT = 7 * 1024 * 1024 * 1024; // 实例内存总和上限 7G（系统 8G，逼近即干预）
const MEM_RUNAWAY = 2.5 * 1024 * 1024 * 1024;   // 单实例失控线（正常实例约 0.7-1.2G）
const MEM_STRIKES = 3;                           // 连续采样超限次数，防瞬时尖峰误杀
const memStrikes = new Map(); // id -> 连续超限采样次数

const fmtG = (n) => (n / 1048576 / 1024).toFixed(2) + 'G';

// 扫描 /proc，按实例 profile 目录归属统计各实例常驻内存总和（字节）
function instanceMemoryMap() {
  const map = new Map();
  const pageSize = 4096;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch (_) { continue; }
    const m = cmd.match(/browser-profiles-v2\/([^/\0]+)/);
    if (!m) continue;
    let statm = '';
    try { statm = fs.readFileSync(`/proc/${d}/statm`, 'utf8'); } catch (_) { continue; }
    const rssPages = Number(statm.split(' ')[1]);
    if (!rssPages) continue;
    map.set(m[1], (map.get(m[1]) || 0) + rssPages * pageSize);
  }
  return map;
}

async function memoryGuard() {
  let map;
  try { map = instanceMemoryMap(); } catch (_) { return; }
  if (!map.size) { memStrikes.clear(); return; }
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const detail = entries.map(([id, v]) => `${id}=${fmtG(v)}`).join(' ');
  if (total < MEM_TOTAL_LIMIT) {
    if (memStrikes.size) memStrikes.clear();
    return;
  }
  const [topId, topMem] = entries[0];
  if (topMem < MEM_RUNAWAY) {
    // 总量超限但无单点失控：只告警不终止，避免误伤正常实例
    log(`内存告警：实例总内存 ${fmtG(total)} 逼近上限，无单点失控 | ${detail}`);
    return;
  }
  const strikes = (memStrikes.get(topId) || 0) + 1;
  memStrikes.set(topId, strikes);
  log(`内存守护：实例 ${topId} 内存 ${fmtG(topMem)} 失控（总计 ${fmtG(total)}）${strikes}/${MEM_STRIKES}`);
  if (strikes >= MEM_STRIKES) {
    memStrikes.delete(topId);
    log(`内存守护：终止失控实例 ${topId}（该实例 ${fmtG(topMem)} / 总计 ${fmtG(total)}）→ 重启恢复 | ${detail}`);
    await restartInstance(topId, `内存失控 ${fmtG(topMem)}`);
  }
}

// 首次运行：把当前已在运行的实例纳入守护集合（此后由控制台 start/stop 维护）
async function seedState() {
  if (fs.existsSync(STATE_FILE)) return;
  const r = await localApi('GET', '/api/browser/active', null, 5000);
  if (r && r.code === 0) {
    const j = {};
    for (const it of (r.data && r.data.list) || []) {
      const id = it.user_id || it.id;
      if (id) j[id] = true;
    }
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(j));
      try { fs.chownSync(STATE_FILE, 1000, 1000); } catch (_) { /* 控制台(uid1000)需要可写此文件 */ }
      log('首次播种守护集合:', Object.keys(j).join(',') || '(空)');
    } catch (_) { /* ignore */ }
  }
}

// ===== 主循环 =====

async function loop() {
  try { await ensureXvfb(); } catch (e) { log('xvfb err:', e.message); }
  let activeList = null;
  try { activeList = await ensureClient(); } catch (e) { log('client err:', e.message); }
  if (activeList === null) {
    const r = await localApi('GET', '/api/browser/active', null, 5000);
    if (r && r.code === 0) activeList = (r.data && r.data.list) || [];
  }
  try { await ensureConsole(); } catch (e) { log('console err:', e.message); }
  try { await ensureOpsbox(); } catch (e) { log('opsbox err:', e.message); }
  if (activeList) { try { await ensureInstances(activeList); } catch (e) { log('inst err:', e.message); } }
  try { await memoryGuard(); } catch (e) { log('mem err:', e.message); }
}

log('keeper 启动，巡检间隔', LOOP_SEC + 's');
seedState().catch(() => {});
loop();
setInterval(loop, LOOP_SEC * 1000);
