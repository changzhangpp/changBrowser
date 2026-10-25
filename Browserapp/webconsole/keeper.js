'use strict';

// keeper.js — OpenBrowser 全链路守护（root 运行，15s 巡检）
//
// 职责：
// 1. Xvfb :99 不在 → 拉起
// 2. 桌面客户端（Local API 50325）不在/连续无响应 → 杀掉残留进程并拉起
// 3. webconsole（50327）不在 → 拉起
// 4. opsbox（8002）不在 → 拉起
// 5. 期望存活实例（keeper-state.json，由控制台 start/stop 维护）死亡 → 调 Local API 重启，
//    并按 console-ops.log 里该实例最后已知 URL 自动恢复任务页
//    - 控制台「停止」/守护规则 stop/删除实例 → 从期望集合移除，keeper 不再拉起
// 6. 内存守护：实例内存总和逼近系统上限（7G）且存在失控实例（>2.5G）→ 终止并重启该实例，记录日志
// 7. 系统可用内存（MemAvailable）低于阈值 → 记录挤压告警（气球抽干时进程会无声死亡，留证据链）
//
// 与 guard 的关系：guard 做资源超限保护性停止；keeper 只做「死了复活」，两者不冲突。

const { execFile, spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = '/workspace/OpenBrowser/Browserapp';
const STATE_FILE = '/home/openbrowser/.config/openbrowser/console/keeper-state.json';
const API_KEY_FILE = '/home/openbrowser/.config/openbrowser/local-api-key.txt';
const OPS_LOG = '/home/openbrowser/.config/openbrowser/logs/console-ops.log';
const REFRESH_CONFIG = '/home/openbrowser/.config/openbrowser/console/refresh-config.json';
// 实例专用 cgroup：脱离任何后台终端的 cgroup，终端/keeper 重启不再连坐杀死实例
const INSTANCE_CGROUP = '/sys/fs/cgroup/ob_instances';

function ensureInstanceCgroup() {
  try { fs.mkdirSync(INSTANCE_CGROUP, { recursive: true }); return true; }
  catch (e) { log('实例 cgroup 创建失败(进程将随终端存亡):', e.message); return false; }
}

function cgroupAdopt(pid) {
  try { fs.appendFileSync(path.join(INSTANCE_CGROUP, 'cgroup.procs'), pid + '\n'); } catch (_) { /* 进程可能已退出 */ }
}

// ===== Swap 守护 =====
// 宿主机气球抽干可用内存时，内核有 Swap 可换出冷页而不是 OOM 杀实例（治本层）。
const SWAP_FILE = '/swapfile';

function ensureSwap() {
  try {
    const active = execSync('swapon --show --noheadings 2>/dev/null', { encoding: 'utf8' }).trim();
    if (active) return;
    if (!fs.existsSync(SWAP_FILE)) {
      try {
        execSync(`fallocate -l 4G ${SWAP_FILE}`, { stdio: 'ignore' });
      } catch (_) {
        execSync(`dd if=/dev/zero of=${SWAP_FILE} bs=1M count=4096 status=none`, { stdio: 'ignore' });
      }
      execSync(`chmod 600 ${SWAP_FILE} && mkswap ${SWAP_FILE}`, { stdio: 'ignore' });
    }
    execSync(`swapon ${SWAP_FILE}`, { stdio: 'ignore' });
    log('swap 已启用:', SWAP_FILE, '(4G)');
  } catch (e) {
    log('swap 启用失败(不影响其他守护):', e.message);
  }
}

// ===== 实例名字自愈 =====
// 引擎重启会用内存旧名覆盖存储，把用户改的名字打回数字。这里持续备份非数字名字，
// 一旦发现 name 被重置成 数字/环境N/空，立即用备份名改回。
const NAMES_BACKUP = '/home/openbrowser/.config/openbrowser/console/names-backup.json';

function isLostName(name) {
  const n = String(name || '').trim();
  return !n || /^\d+$/.test(n) || /^环境\s*\d+$/.test(n);
}

async function reconcileNames() {
  try {
    const r = await localApi('GET', '/api/v2/browser-profile/list', null, 10000);
    const list = (r && r.code === 0 && r.data && Array.isArray(r.data.list)) ? r.data.list : [];
    if (!list.length) return;
    let backup = {};
    try { backup = JSON.parse(fs.readFileSync(NAMES_BACKUP, 'utf8')); } catch (_) {}
    let changed = false;
    for (const p of list) {
      const id = p.profile_id || p.user_id || p.id;
      if (!id) continue;
      const name = String(p.name || '');
      if (isLostName(name)) {
        const good = backup[id];
        if (good && good !== name) {
          const u = await localApi('POST', '/api/v2/browser-profile/update', { profile_id: id, name: good }, 10000);
          if (u && u.code === 0) log(`实例「${id}」名字被引擎重置 → 已自动恢复为「${good}」`);
        }
      } else if (backup[id] !== name) {
        backup[id] = name;
        changed = true;
      }
    }
    try {
      fs.mkdirSync(path.dirname(NAMES_BACKUP), { recursive: true });
      fs.writeFileSync(NAMES_BACKUP, JSON.stringify(backup, null, 2));
      if (changed) log('实例名字备份已更新:', JSON.stringify(backup));
    } catch (_) {}
  } catch (_) { /* local api 暂不可达，下轮再试 */ }
}
const PROFILES_DIR = '/home/openbrowser/.config/openbrowser/browser-profiles-v2';
const START_PAGE_HINT = '127.0.0.1:50326';
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
    // netlog 只排障时开：keeper 自身带 OPENBROWSER_NETLOG=1 才透传，且写入受 trimNetlog 上限约束
    ...(process.env.OPENBROWSER_NETLOG === '1' ? ['OPENBROWSER_NETLOG=1'] : []),
    cmd, ...args,
  ], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  cgroupAdopt(child.pid);
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

// ===== 系统可用内存告警（A）=====

const MEM_AVAIL_ALERT_MB = Number(process.env.MEM_AVAIL_ALERT_MB || 300);    // 低于此值记挤压告警
const MEM_AVAIL_RECOVER_MB = Number(process.env.MEM_AVAIL_RECOVER_MB || 500); // 回升到此值以上记恢复
const MEM_AVAIL_COOLDOWN_MS = 600000;  // 告警冷却 10 分钟，避免刷屏
let memAvailAlerting = false;
let memAvailLastAlert = 0;

function memAvailableAlert() {
  let snap;
  try { snap = readMemorySnapshot(); } catch (_) { return; }
  const availMb = snap.availMb;
  if (availMb === null || Number.isNaN(availMb)) return;
  const psi = snap.psiSome10 == null ? '-' : snap.psiSome10;
  if (availMb < MEM_AVAIL_ALERT_MB) {
    memAvailAlerting = true;
    if (Date.now() - memAvailLastAlert >= MEM_AVAIL_COOLDOWN_MS) {
      memAvailLastAlert = Date.now();
      log(`内存挤压告警：系统可用内存仅 ${availMb}MB（阈值 ${MEM_AVAIL_ALERT_MB}MB），swap 已用 ${snap.swapUsedMb}MB 剩余 ${snap.swapFreeMb}MB，PSI some10=${psi}，气球抽干时进程可能无声死亡`);
    }
  } else if (memAvailAlerting && availMb >= MEM_AVAIL_RECOVER_MB) {
    memAvailAlerting = false;
    log(`内存恢复：系统可用内存回升至 ${availMb}MB（swap 已用 ${snap.swapUsedMb}MB，PSI some10=${psi}）`);
  }
}

// ===== 内存时序采样（只记录，供后续定位「实例被终止 / 页面回退」的触发条件）=====
// 每次巡检（15s）写一行 JSON：可用内存、swap 使用、PSI 压力、各实例 RSS。
// 与 logs/freeze-forensics.log、logs/tab-events.log 按时间戳对齐，即可判断是气球抽干、swap 抖动还是实例自身增长。
const MEMORY_SAMPLES = '/home/openbrowser/.config/openbrowser/logs/memory-samples.log';
const MEMORY_SAMPLES_MAX = 8 * 1024 * 1024;
let lastSampleTs = 0;

function readMemorySnapshot() {
  const snap = {};
  const mi = fs.readFileSync('/proc/meminfo', 'utf8');
  const pick = (key) => {
    const m = mi.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  };
  snap.availMb = pick('MemAvailable');
  snap.freeMb = pick('MemFree');
  snap.cachedMb = pick('Cached');
  const swapTotal = pick('SwapTotal');
  const swapFree = pick('SwapFree');
  snap.swapUsedMb = (swapTotal === null || swapFree === null) ? null : swapTotal - swapFree;
  snap.swapFreeMb = swapFree;
  snap.swapCachedMb = pick('SwapCached');
  try {
    const psi = fs.readFileSync('/proc/pressure/memory', 'utf8');
    const some = psi.match(/some avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/);
    const full = psi.match(/full avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/);
    if (some) { snap.psiSome10 = Number(some[1]); snap.psiSome60 = Number(some[2]); snap.psiSome300 = Number(some[3]); }
    if (full) { snap.psiFull10 = Number(full[1]); snap.psiFull60 = Number(full[2]); snap.psiFull300 = Number(full[3]); }
  } catch (_) { /* 内核未开启 PSI */ }
  return snap;
}

function sampleMemory() {
  const now = Date.now();
  const gapSec = lastSampleTs ? Math.round((now - lastSampleTs) / 1000) : 0;
  lastSampleTs = now;
  let snap;
  try { snap = readMemorySnapshot(); } catch (_) { return; }
  const inst = {};
  let instTotalMb = null;
  try {
    for (const [id, bytes] of instanceMemoryMap()) inst[id] = Math.round(bytes / 1048576);
    instTotalMb = Object.values(inst).reduce((sum, v) => sum + v, 0);
  } catch (_) { /* ignore */ }
  try {
    fs.mkdirSync(path.dirname(MEMORY_SAMPLES), { recursive: true });
    try {
      if (fs.statSync(MEMORY_SAMPLES).size > MEMORY_SAMPLES_MAX) fs.renameSync(MEMORY_SAMPLES, `${MEMORY_SAMPLES}.1`);
    } catch (_) { /* 首次写入 */ }
    fs.appendFileSync(MEMORY_SAMPLES, JSON.stringify({ ts: now, gapSec, ...snap, instTotalMb, inst }) + '\n');
  } catch (_) { /* ignore */ }
  if (gapSec > 60) log(`巡检间隔异常 ${gapSec}s（疑似虚拟机挂起/恢复），已记入 memory-samples.log`);
}

// ===== netlog 兜底限流 =====
// 带 --log-net-log 启动的实例会一直往 profile 目录追加 netlog.json 且没有体积上限，
// 长跑几天就能吃掉数 GB。这里超过 256MB 就地截断，保证磁盘不被写满（进程仍持有旧偏移，后续写入会出现稀疏空洞，占用依旧很小）。
const NETLOG_MAX = 256 * 1024 * 1024;

function trimNetlog() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROFILES_DIR); } catch (_) { return; }
  for (const d of dirs) {
    const f = path.join(PROFILES_DIR, d, 'netlog.json');
    try {
      const st = fs.statSync(f);
      // 截断后进程仍从旧偏移写，会形成稀疏文件：apparent size 很大但实际占用很小，必须按块判断
      const allocMb = Math.round((st.blocks * 512) / 1048576);
      if (allocMb <= NETLOG_MAX / 1048576) continue;
      fs.truncateSync(f, 0);
      log(`netlog 超限已截断：${d} 实际占用 ${allocMb}MB（表观 ${Math.round(st.size / 1048576)}MB）-> 0（上限 ${NETLOG_MAX / 1048576}MB）`);
    } catch (_) { /* 不存在或无权限 */ }
  }
}

// ===== 复活后按最后已知 URL 恢复任务页（B）=====

// 从 console-ops.log 尾部找该实例最近一条带 url 的事件
function lastKnownUrl(id) {
  // 首选：刷新配置里用户设定的窗口 URL（实例设置的权威来源，跨重启稳定）
  try {
    const cfg = JSON.parse(fs.readFileSync(REFRESH_CONFIG, 'utf8'));
    const entry = cfg[id];
    const wins = entry && entry.windows ? Object.values(entry.windows) : [];
    const hit = wins.find((w) => w && w.enabled !== false && /^https?:\/\//.test(w.url || ''));
    if (hit) return hit.url;
  } catch (_) { /* 配置缺失则走日志兜底 */ }
  try {
    const st = fs.statSync(OPS_LOG);
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(OPS_LOG, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.profileId === id && typeof j.url === 'string' && /^https?:\/\//.test(j.url) && !j.url.includes(START_PAGE_HINT)) return j.url;
      } catch (_) { /* 跳过坏行 */ }
    }
  } catch (_) { /* 日志不存在 */ }
  return null;
}

function httpGetJson(port, reqPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 裸 CDP：握手后发 Page.navigate，不等回包（结果由上层 /json/list 复核）
function cdpNavigate(port, wsPath, url) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0), handshook = false, done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(ok); } };
    const key = crypto.randomBytes(16).toString('base64');
    sock.on('connect', () => {
      sock.write(`GET ${wsPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (handshook) return;
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      if (!buf.slice(0, i).toString().includes('101')) return finish(false);
      buf = buf.slice(i + 4); handshook = true;
      const payload = Buffer.from(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let k = 0; k < payload.length; k++) masked[k] = payload[k] ^ mask[k % 4];
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      sock.write(Buffer.concat([header, mask, masked]));
      setTimeout(() => finish(true), 2500);
    });
    sock.on('error', () => finish(false));
    setTimeout(() => finish(false), 10000);
  });
}

// 等浏览器起来（DevToolsActivePort 就绪）→ 把起始页导航到最后已知 URL → /json/list 复核
async function restoreInstancePage(id, waitedMs = 0) {
  const url = lastKnownUrl(id);
  if (!url) { log(`实例 ${id} 无最后已知 URL，跳过页面恢复`); return; }
  const RETRY_MS = 3000, MAX_WAIT_MS = 45000;
  if (waitedMs > MAX_WAIT_MS) { log(`实例 ${id} 页面恢复放弃：CDP ${MAX_WAIT_MS / 1000}s 未就绪`); return; }
  let port = 0;
  try { port = Number(fs.readFileSync(path.join(PROFILES_DIR, id, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch (_) {}
  let pages = [];
  if (port) {
    try { pages = ((await httpGetJson(port, '/json/list')) || []).filter((t) => t.type === 'page'); } catch (_) {}
  }
  if (!port || !pages.length) { setTimeout(() => restoreInstancePage(id, waitedMs + RETRY_MS), RETRY_MS); return; }
  const target = pages.find((t) => (t.url || '').includes(START_PAGE_HINT)) || pages[0];
  if ((target.url || '') === url) { log(`实例 ${id} 页面已在目标地址`); return; }
  const wsPath = (target.webSocketDebuggerUrl || '').replace(`ws://127.0.0.1:${port}`, '');
  const ok = await cdpNavigate(port, wsPath, url);
  if (!ok) { log(`实例 ${id} 页面恢复失败：CDP 导航未成功`); return; }
  setTimeout(async () => {
    try {
      const t2 = ((await httpGetJson(port, '/json/list')) || []).filter((t) => t.type === 'page');
      const cur = (t2.find((t) => t.id === target.id) || t2[0] || {}).url || '';
      if (cur.startsWith(url.split('#')[0])) log(`实例 ${id} 页面恢复确认: ${url.slice(0, 90)}`);
      else log(`实例 ${id} 页面恢复未确认，当前: ${cur.slice(0, 90)}`);
    } catch (_) { log(`实例 ${id} 页面恢复复核失败`); }
  }, 4000);
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
  // 只绑回环：外部流量必须经 webconsole /opsbox/* 代理（入口统一校验一次）
  const child = spawn('python3', ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8002'], {
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
      restoreInstancePage(id).catch(() => {});
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
        restoreInstancePage(id).catch(() => {});
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
    // Chrome 会把自身 cmdline 重写成空格分隔，这里同时按空格与 NUL 截断，避免把参数并入实例 id
    const m = cmd.match(/browser-profiles-v2\/([^/\s\0]+)/);
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
  try { sampleMemory(); } catch (e) { log('mem-sample err:', e.message); }
  try { trimNetlog(); } catch (e) { log('netlog-trim err:', e.message); }
  try { await ensureXvfb(); } catch (e) { log('xvfb err:', e.message); }
  let activeList = null;
  try { activeList = await ensureClient(); } catch (e) { log('client err:', e.message); }
  if (activeList === null) {
    const r = await localApi('GET', '/api/browser/active', null, 5000);
    if (r && r.code === 0) activeList = (r.data && r.data.list) || [];
  }
  try { await ensureConsole(); } catch (e) { log('console err:', e.message); }
  try { await ensureOpsbox(); } catch (e) { log('opsbox err:', e.message); }
  try { await reconcileNames(); } catch (e) { log('names err:', e.message); }
  try { memAvailableAlert(); } catch (e) { log('mem-alert err:', e.message); }
  if (activeList) { try { await ensureInstances(activeList); } catch (e) { log('inst err:', e.message); } }
  try { await memoryGuard(); } catch (e) { log('mem err:', e.message); }
}

if (process.env.KEEPER_RESTORE_ONLY) {
  // 测试钩子：KEEPER_RESTORE_ONLY=<实例id> 只执行页面恢复然后退出，不进巡检循环
  restoreInstancePage(String(process.env.KEEPER_RESTORE_ONLY)).then(() => process.exit(0), () => process.exit(1));
} else {
  log('keeper 启动，巡检间隔', LOOP_SEC + 's');
  ensureInstanceCgroup();
  ensureSwap();
  seedState().catch(() => {});
  loop();
  setInterval(loop, LOOP_SEC * 1000);
}
