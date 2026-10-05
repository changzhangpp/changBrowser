'use strict';

// Web 控制台自测：登录/鉴权/聚合/随机指纹/刷新配置/守护规则/opsbox 代理。
// 运行：npm run selftest:webconsole

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-webconsole-test-'));
const MOCK_API_PORT = 25101;
process.env.KEEPER_MARK_DISABLE = '1'; // 自测禁写真实 keeper-state.json
const FAKE_OPSBOX_PORT = 25102;
const CONSOLE_PORT = 25103;

process.env.OPENBROWSER_API_PORT = String(MOCK_API_PORT);
process.env.OPENBROWSER_OPSBOX_PORT = String(FAKE_OPSBOX_PORT);
process.env.OPENBROWSER_USER_DATA = path.join(TMP, 'userdata');
process.env.OPENBROWSER_CONSOLE_PORT = String(CONSOLE_PORT);
process.env.CONSOLE_PASSWORD = 'test-pass';

const captured = { updates: [], stopped: [] };
const capturedCreates = [];

function ok(data) {
  return JSON.stringify({ code: 0, msg: 'success', data });
}

// ---- mock Local API ----
const mockApi = http.createServer((req, res) => {
  if (req.headers['api-key'] !== 'test-key') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: -1, msg: 'unauthorized' }));
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/getVersion')) return res.end(ok({ version: '1.0.23-test' }));
    if (req.url.startsWith('/api/v1/user/list')) {
      return res.end(ok({ list: [{ user_id: 'p1', name: 'Profile 1', number: 1, status: 'Inactive' }] }));
    }
    if (req.url.startsWith('/api/browser/active')) {
      return res.end(ok({ list: [{ user_id: 'p1', debug_port: 9333, profile_directory: '/data/profiles/p1' }] }));
    }
    if (req.url.startsWith('/api/v2/browser-profile/update')) {
      captured.updates.push(JSON.parse(raw || '{}'));
      return res.end(ok({ updated: true }));
    }
    if (req.url.startsWith('/api/v2/browser-profile/create')) {
      capturedCreates.push(JSON.parse(raw || '{}'));
      return res.end(ok({ user_id: `new-${capturedCreates.length}`, id: `new-${capturedCreates.length}` }));
    }
    if (req.url.startsWith('/api/browser/stop')) {
      const body = JSON.parse(raw || '{}');
      captured.stopped.push(body.profile_id);
      return res.end(ok({ stopped: true }));
    }
    if (req.url.startsWith('/api/v1/user/delete')) {
      return res.end(ok({ deleted: JSON.parse(raw || '{}').user_ids }));
    }
    if (req.url.startsWith('/api/v2/browser-profile/duplicate')) {
      return res.end(ok({ user_id: 'copy-1' }));
    }
    if (req.url.startsWith('/api/browser/start')) return res.end(ok({ started: true }));
    if (req.url.startsWith('/api/v1/user/detail')) return res.end(ok({ name: 'Profile 1', status: 'Inactive' }));
    if (req.url.startsWith('/api/fingerprint')) return res.end(ok({ userAgent: 'x', resolution: '1x1' }));
    res.end(JSON.stringify({ code: -1, msg: 'not found' }));
  });
});

// ---- fake opsbox ----
const fakeOpsbox = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ opsbox: true, path: req.url, auth: req.headers['x-auth-token'] || null, body: raw }));
  });
});

// ---- fake CDP endpoint for refresher ----
const cdpTargets = [];
const fakeCdp = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([
    { type: 'page', webSocketDebuggerUrl: 'ws://cdp/a' },
    { type: 'page', webSocketDebuggerUrl: 'ws://cdp/b' },
    { type: 'iframe', webSocketDebuggerUrl: 'ws://cdp/c' },
  ]));
});

function reqTo(port, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (_) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: out });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await new Promise((r) => mockApi.listen(MOCK_API_PORT, r));
  await new Promise((r) => fakeOpsbox.listen(FAKE_OPSBOX_PORT, r));
  await new Promise((r) => fakeCdp.listen(25104, r));

  const { ConsoleServer, makeToken, verifyToken } = require('../webconsole/server');
  const { generatePersona, personaToUpdatePayload, isConsistent } = require('../webconsole/fingerprint');
  const { Refresher } = require('../webconsole/refresher');
  const { Guard, scanProc } = require('../webconsole/guard');

  // ===== 1. 随机指纹一致性（设计 Correctness 5）=====
  for (let i = 0; i < 50; i++) {
    const p = generatePersona();
    assert.ok(isConsistent(p), `persona consistent round ${i}`);
    const payload = personaToUpdatePayload(p);
    assert.ok(payload.userAgent && payload.windowSize && payload.privacy.fingerprint.seed);
    if (p.family === 'windows') {
      assert.ok(payload.userAgent.includes('Windows NT') && payload.platform === 'Win32');
    } else if (p.family === 'macos') {
      assert.ok(payload.userAgent.includes('Mac OS X') && payload.platform === 'MacIntel');
    } else {
      assert.ok(payload.userAgent.includes('Android') && payload.userAgent.includes('Mobile'));
    }
  }
  console.log('[1] 随机指纹一致性 x50 通过');

  // ===== 2. Guard：/proc 扫描 + rss_limit 触发 + JSONL 日志 + 终止回调 =====
  const procRoot = path.join(TMP, 'proc');
  const mkPid = (pid, marker, rssKb, ticks) => {
    const dir = path.join(procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmdline'), `chrome --user-data-dir=${marker}\0--x`);
    fs.writeFileSync(path.join(dir, 'status'), `Name: chrome\nVmRSS:\t${rssKb} kB`);
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (chrome) S 1 0 0 0 0 0 0 0 0 0 0 ${ticks} 0 0 0 0\n`);
  };
  mkPid(101, '/data/profiles/p1', 1900 * 1024, 100); // ~1900MB 超默认 1536MB
  mkPid(102, '/data/profiles/p1', 100 * 1024, 50);
  mkPid(103, '/data/profiles/other', 900 * 1024, 10); // 其他实例，不应干扰
  const found = scanProc(procRoot, '/data/profiles/p1');
  assert.strictEqual(found.length, 2);

  const guardLog = path.join(TMP, 'guard.log');
  const guard = new Guard({
    procRoot,
    logFile: guardLog,
    onTerminate: async (id) => ({ ok: true, id }),
    config: { rssLimitMb: 1536 }, // 显式阈值：生产默认已放宽到 4096（见 guard.js DEFAULTS 注释）
  });
  const triggered = await guard.sampleOnce([{ id: 'p1', profileDirectory: '/data/profiles/p1' }]);
  assert.strictEqual(triggered.length, 1);
  assert.strictEqual(triggered[0].rule, 'rss_limit');
  assert.deepStrictEqual(captured.stopped, []); // Guard 自身 onTerminate 为桩
  const logged = fs.readFileSync(guardLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(logged.some((e) => e.kind === 'guard-trigger' && e.rule === 'rss_limit' && e.metrics.rssMb >= 1900));
  assert.ok(guard.recentEvents().length >= 2);
  console.log('[2] Guard rss_limit 规则 + 日志 通过');

  // ===== 3. Guard：proc_count 与 growth 规则 =====
  const guard2 = new Guard({ procRoot, logFile: path.join(TMP, 'guard2.log'), config: { procLimit: 1, rssLimitMb: 999999 } });
  const t2 = await guard2.sampleOnce([{ id: 'p2', profileDirectory: '/data/profiles/p1' }]);
  assert.strictEqual(t2[0].rule, 'proc_count');

  const guard3 = new Guard({
    procRoot, logFile: path.join(TMP, 'guard3.log'),
    config: { rssLimitMb: 999999, growthPctPerMin: 15, growthWindows: 2, sampleSec: 5 },
  });
  let now = 1000000;
  guard3.clock = () => now;
  // 窗口1: 100MB → 起点记录
  await guard3.sampleOnce([{ id: 'p3', profileDirectory: '/data/profiles/p1' }]);
  // 模拟 RSS 增长：直接改写 fixture
  fs.writeFileSync(path.join(procRoot, '101', 'status'), 'Name: chrome\nVmRSS:\t4000 * 1024 kB'.replace('4000 * 1024', String(4000 * 1024)));
  now += 61000;
  const t3a = await guard3.sampleOnce([{ id: 'p3', profileDirectory: '/data/profiles/p1' }]);
  assert.strictEqual(t3a.length, 0, 'growth 窗口1 仅累计');
  // 再次增长窗口
  fs.writeFileSync(path.join(procRoot, '101', 'status'), `Name: chrome\nVmRSS:\t${6000 * 1024} kB`);
  now += 61000;
  const t3b = await guard3.sampleOnce([{ id: 'p3', profileDirectory: '/data/profiles/p1' }]);
  assert.strictEqual(t3b.length, 1, 'growth 连续窗口触发');
  assert.strictEqual(t3b[0].rule, 'growth');
  console.log('[3] Guard proc_count / growth 规则 通过');

  // ===== 4. Refresher：配置持久化 + active 标签刷新 + 熔断 =====
  const refConfigFile = path.join(TMP, 'refresh-config.json');
  const refresher = new Refresher({
    configFile: refConfigFile,
    localApiBase: `http://127.0.0.1:${MOCK_API_PORT}`,
    apiKey: 'test-key',
    reloadFn: async () => true,
  });
  let cfg = refresher.setConfig('p1', { intervalSec: 3, enabled: true, scope: 'active' });
  assert.strictEqual(cfg.enabled, false, '间隔<5s 强制不启用');
  cfg = refresher.setConfig('p1', { intervalSec: 10, enabled: true, scope: 'active' });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(refConfigFile, 'utf8')).p1.intervalSec, 10, '配置持久化');

  refresher.active = new Map([['p1', 25104]]);
  const fired = [];
  refresher.reloadFn = async (wsUrl) => { fired.push(wsUrl); return true; };
  await refresher.tick(); // 立即触发一次
  assert.strictEqual(fired.length, 1, 'scope=active 仅刷新首个 page 目标');
  await refresher.tick();
  assert.strictEqual(fired.length, 1, '间隔内未重复触发');
  for (const key of [...refresher.lastFire.keys()]) {
    if (key.startsWith('p1|')) refresher.lastFire.delete(key);
  }
  refresher.setConfig('p1', { scope: 'all' });
  await refresher.tick();
  assert.strictEqual(fired.length, 3, 'scope=all 刷新全部 page 目标（2 页面）');
  const windowCfg = refresher.setWindowConfig('p1', 'ws://cdp/a', { intervalSec: 20, enabled: true });
  assert.strictEqual(windowCfg.intervalSec, 20, '窗口级间隔保存');
  const decorated = refresher.decorateTargets('p1', [
    { id: 'ws://cdp/a', url: 'about:blank' },
    { id: 'ws://cdp/b', url: 'about:blank' },
  ]);
  assert.strictEqual(decorated[0].refresh.source, 'window', '窗口级配置优先');
  assert.strictEqual(decorated[1].refresh.source, 'instance', '未设置窗口继承实例级配置');
  refresher.clearWindowConfig('p1', 'ws://cdp/a');

  // 熔断：连续失败 3 次
  const errLog = path.join(TMP, 'refresh-errors.log');
  let retryClock = 100000;
  const refresher2 = new Refresher({
    configFile: path.join(TMP, 'rc2.json'), errorLogFile: errLog,
    localApiBase: `http://127.0.0.1:${MOCK_API_PORT}`, apiKey: 'test-key',
    clock: () => retryClock,
    reloadFn: async () => { throw new Error('boom'); },
  });
  refresher2.setConfig('p9', { intervalSec: 5, enabled: true });
  refresher2.active = new Map([['p9', 25104]]);
  for (let i = 0; i < 3; i++) {
    for (const key of [...refresher2.lastFire.keys()]) {
    if (key.startsWith('p9|')) refresher2.lastFire.delete(key);
    }
    retryClock += 30000;
    await refresher2.tick();
  }
  assert.ok(refresher2.paused.has('p9'), '连续 3 次失败后熔断');
  assert.ok(fs.readFileSync(errLog, 'utf8').includes('retry scheduled automatically'));
  retryClock += 30000;
  await refresher2.tick();
  assert.strictEqual(refresher2.paused.has('p9'), false, '熔断后自动恢复重试');
  console.log('[4] Refresher 配置/范围/退避恢复 通过');

  // ===== 5. Token =====
  const secretBuf = Buffer.from('0123456789abcdef');
  const token = makeToken(secretBuf, () => 1000000);
  assert.ok(verifyToken(secretBuf, token, () => 1000001));
  assert.ok(!verifyToken(secretBuf, token, () => 1000000 + 31 * 24 * 3600 * 1000), '过期拒绝');
  assert.ok(!verifyToken(secretBuf, token + 'x', () => 1000001), '篡改拒绝');
  console.log('[5] Token 签发/校验 通过');

  // ===== 6. 控制台服务端到端 =====
  const app = new ConsoleServer({ apiKey: 'test-key' });
  const server = await app.listen(0);
  const port = server.address().port;

  // 未认证 → 401
  const noAuth = await reqTo(port, 'GET', '/api/console/profiles');
  assert.strictEqual(noAuth.status, 401);
  assert.ok(!JSON.stringify(noAuth.json).includes('Profile 1'), '未认证响应不含实例数据');

  // 登录
  const badLogin = await reqTo(port, 'POST', '/api/console/login', { body: { password: 'wrong' } });
  assert.strictEqual(badLogin.status, 401);
  const login = await reqTo(port, 'POST', '/api/console/login', { body: { password: 'test-pass' } });
  assert.strictEqual(login.status, 200);
  const token1 = login.json.data.token;
  const auth = { 'x-console-token': token1 };

  // status
  const status = await reqTo(port, 'GET', '/api/console/status', { headers: auth });
  assert.strictEqual(status.json.data.localApi, true);
  assert.strictEqual(status.json.data.opsbox, true);

  // profiles 聚合
  const profiles = await reqTo(port, 'GET', '/api/console/profiles', { headers: auth });
  assert.strictEqual(profiles.json.data.list[0].id, 'p1');
  assert.strictEqual(profiles.json.data.list[0].status, 'Active');
  assert.strictEqual(profiles.json.data.list[0].debugPort, 9333);

  // 详情
  const detail = await reqTo(port, 'GET', '/api/console/profiles/p1', { headers: auth });
  assert.strictEqual(detail.json.data.profile.name, 'Profile 1');

  // 更新白名单
  const upd = await reqTo(port, 'POST', '/api/console/profiles/p1', {
    headers: auth, body: { name: 'NewName', evilKey: 'x' },
  });
  assert.strictEqual(upd.status, 200);
  const sentUpdate = captured.updates[captured.updates.length - 1];
  assert.strictEqual(sentUpdate.name, 'NewName');
  assert.ok(!('evilKey' in sentUpdate), '白名单外字段被丢弃');

  // 随机指纹
  const rnd = await reqTo(port, 'POST', '/api/console/profiles/p1/random-fingerprint', { headers: auth });
  assert.strictEqual(rnd.status, 200);
  assert.ok(rnd.json.data.summary.seed);
  assert.strictEqual(rnd.json.data.takesEffectNextStart, true);
  const rndPayload = captured.updates[captured.updates.length - 1];
  assert.ok(rndPayload.userAgent && rndPayload.privacy.fingerprint.seed);

  // 刷新配置 API
  const refPut = await reqTo(port, 'PUT', '/api/console/profiles/p1/refresh', {
    headers: auth, body: { intervalSec: 30, scope: 'active', enabled: true },
  });
  assert.strictEqual(refPut.json.data.enabled, true);
  const refGet = await reqTo(port, 'GET', '/api/console/profiles/p1/refresh', { headers: auth });
  assert.strictEqual(refGet.json.data.intervalSec, 30);
  const winPut = await reqTo(port, 'PUT', '/api/console/profiles/p1/refresh/window/window-a', {
    headers: auth, body: { intervalSec: 45, enabled: true },
  });
  assert.strictEqual(winPut.json.data.intervalSec, 45);
  const winGet = await reqTo(port, 'GET', '/api/console/profiles/p1/refresh/window/window-a', { headers: auth });
  assert.strictEqual(winGet.json.data.intervalSec, 45);

  // 守护配置 API
  const guardPut = await reqTo(port, 'PUT', '/api/console/guard', {
    headers: auth, body: { rssLimitMb: 2048 },
  });
  assert.strictEqual(guardPut.json.data.rssLimitMb, 2048);
  const guardGet = await reqTo(port, 'GET', '/api/console/guard', { headers: auth });
  assert.strictEqual(guardGet.json.data.rssLimitMb, 2048);

  // 守护事件
  const events = await reqTo(port, 'GET', '/api/console/guard/events', { headers: auth });
  assert.ok(Array.isArray(events.json.data.events));

  // opsbox 代理
  const proxied = await reqTo(port, 'POST', '/opsbox/api/list?path=/tmp', {
    headers: { ...auth, 'x-auth-token': 'ops-token' }, body: { q: 'x' },
  });
  assert.strictEqual(proxied.json.opsbox, true);
  assert.strictEqual(proxied.json.path, '/api/list?path=/tmp', '前缀剥离');
  assert.strictEqual(proxied.json.auth, 'ops-token', '鉴权头透传');

  // 登录限流（最后一个测试，避免影响其他用例）
  for (let i = 0; i < 10; i++) {
    await reqTo(port, 'POST', '/api/console/login', { body: { password: 'nope' } });
  }
  const limited = await reqTo(port, 'POST', '/api/console/login', { body: { password: 'test-pass' } });
  assert.strictEqual(limited.status, 429, '失败 10 次后限流');
  console.log('[6] 控制台端到端（鉴权/聚合/更新/随机指纹/刷新/守护/代理/限流）通过');

  // ===== 7. targets / 批量 / 导入导出 / oplog / SSO =====
  const targets = await reqTo(port, 'GET', '/api/console/profiles/p1/targets', { headers: auth });
  assert.strictEqual(targets.status, 200);

  const batch = await reqTo(port, 'POST', '/api/console/profiles/batch', {
    headers: auth, body: { prefix: 'Batch', count: 2 },
  });
  assert.strictEqual(batch.status, 200);
  assert.strictEqual(capturedCreates.length, 2, '批量创建调用 create 两次');
  assert.ok(capturedCreates.every((c) => c.name.startsWith('Batch')));

  const imp = await reqTo(port, 'POST', '/api/console/profiles/import', {
    headers: auth, body: { profiles: [{ name: 'Imported 1', startUrl: 'https://a.com', evil: 1 }] },
  });
  assert.strictEqual(imp.json.data.ok, 1);
  const imported = capturedCreates[capturedCreates.length - 1];
  assert.strictEqual(imported.name, 'Imported 1');
  assert.ok(!('evil' in imported), '白名单外字段被丢弃');

  const ex = await reqTo(port, 'GET', '/api/console/profiles/export', { headers: auth });
  assert.ok(ex.raw.includes('profiles'), '导出包含 profiles');

  const oplog = await reqTo(port, 'GET', '/api/console/oplog', { headers: auth });
  assert.ok(Array.isArray(oplog.json.data.ops));

  const del = await reqTo(port, 'DELETE', '/api/console/profiles/p1', { headers: auth });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(captured.stopped, []);
  console.log('[7] targets/批量/导入/导出/日志/删除 接口 通过');

  // ===== 8. WebSocket 桥（最小 CDP 对端）=====
  const { WsConnection, handshake: wsHandshake, encodeFrame } = require('../webconsole/ws-bridge');
  const cdpWsPort = 25105;
  let upstreamReceived = [];
  const wsc = new Map(); // 客户端 socket -> frames
  const cdpWsServer = http.createServer(() => {});
  cdpWsServer.on('upgrade', (req, sock) => {
    assert.ok(wsHandshake(req, sock));
    const silent = (req.url || '').includes('tgt-silent');
    const conn = new WsConnection(sock);
    conn.onMessage = (text) => {
      const m = JSON.parse(text);
      upstreamReceived.push(m);
      if (silent) return;
      if (m.id) conn.sendText(JSON.stringify({ id: m.id, result: { value: '1' } }));
      // 回一条 CDP 事件模拟 screencastFrame
      conn.sendText(JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'ZmFrZQ==' } }));
    };
  });
  await new Promise((r) => cdpWsServer.listen(cdpWsPort, r));
  // 让 refresher.active 指向 mock CDP 端口
  app.refresher.active.set('p1', cdpWsPort);

  const clientFrameBuf = { buf: Buffer.alloc(0), messages: [] };
  await new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect(cdpWsPort, '127.0.0.1', () => {
      const key = require('crypto').randomBytes(16).toString('base64');
      sock.write(`GET /cdp/p1/tgt-1?token=${encodeURIComponent(token1)} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshook = false;
    sock.on('data', (chunk) => {
      clientFrameBuf.buf = Buffer.concat([clientFrameBuf.buf, chunk]);
      if (!handshook) {
        const idx = clientFrameBuf.buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = clientFrameBuf.buf.slice(0, idx).toString();
        assert.ok(head.includes('101'), 'WS 升级成功');
        clientFrameBuf.buf = clientFrameBuf.buf.slice(idx + 4);
        handshook = true;
        // 发送一条掩码文本帧
        const payload = Buffer.from(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
        const mask = require('crypto').randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        const header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
        sock.write(Buffer.concat([header, masked]));
      }
      // 解析服务端帧（无掩码）
      for (;;) {
        const b = clientFrameBuf.buf;
        if (b.length < 2) break;
        const len0 = b[1] & 0x7f;
        let off = 2;
        let len = len0;
        if (len0 === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) break;
        if ((b[0] & 0x0f) === 0x1) {
          clientFrameBuf.messages.push(JSON.parse(b.slice(off, off + len).toString()));
        }
        clientFrameBuf.buf = b.slice(off + len);
      }
      if (clientFrameBuf.messages.length >= 1) {
        try { sock.destroy(); } catch (_) {}
        resolve();
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('ws bridge timeout')), 8000);
  });
  assert.ok(upstreamReceived.some((m) => m.method === 'Page.enable'), '上游收到客户端消息');
  assert.ok(clientFrameBuf.messages.some((m) => m.method === 'Page.screencastFrame'), '客户端收到上游事件');
  console.log('[8] WebSocket 桥（掩码解析/上游管道/事件回传）通过');

  // ===== 9. 渲染看门狗（探测/卡死恢复）=====
  app.hangProbeTimeoutMs = 400;
  const alive = await app.probePageAlive(cdpWsPort, 'tgt-1');
  assert.ok(alive, '正常页面探测存活');
  const hung = await app.probePageAlive(cdpWsPort, 'tgt-silent');
  assert.ok(!hung, '无响应页面判定卡死');

  const hangHttpHits = [];
  const hangCdp = http.createServer((req, res) => {
    hangHttpHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/list') {
      return res.end(JSON.stringify([{ type: 'page', id: 'tgt-hang', url: 'https://heavy.example/login' }]));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => hangCdp.listen(25106, r));
  app.refresher.active.set('p1', 25106);
  await app.hangSweep();
  await app.hangSweep();
  await app.hangSweep();
  assert.deepStrictEqual(hangHttpHits.filter((h) => h.includes('/json/close')), [], '看门狗绝不关闭用户页面');
  assert.deepStrictEqual(hangHttpHits.filter((h) => h.includes('/json/new')), [], '看门狗绝不重建页面');
  const unp = await app.unpauseTarget(cdpWsPort, 'tgt-1');
  assert.ok(unp, '解冻命令序列生效');
  cdpWsServer.close();
  hangCdp.close();
  console.log('[9] 渲染看门狗（探测/解冻/仅记录不杀页）通过');

  await app.close();
  [mockApi, fakeOpsbox, fakeCdp].forEach((s) => s.close());
  console.log('\nAll webconsole self-tests passed');
}

main().catch((error) => {
  console.error('SELFTEST FAILED:', error);
  process.exit(1);
});
