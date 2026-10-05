'use strict';

// OpenBrowser Web 控制台服务（零依赖）。
// - 单端口入口（默认 50327）：静态 UI + 控制台 API + opsbox 反向代理
// - 向前调用 Local API（默认 127.0.0.1:50325，api-key 认证）
// - 登录口令换 HMAC token（方案与 opsbox 一致），限流 10 次失败/分钟
// - 集成 Refresher（CDP 定时刷新）与 Guard（实例资源异常守护）

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { generatePersona, personaToUpdatePayload, isConsistent } = require('./fingerprint');
const { Refresher } = require('./refresher');
const { Guard } = require('./guard');
const { WsConnection, handshake, bridgeToCdp } = require('./ws-bridge');

const USER_DATA = process.env.OPENBROWSER_USER_DATA || path.join(os.homedir(), '.config', 'openbrowser');

// 控制台口令不写入仓库：优先环境变量，其次用户目录下的本地文件，最后占位值。
// 部署时设置 CONSOLE_PASSWORD 或写入 <userData>/console-password.txt。
function readPasswordFile() {
  try {
    const v = fs.readFileSync(path.join(USER_DATA, 'console-password.txt'), 'utf8').trim();
    if (v) return v;
  } catch (_) { /* ignore */ }
  return '';
}

const CONFIG = {
  port: Number(process.env.OPENBROWSER_CONSOLE_PORT || 50327),
  localApiBase: `http://127.0.0.1:${process.env.OPENBROWSER_API_PORT || 50325}`,
  opsboxHost: '127.0.0.1',
  opsboxPort: Number(process.env.OPENBROWSER_OPSBOX_PORT || 8002),
  opsboxDir: process.env.OPENBROWSER_OPSBOX_DIR || path.resolve(__dirname, '..', '..', 'opsbox'),
  password: process.env.CONSOLE_PASSWORD || readPasswordFile() || 'change-me',
  userData: USER_DATA,
  tokenTtlSec: 30 * 24 * 3600,
};

const CONSOLE_DIR = path.join(CONFIG.userData, 'console');
const LOG_DIR = path.join(CONFIG.userData, 'logs');

function ensureDirs() {
  fs.mkdirSync(CONSOLE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function secret() {
  fs.mkdirSync(CONSOLE_DIR, { recursive: true });
  const file = path.join(CONSOLE_DIR, '.secret');
  try {
    return fs.readFileSync(file);
  } catch (_) {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(file, s);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* ignore */ }
    return s;
  }
}

function makeToken(secretBuf, clock = Date.now) {
  const exp = String(Math.floor(clock() / 1000) + CONFIG.tokenTtlSec);
  const sig = crypto.createHmac('sha256', secretBuf).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

function verifyToken(secretBuf, token, clock = Date.now) {
  if (!token || token.indexOf('.') < 0) return false;
  const [exp, sig] = token.split('.', 2);
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < clock()) return false;
  const good = crypto.createHmac('sha256', secretBuf).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readApiKey() {
  const file = path.join(CONFIG.userData, 'local-api-key.txt');
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key && key !== 'PLACEHOLDER' && key !== 'CHANGE_ME') return key;
  } catch (_) { /* ignore */ }
  return '';
}

// keeper 期望存活登记：start=加入守护集合；stop/删除/guard处置=移除
function keeperMark(profileId, alive) {
  if (process.env.KEEPER_MARK_DISABLE) return;
  try {
    const file = path.join(CONSOLE_DIR, 'keeper-state.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* ignore */ }
    if (alive) j[profileId] = true;
    else delete j[profileId];
    fs.writeFileSync(file, JSON.stringify(j));
  } catch (e) {
    // 写失败绝不能静默：否则「停止」被 keeper 当成死亡，实例会被自动拉起
    try {
      fs.appendFileSync(path.join(LOG_DIR, 'console-ops.log'),
        JSON.stringify({ ts: Date.now(), kind: 'keeper-mark-failed', profileId, alive, error: String((e && e.message) || e) }) + '\n');
    } catch (_) { /* ignore */ }
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---- Local API client ----

function localApiCall(method, pathname, body, apiKey, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, CONFIG.localApiBase);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...(apiKey ? { 'api-key': apiKey } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (_) {
          resolve({ status: res.statusCode, body: { code: -1, msg: `bad json: ${data.slice(0, 120)}` } });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('local api timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- opsbox reverse proxy ----

function proxyOpsbox(req, res) {
  const upstream = http.request({
    host: CONFIG.opsboxHost,
    port: CONFIG.opsboxPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${CONFIG.opsboxHost}:${CONFIG.opsboxPort}` },
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><div><h2>opsbox 服务不可用</h2><p>运维工作台进程未运行或正在启动，请稍后重试。</p></div></body></html>');
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

// ---- Console server ----

class ConsoleServer {
  constructor(options = {}) {
    this.config = { ...CONFIG, ...options };
    this.secretBuf = this.config.secretBuf || secret();
    this.apiKey = this.config.apiKey !== undefined ? this.config.apiKey : readApiKey();
    this.loginFailures = [];
    this.server = null;

    this.castPool = new Map();
    this.hangFails = new Map(); // profileId/targetId -> consecutive probe failures
    this.hangProbeTimeoutMs = 4000;
    this.refresher = new Refresher({
      localApiBase: this.config.localApiBase,
      apiKey: this.apiKey,
      configFile: path.join(CONSOLE_DIR, 'refresh-config.json'),
      errorLogFile: path.join(LOG_DIR, 'refresh-errors.log'),
    });
    this.guard = new Guard({
      config: options.guardConfig,
      procRoot: options.procRoot || '/proc',
      logFile: path.join(LOG_DIR, 'instance-guard.log'),
      onTerminate: async (profileId) => {
        const res = await localApiCall('POST', '/api/browser/stop', { profile_id: profileId }, this.apiKey);
        keeperMark(profileId, false);
        return { ok: res.status === 200 && res.body && res.body.code === 0, body: res.body };
      },
    });
  }

  guardStoreFile() {
    return path.join(CONSOLE_DIR, 'guard-config.json');
  }

  loadGuardConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.guardStoreFile(), 'utf8'));
    } catch (_) {
      return {};
    }
  }

  saveGuardConfig(config) {
    fs.mkdirSync(CONSOLE_DIR, { recursive: true });
    const tmp = `${this.guardStoreFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, this.guardStoreFile());
    return config;
  }

  authOk(req) {
    const header = req.headers['x-console-token'];
    let token = header || '';
    if (!token) {
      const cookie = req.headers.cookie || '';
      const m = cookie.match(/(?:^|;\s*)console_token=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    return verifyToken(this.secretBuf, token);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/opsbox/sso-token') return this.handleOpsboxSso(req, res);
    if (pathname.startsWith('/opsbox/')) {
      req.url = pathname.slice('/opsbox'.length) + url.search || '/';
      return proxyOpsbox(req, res);
    }

    if (pathname === '/api/console/login' && req.method === 'POST') {
      return this.handleLogin(req, res);
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/app') {
      const file = path.join(__dirname, 'public', 'index.html');
      try {
        const html = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      } catch (_) {
        res.writeHead(500);
        return res.end('ui missing');
      }
    }

    if (!this.authOk(req)) {
      return sendJson(res, 401, { code: 401, msg: 'unauthorized' });
    }

    try {
    if (pathname === '/api/console/status') return await this.handleStatus(req, res);
    if (pathname.startsWith('/api/console/proxies/')) return await this.handleProxies(req, res, pathname);
      if (pathname === '/api/console/oplog') return this.handleOplog(req, res);
      if (pathname === '/api/console/profiles') return await this.handleProfiles(req, res);
      if (pathname === '/api/console/profiles/batch' && req.method === 'POST') return await this.handleBatchCreate(req, res);
      if (pathname === '/api/console/profiles/import' && req.method === 'POST') return await this.handleImport(req, res);
      if (pathname === '/api/console/profiles/export' && req.method === 'GET') return await this.handleExport(req, res);
      let       m = pathname.match(/^\/api\/console\/profiles\/([^/]+)\/random-fingerprint$/);
      if (m) return await this.handleRandomFingerprint(req, res, decodeURIComponent(m[1]));
      if (pathname === '/api/console/fingerprint-random') {
        const persona = generatePersona();
        return sendJson(res, 200, { code: 0, data: persona });
      }
      m = pathname.match(/^\/api\/console\/profiles\/([^/]+)\/(start|stop)$/);
      if (m) return await this.handleStartStop(req, res, decodeURIComponent(m[1]), m[2]);
      m = pathname.match(/^\/api\/console\/profiles\/([^/]+)\/targets$/);
      if (m) return await this.handleTargets(req, res, decodeURIComponent(m[1]));
      m = pathname.match(/^\/api\/console\/profiles\/([^/]+)\/refresh\/window\/([^/]+)$/);
      if (m) return this.handleWindowRefreshConfig(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      m = pathname.match(/^\/api\/console\/profiles\/([^/]+)\/refresh$/);
      if (m) return this.handleRefreshConfig(req, res, decodeURIComponent(m[1]));
      m = pathname.match(/^\/api\/console\/profiles\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET') return await this.handleProfileDetail(req, res, id);
        if (req.method === 'POST' || req.method === 'PUT') {
          const payload = await this.readJsonBody(req);
          return await this.handleProfileUpdate(req, res, id, payload);
        }
        if (req.method === 'DELETE') return await this.handleProfileDelete(req, res, id);
        return sendJson(res, 405, { code: 405, msg: 'method not allowed' });
      }
      if (pathname === '/api/console/guard') return this.handleGuardConfig(req, res);
      if (pathname === '/api/console/guard/events') return this.handleGuardEvents(req, res);
      m = pathname.match(/^\/api\/cast\/shot\/([^/]+)\/([^/]+)$/);
      if (m) return await this.handleCastShot(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      m = pathname.match(/^\/api\/cast\/cmd\/([^/]+)\/([^/]+)$/);
      if (m) {
        const body = await this.readJsonBody(req);
        return await this.handleCastCmd(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]), body);
      }
      return sendJson(res, 404, { code: 404, msg: 'not found' });
    } catch (error) {
      return sendJson(res, 502, { code: 502, msg: `upstream error: ${error.message}` });
    }
  }

  readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async readJsonBody(req) {
    const raw = await this.readBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
  }

  handleLogin(req, res) {
    return this.readJsonBody(req).then((body) => {
      const now = Date.now();
      this.loginFailures = this.loginFailures.filter((t) => now - t < 60000);
      if (this.loginFailures.length >= 10) {
        return sendJson(res, 429, { code: 429, msg: '尝试过于频繁，请稍后再试' });
      }
      const pass = String(body.password || '');
      const okPass = pass.length === this.config.password.length
        && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(this.config.password));
      if (!okPass) {
        this.loginFailures.push(now);
        return sendJson(res, 401, { code: 401, msg: '口令错误' });
      }
      this.loginFailures = [];
      const token = makeToken(this.secretBuf);
      res.setHeader('Set-Cookie', `console_token=${encodeURIComponent(token)}; Path=/; Max-Age=${CONFIG.tokenTtlSec}; HttpOnly; SameSite=Lax`);
      return sendJson(res, 200, { code: 0, msg: 'success', data: { token } });
    }).catch((error) => sendJson(res, 400, { code: 400, msg: error.message }));
  }

  async handleStatus(req, res) {
    let localApi = false;
    try {
      const r = await localApiCall('GET', '/api/getVersion', undefined, this.apiKey);
      localApi = r.status === 200 && r.body && r.body.code === 0;
    } catch (_) { /* down */ }
    let opsbox = false;
    await new Promise((resolve) => {
      const reqOps = http.get({ host: this.config.opsboxHost, port: this.config.opsboxPort, path: '/', timeout: 1500 }, (r2) => {
        opsbox = r2.statusCode < 500;
        r2.resume();
        resolve();
      });
      reqOps.on('timeout', () => { reqOps.destroy(); resolve(); });
      reqOps.on('error', () => resolve());
    });
    return sendJson(res, 200, {
      code: 0,
      data: {
        localApi,
        opsbox,
        apiKeyConfigured: Boolean(this.apiKey),
        guardEnabled: Boolean(this.guard.config.enabled),
      },
    });
  }

  async handleProfiles(req, res) {
    const [listRes, activeRes] = await Promise.all([
      localApiCall('GET', '/api/v1/user/list', undefined, this.apiKey),
      localApiCall('GET', '/api/browser/active', undefined, this.apiKey),
    ]);
    if (listRes.status === 401 || activeRes.status === 401) {
      return sendJson(res, 502, { code: 502, msg: '本地 API 鉴权失败：api-key 不匹配' });
    }
    if (listRes.body.code !== 0) {
      return sendJson(res, 502, { code: 502, msg: listRes.body.msg || '本地 API 不可用' });
    }
    this.refreshDetailsCache((listRes.body.data && listRes.body.data.list) || []).catch(() => {});
    const profiles = (listRes.body.data && listRes.body.data.list) || [];
    const activeMap = new Map();
    if (activeRes.body.code === 0) {
      for (const item of (activeRes.body.data && activeRes.body.data.list) || []) {
        activeMap.set(item.user_id, item);
      }
    }
    const refresh = this.refresher.status();
    const data = profiles.map((p) => {
      const id = p.user_id || p.profile_id;
      const active = activeMap.get(id);
      const extra = this.detailsCache.get(id) || {};
      return {
        id,
        name: p.name,
        number: p.number,
        status: active ? 'Active' : (p.status || 'Inactive'),
        debugPort: active ? active.debug_port : null,
        profileDirectory: active ? active.profile_directory : null,
        network: p.network || null,
        group: extra.group || '',
        remark: extra.remark || '',
        startUrl: extra.startUrl || '',
        userAgent: extra.userAgent || '',
        refresh: refresh[id] || null,
        guard: this.guard.snapshotFor(id),
      };
    });
    return sendJson(res, 200, { code: 0, data: { list: data } });
  }

  // 分组/备注/启动页等扩展字段：Local API 列表接口不含，按 30s 缓存并行拉详情
  async refreshDetailsCache(list) {
    const now = Date.now();
    if (this._detailsFetchedAt && now - this._detailsFetchedAt < 30000) return;
    this._detailsFetchedAt = now;
    if (!this.detailsCache) this.detailsCache = new Map();
    await Promise.all(list.map(async (p) => {
      const id = p.user_id || p.profile_id;
      if (!id) return;
      try {
        const detail = await localApiCall('POST', '/api/v1/user/detail', { user_id: id }, this.apiKey);
        if (detail.body.code !== 0) return;
        const inner = detail.body.data.profile || {};
        const priv = inner.privacy || {};
        this.detailsCache.set(id, {
          group: inner.group_name || '',
          remark: inner.note || '',
          startUrl: inner.startUrl || '',
          userAgent: inner.userAgent || '',
          windowSize: inner.width && inner.height ? `${inner.width}x${inner.height}` : '',
          timezone: priv.timezone || '',
          languageCode: inner.language || '',
          proxyRaw: typeof inner.proxy === 'string' ? inner.proxy : '',
        });
      } catch (_) { /* 单个失败忽略 */ }
    }));
  }

  async handleProfileDetail(req, res, id) {
    const detail = await localApiCall('POST', '/api/v1/user/detail', { user_id: id }, this.apiKey);
    let profile = (detail.body && detail.body.code === 0 && detail.body.data) || null;
    if (!profile) {
      const list = await this.handleProfilesListInternal();
      const found = list.find((item) => item.id === id);
      if (!found) return sendJson(res, 404, { code: 404, msg: 'profile not found' });
      profile = found;
    }
    const fp = await localApiCall('POST', '/api/fingerprint', { profile_id: id }, this.apiKey);
    // 扁平化：内层 profile 提供完整配置（分组/备注/尺寸/时区等）
    const inner = profile.profile || {};
    const priv = inner.privacy || {};
    const privFp = priv.fingerprint || {};
    const flat = {
      id,
      name: profile.name || inner.name,
      number: inner.number,
      status: profile.status,
      group: inner.group_name || '',
      remark: inner.note || '',
      startUrl: inner.startUrl || '',
      windowSize: inner.width && inner.height ? `${inner.width}x${inner.height}` : '',
      timezone: priv.timezone || '',
      languageCode: inner.language || '',
      userAgent: inner.userAgent || '',
      os: inner.os || '',
      webglVendor: privFp.webglVendor || priv.webglVendorValue || inner.webglVendor || '',
      webglRenderer: privFp.webglRenderer || priv.webglRendererValue || inner.webglRenderer || '',
      hardwareConcurrency: privFp.hardwareConcurrency || inner.hardwareConcurrency || '',
      deviceMemory: privFp.deviceMemory || inner.deviceMemory || '',
      doNotTrack: typeof priv.dnt === 'boolean' ? priv.dnt : '',
      proxyRaw: typeof inner.proxy === 'string' ? inner.proxy : '',
    };
    return sendJson(res, 200, {
      code: 0,
      data: {
        profile: flat,
        fingerprint: fp.body && fp.body.code === 0 ? fp.body.data : null,
        refresh: this.refresher.getConfig(id),
        guard: this.guard.snapshotFor(id),
      },
    });
  }

  async handleProfilesListInternal() {
    const listRes = await localApiCall('GET', '/api/v1/user/list', undefined, this.apiKey);
    return (listRes.body && listRes.body.code === 0 && listRes.body.data.list) || [];
  }

  async handleProfileUpdate(req, res, id, payload) {
    const allowed = new Set([
      'name', 'groupId', 'group_name', 'startUrl', 'windowSize', 'resolution', 'timezone',
      'locale', 'languageCode', 'userAgent', 'os', 'platform', 'webglVendor', 'webglRenderer',
      'hardwareConcurrency', 'deviceMemory', 'doNotTrack', 'privacy', 'proxy', 'note', 'tag',
    ]);
    const body = { profile_id: id };
    for (const [key, value] of Object.entries(payload || {})) {
      if (allowed.has(key)) body[key] = value;
    }
    const r = await localApiCall('POST', '/api/v2/browser-profile/update', body, this.apiKey);
    if (r.body.code !== 0) return sendJson(res, 400, { code: 400, msg: r.body.msg || 'update failed' });
    return sendJson(res, 200, { code: 0, msg: 'success', data: r.body.data });
  }

  async handleRandomFingerprint(req, res, id) {
    const restart = new URL(req.url, 'http://localhost').searchParams.get('restart') === '1';
    const persona = generatePersona();
    if (!isConsistent(persona)) {
      return sendJson(res, 500, { code: 500, msg: '生成的指纹未通过一致性校验，请重试' });
    }
    const payload = personaToUpdatePayload(persona);
    const updateRes = await localApiCall('POST', '/api/v2/browser-profile/update', { profile_id: id, ...payload }, this.apiKey);
    if (updateRes.body.code !== 0) {
      return sendJson(res, 400, { code: 400, msg: updateRes.body.msg || '随机指纹保存失败' });
    }
    let restarted = false;
    if (restart) {
      await localApiCall('POST', '/api/browser/stop', { profile_id: id }, this.apiKey, 20000);
      await new Promise((r) => setTimeout(r, 1500));
      const startRes = await localApiCall('POST', '/api/browser/start', { profile_id: id }, this.apiKey, 90000);
      restarted = startRes.body.code === 0;
    }
    return sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: {
        summary: {
          family: persona.family,
          os: persona.os,
          userAgent: persona.userAgent,
          windowSize: persona.windowSize,
          timezone: persona.timezone,
          language: persona.languageCode,
          webglRenderer: persona.webglRenderer,
          seed: persona.fingerprint.seed,
        },
        takesEffectNextStart: !restart,
        restarted,
      },
    });
  }

  async handleStartStop(req, res, id, action) {
    // stop 先摘除守护标记再停实例，避免 keeper 巡检落在间隙里把「刚停止」当「死亡」拉起
    if (action === 'stop') keeperMark(id, false);
    const r = await localApiCall('POST', `/api/browser/${action}`, { profile_id: id }, this.apiKey, action === 'start' ? 90000 : 20000);
    if (r.body.code !== 0) {
      if (action === 'stop') keeperMark(id, true); // 停止失败则恢复守护
      return sendJson(res, 400, { code: 400, msg: r.body.msg || `${action} failed` });
    }
    keeperMark(id, action === 'start');
    return sendJson(res, 200, { code: 0, msg: 'success', data: r.body.data });
  }

  handleRefreshConfig(req, res, id) {
    if (req.method === 'GET') {
      return sendJson(res, 200, { code: 0, data: this.refresher.getConfig(id) });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      return this.readJsonBody(req).then((body) => {
        const cfg = this.refresher.setConfig(id, body);
        return sendJson(res, 200, { code: 0, data: cfg });
      }).catch((error) => sendJson(res, 400, { code: 400, msg: error.message }));
    }
    return sendJson(res, 405, { code: 405, msg: 'method not allowed' });
  }

  handleWindowRefreshConfig(req, res, id, targetId) {
    const cfg = this.refresher.getConfig(id);
    if (req.method === 'GET') {
      return sendJson(res, 200, { code: 0, data: (cfg.windows && cfg.windows[targetId]) || null });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      return this.readJsonBody(req).then((body) => {
        if (body.inherit) {
          const next = this.refresher.clearWindowConfig(id, targetId);
          return sendJson(res, 200, { code: 0, data: next });
        }
        const next = this.refresher.setWindowConfig(id, targetId, body);
        return sendJson(res, 200, { code: 0, data: next });
      }).catch((error) => sendJson(res, 400, { code: 400, msg: error.message }));
    }
    return sendJson(res, 405, { code: 405, msg: 'method not allowed' });
  }

  handleGuardConfig(req, res) {
    if (req.method === 'GET') {
      return sendJson(res, 200, { code: 0, data: this.guard.config });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      return this.readJsonBody(req).then((body) => {
        const saved = this.saveGuardConfig(body);
        this.guard.configure(saved);
        return sendJson(res, 200, { code: 0, data: this.guard.config });
      }).catch((error) => sendJson(res, 400, { code: 400, msg: error.message }));
    }
    return sendJson(res, 405, { code: 405, msg: 'method not allowed' });
  }

  handleGuardEvents(req, res) {
    const limit = Math.min(200, Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 50));
    return sendJson(res, 200, { code: 0, data: { events: this.guard.recentEvents(limit) } });
  }

  // ---- 操作日志 ----

  logOp(kind, detail = {}) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, 'console-ops.log'),
        `${JSON.stringify({ ts: Date.now(), kind, ...detail })}\n`);
    } catch (_) { /* ignore */ }
  }

  handleOplog(req, res) {
    const file = path.join(LOG_DIR, 'console-ops.log');
    let ops = [];
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      ops = lines.slice(-200).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { /* empty */ }
    return sendJson(res, 200, { code: 0, data: { ops: ops.reverse() } });
  }

  // ---- opsbox 免密 SSO ----

  handleOpsboxSso(req, res) {
    if (!this.authOk(req)) return sendJson(res, 401, { code: 401, msg: 'unauthorized' });
    let secretBuf;
    try {
      secretBuf = fs.readFileSync(path.join(CONFIG.opsboxDir, '.secret'));
    } catch (_) {
      return sendJson(res, 503, { code: 503, msg: 'opsbox 未初始化（缺少 .secret）' });
    }
    const exp = String(Math.floor(Date.now() / 1000) + CONFIG.tokenTtlSec);
    const sig = crypto.createHmac('sha256', secretBuf).update(exp).digest('hex');
    this.logOp('opsbox-sso');
    return sendJson(res, 200, { code: 0, data: { token: `${exp}.${sig}` } });
  }

  // ---- 代理库透传 ----

  async handleProxies(req, res, pathname) {
    const sub = pathname.replace('/api/console/proxies', '');
    const map = {
      '/list': { method: 'GET', local: '/api/v2/proxy-list/list' },
      '/create': { method: 'POST', local: '/api/v2/proxy-list/create' },
      '/update': { method: 'POST', local: '/api/v2/proxy-list/update' },
      '/delete': { method: 'POST', local: '/api/v2/proxy-list/delete' },
      '/check': { method: 'POST', local: '/api/proxy/check' },
    };
    const route = map[sub];
    if (!route) return sendJson(res, 404, { code: 404, msg: 'not found' });
    const body = route.method === 'POST' ? await this.readJsonBody(req) : undefined;
    const r = await localApiCall(route.method, route.local, body, this.apiKey, 30000);
    return sendJson(res, r.status === 200 ? 200 : 502, r.body);
  }

  // ---- 批量创建 / 导入 / 导出 / 删除 ----

  async createProfile(payload) {
    const body = { profile_id: payload.profile_id || payload.id, ...payload };
    const r = await localApiCall('POST', '/api/v2/browser-profile/create', body, this.apiKey, 30000);
    if (r.body.code !== 0) throw new Error(r.body.msg || 'create failed');
    return r.body.data;
  }

  async handleBatchCreate(req, res) {
    const body = await this.readJsonBody(req);
    const count = Math.min(50, Math.max(1, Number(body.count) || 1));
    const prefix = String(body.prefix || 'Profile').trim() || 'Profile';
    const results = [];
    for (let i = 0; i < count; i++) {
      try {
        const created = await this.createProfile({
          name: `${prefix} ${i + 1}`,
          group_name: body.group_name || undefined,
          remark: body.remark || undefined,
          startUrl: body.startUrl || undefined,
        });
        results.push({ ok: true, id: created.user_id || created.id, name: `${prefix} ${i + 1}` });
      } catch (error) {
        results.push({ ok: false, error: error.message });
      }
    }
    this.logOp('batch-create', { count, ok: results.filter((r) => r.ok).length });
    return sendJson(res, 200, { code: 0, data: { results } });
  }

  async handleImport(req, res) {
    const body = await this.readJsonBody(req);
    const items = Array.isArray(body.profiles) ? body.profiles : Array.isArray(body) ? body : [];
    if (!items.length) return sendJson(res, 400, { code: 400, msg: '导入内容为空' });
    const allowed = new Set([
      'profile_id', 'id', 'name', 'title', 'group_name', 'remark', 'note', 'startUrl', 'start_url',
      'proxy', 'userAgent', 'user_agent', 'windowSize', 'resolution', 'timezone', 'languageCode',
      'locale', 'os', 'platform', 'webglVendor', 'webglRenderer', 'hardwareConcurrency',
      'deviceMemory', 'doNotTrack', 'privacy', 'number',
    ]);
    const results = [];
    for (const item of items) {
      const payload = {};
      for (const [k, v] of Object.entries(item || {})) {
        if (allowed.has(k) && v !== null && v !== undefined) payload[k] = v;
      }
      try {
        const created = await this.createProfile(payload);
        results.push({ ok: true, id: created.user_id || created.id });
      } catch (error) {
        results.push({ ok: false, error: error.message, name: payload.name });
      }
    }
    this.logOp('import', { total: items.length, ok: results.filter((r) => r.ok).length });
    return sendJson(res, 200, {
      code: 0,
      data: { total: items.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results },
    });
  }

  async handleExport(req, res) {
    const listRes = await localApiCall('GET', '/api/v1/user/list', undefined, this.apiKey);
    if (listRes.body.code !== 0) return sendJson(res, 502, { code: 502, msg: '本地 API 不可用' });
    const profiles = (listRes.body.data && listRes.body.data.list) || [];
    const details = [];
    for (const p of profiles) {
      const detail = await localApiCall('POST', '/api/v1/user/detail', { user_id: p.user_id }, this.apiKey);
      details.push(detail.body.code === 0 ? { ...detail.body.data, user_id: p.user_id } : p);
    }
    this.logOp('export', { count: details.length });
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), profiles: details }, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="openbrowser-profiles-${Date.now()}.json"`,
    });
    return res.end(payload);
  }

  async handleProfileDelete(req, res, id) {
    const r = await localApiCall('POST', '/api/v1/user/delete', { user_ids: [id], delete_data: true }, this.apiKey, 30000);
    if (r.body.code !== 0) return sendJson(res, 400, { code: 400, msg: r.body.msg || 'delete failed' });
    keeperMark(id, false);
    this.logOp('delete', { id });
    return sendJson(res, 200, { code: 0, msg: 'success', data: r.body.data });
  }

  // ---- 实例标签页（CDP targets）----

  async resolveDebugPort(profileId) {
    const port = this.refresher.active.get(profileId);
    if (port) return port;
    await this.refresher.pollActive();
    return this.refresher.active.get(profileId) || null;
  }

  async handleTargets(req, res, id) {
    if (req.method === 'GET') {
      const port = await this.resolveDebugPort(id);
      if (!port) return sendJson(res, 200, { code: 0, data: { running: false, targets: [] } });
      try {
        const targets = await this.fetchUpstreamJson(port, '/json/list');
        const pages = (Array.isArray(targets) ? targets : [])
          .filter((t) => t.type === 'page')
          .map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type }));
         const decorated = this.refresher.decorateTargets(id, pages);
         return sendJson(res, 200, { code: 0, data: { running: true, port, targets: decorated } });
      } catch (error) {
        return sendJson(res, 200, { code: 0, data: { running: false, targets: [], error: error.message } });
      }
    }
    if (req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const port = await this.resolveDebugPort(id);
      if (!port) return sendJson(res, 400, { code: 400, msg: '实例未运行' });
      try {
        let result;
        if (body.action === 'new') {
          result = await this.fetchUpstreamJson(port, `/json/new?${encodeURIComponent(body.url || 'about:blank')}`, 'PUT');
        } else if (body.action === 'close') {
          result = await this.fetchUpstreamJson(port, `/json/close/${encodeURIComponent(body.targetId)}`);
        } else if (body.action === 'activate') {
          result = await this.fetchUpstreamJson(port, `/json/activate/${encodeURIComponent(body.targetId)}`);
        } else {
          return sendJson(res, 400, { code: 400, msg: '未知操作' });
        }
        return sendJson(res, 200, { code: 0, data: result });
      } catch (error) {
        return sendJson(res, 502, { code: 502, msg: `CDP 操作失败: ${error.message}` });
      }
    }
    return sendJson(res, 405, { code: 405, msg: 'method not allowed' });
  }

  fetchUpstreamJson(port, urlPath, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: urlPath, method, timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_) { resolve({ raw: data }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  // ---- HTTP 直连兜底（WSS 不通时，画面/指令走 HTTP 轮询）----

  castKey(port, targetId) { return `${port}:${targetId}`; }

  castSweep() {
    const now = Date.now();
    for (const [key, s] of this.castPool) {
      if (now - s.lastUsed > 60000) {
        try { s.ws.close(); } catch (_) { /* ignore */ }
        this.castPool.delete(key);
      }
    }
  }

  async castSession(port, targetId) {
    const key = this.castKey(port, targetId);
    let s = this.castPool.get(key);
    if (s && s.ws && s.ws.readyState === 1) { s.lastUsed = Date.now(); return s; }
    if (s && s.ws) { try { s.ws.close(); } catch (_) { /* ignore */ } this.castPool.delete(key); }
    const ws = new global.WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    s = { ws, msgId: 0, pending: new Map(), lastUsed: Date.now(), metrics: null };
    this.castPool.set(key, s);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.castPool.delete(key); reject(new Error('CDP 连接超时')); }, 8000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); this.castPool.delete(key); reject(new Error('CDP 连接失败')); };
    });
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
      if (msg.id && s.pending.has(msg.id)) {
        const p = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      }
    };
    ws.onclose = () => { this.castPool.delete(key); };
    await this.castSend(s, 'Page.enable', {});
    try {
      await this.castSend(s, 'Debugger.enable', {});
      await this.castSend(s, 'Debugger.setSkipAllPauses', { skip: true });
    } catch (_) { /* ignore */ }
    try {
      const m = await this.castSend(s, 'Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight})', returnByValue: true });
      s.metrics = JSON.parse((m && m.result && m.result.value) || '{}');
    } catch (_) { s.metrics = { w: 1280, h: 800 }; }
    return s;
  }

  castSend(s, method, params, timeoutMs = 8000) {
    if (!method) return Promise.reject(new Error('empty method'));
    return new Promise((resolve, reject) => {
      const id = ++s.msgId;
      const t = setTimeout(() => { s.pending.delete(id); reject(new Error('CDP 超时')); }, timeoutMs);
      s.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      try { s.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); s.pending.delete(id); reject(e); }
    });
  }

  async handleCastShot(req, res, profileId, targetId) {
    const port = await this.resolveDebugPort(profileId);
    if (!port) return sendJson(res, 200, { code: 1, msg: '实例未运行' });
    try {
      const s = await this.castSession(port, targetId);
      const r = await this.castSend(s, 'Page.captureScreenshot', { format: 'jpeg', quality: 55 }, 8000);
      const mt = s.metrics || {};
      return sendJson(res, 200, { code: 0, data: { image: r.data, w: mt.w || 1280, h: mt.h || 800 } });
    } catch (e) {
      return sendJson(res, 200, { code: 1, msg: e.message });
    }
  }

  async handleCastCmd(req, res, profileId, targetId, body) {
    const port = await this.resolveDebugPort(profileId);
    if (!port) return sendJson(res, 200, { code: 1, msg: '实例未运行' });
    try {
      const s = await this.castSession(port, targetId);
      const r = await this.castSend(s, String(body.method || ''), body.params || {}, 8000);
      return sendJson(res, 200, { code: 0, data: r });
    } catch (e) {
      return sendJson(res, 200, { code: 1, msg: e.message });
    }
  }

  // ---- WebSocket 升级（/cdp/<profileId>/<targetId>?token=）----

  handleUpgrade(req, socket) {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/cdp\/([^/]+)\/([^/]+)$/);
    const deny = () => {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    };
    if (!m || !verifyToken(this.secretBuf, url.searchParams.get('token') || '')) return deny();
    const [, profileId, targetId] = m;
    if (!handshake(req, socket)) return;
    const client = new WsConnection(socket);
    // 同一 target 只保留最新连接：旧连接（常见于手机断网残留的半开）
    // 会占住 CDP 单客户端位，导致新连接收不到任何帧
    const ckey = `${profileId}/${targetId}`;
    this.cdpClients = this.cdpClients || new Map();
    const prev = this.cdpClients.get(ckey);
    if (prev && !prev.closed) {
      // code:'superseded' 让新客户端停止自动重连，避免两台设备互相踢形成死循环
      try { prev.sendText(JSON.stringify({ bridge: 'error', code: 'superseded', message: '已在其他窗口打开，这里已断开' })); } catch (_) { /* ignore */ }
      try { prev.sendClose(); } catch (_) { /* ignore */ }
    }
    this.cdpClients.set(ckey, client);
    this.resolveDebugPort(profileId).then((port) => {
      if (!port || client.closed) {
        client.sendText(JSON.stringify({ bridge: 'error', message: '实例未运行或端口不可用' }));
        client.sendClose();
        return;
      }
      bridgeToCdp(client, `ws://127.0.0.1:${port}/devtools/page/${targetId}`,
        () => client.sendClose());
      // 被遮挡/后台窗口的 target 不会推 screencast 帧，先置前再桥接
      try { this.fetchUpstreamJson(port, `/json/activate/${encodeURIComponent(targetId)}`).catch(() => {}); } catch (_) { /* ignore */ }
      const origOnClose = client.onClose;
      client.onClose = () => {
        if (this.cdpClients.get(ckey) === client) this.cdpClients.delete(ckey);
        if (origOnClose) origOnClose();
      };
    }).catch(() => client.sendClose());
  }

  // 供 start() 周期调用的守护采样：active 列表 → 实例目录
  async guardSample() {
    const active = await localApiCall('GET', '/api/browser/active', undefined, this.apiKey);
    if (!(active.body && active.body.code === 0)) return;
    const instances = ((active.body.data && active.body.data.list) || [])
      .filter((item) => item.user_id && item.profile_directory)
      .map((item) => ({ id: item.user_id, profileDirectory: item.profile_directory }));
    await this.guard.sampleOnce(instances);
  }

  // ---- 渲染看门狗：页面主线程被 JS 堵死时自动关页重建 ----

  probePageAlive(port, targetId) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };
      let ws;
      try { ws = new global.WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`); } catch (_) { return resolve(false); }
      const t = setTimeout(() => done(false), this.hangProbeTimeoutMs);
      ws.onopen = () => {
        try { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } })); } catch (_) { clearTimeout(t); done(false); }
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
          if (m.id === 1) { clearTimeout(t); done(true); }
        } catch (_) { /* ignore */ }
      };
      ws.onerror = () => { clearTimeout(t); done(false); };
    });
  }

  // 解冻被反调试 debugger 暂停的页面：enable + 禁止暂停 + 恢复执行
  unpauseTarget(port, targetId) {
    return new Promise((resolve) => {
      let settled = false;
      let ws = null;
      let step = 0;
      const done = (v) => {
        if (settled) return;
        settled = true;
        try { if (ws) ws.close(); } catch (_) { /* ignore */ }
        resolve(v);
      };
      const steps = [
        { id: 1, method: 'Debugger.enable', params: {} },
        { id: 2, method: 'Debugger.setSkipAllPauses', params: { skip: true } },
        { id: 3, method: 'Debugger.resume', params: {} },
      ];
      const advance = () => {
        if (settled) return;
        if (step >= steps.length) return done(true);
        const s = steps[step];
        step += 1;
        try { ws.send(JSON.stringify(s)); } catch (e) { done(false); }
      };
      const t = setTimeout(() => done(false), this.hangProbeTimeoutMs);
      try { ws = new global.WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`); } catch (e) { clearTimeout(t); return done(false); }
      ws.onopen = () => advance();
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
          if (m.id && m.id === step) advance();
        } catch (_) { /* ignore */ }
      };
      ws.onerror = () => { clearTimeout(t); done(false); };
    });
  }

  // 冻结现场取证：记录该实例所有内核进程的状态（区分死循环/阻塞/崩溃）
  freezeForensics(profileId, target) {
    try {
      const marker = `browser-profiles-v2/${profileId}`;
      const procs = [];
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch (_) { continue; }
        if (!cmd.includes(marker) || !cmd.includes('--type=')) continue;
        let stat = '';
        try { stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); } catch (_) { continue; }
        let wchan = '';
        try { wchan = fs.readFileSync(`/proc/${d}/wchan`, 'utf8').trim(); } catch (_) { /* ignore */ }
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        procs.push({
          pid: Number(d),
          type: (cmd.match(/--type=([a-z-]+)/) || [])[1] || '',
          state: rest[0],
          wchan,
          cpuTicks: Number(rest[11]) + Number(rest[12]),
        });
      }
      const line = JSON.stringify({ ts: Date.now(), profileId, targetId: target.id, url: (target.url || '').slice(0, 120), procs });
      fs.appendFileSync(path.join(LOG_DIR, 'freeze-forensics.log'), line + '\n');
    } catch (_) { /* ignore */ }
  }

  async hangSweep() {
    // 仅探测、解冻与取证记录，绝不主动关闭/重建用户页面（避免打断登录等关键流程）。
    // 冻结的根治靠会话层的 setSkipAllPauses；用户可手动用「停止/启动」处理异常实例。
    for (const [profileId, port] of this.refresher.active) {
      let pages;
      try { pages = await this.fetchUpstreamJson(port, '/json/list'); } catch (_) { continue; }
      for (const t of (Array.isArray(pages) ? pages : []).filter((x) => x.type === 'page')) {
        const key = `${profileId}/${t.id}`;
        const alive = await this.probePageAlive(port, t.id);
        if (alive) { this.hangFails.delete(key); continue; }
        const revived = await this.unpauseTarget(port, t.id) && await this.probePageAlive(port, t.id);
        if (revived) {
          this.hangFails.delete(key);
          this.logOp('hang-unpaused', { profileId, targetId: t.id, url: t.url || '' });
          continue;
        }
        const fails = (this.hangFails.get(key) || 0) + 1;
        this.hangFails.set(key, fails);
        if (fails === 1 || fails === 2) this.freezeForensics(profileId, t);
        if (fails === 3) {
          this.logOp('hang-detected', { profileId, targetId: t.id, url: t.url || '' });
        }
      }
    }
  }

  listen(port = this.config.port) {
    ensureDirs();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        sendJson(res, 500, { code: 500, msg: error.message });
      });
    });
    this.server.on('upgrade', (req, socket) => {
      try {
        this.handleUpgrade(req, socket);
      } catch (_) {
        try { socket.destroy(); } catch (_) { /* ignore */ }
      }
    });
    this.guard.configure({ ...this.loadGuardConfig(), enabled: this.loadGuardConfig().enabled !== false });
    return new Promise((resolve) => {
      this.server.listen(port, '0.0.0.0', () => {
        this.refresher.start();
        this.castSweepTimer = setInterval(() => this.castSweep(), 30000);
        if (this.castSweepTimer.unref) this.castSweepTimer.unref();
        this.hangSweepTimer = setInterval(() => this.hangSweep().catch(() => {}), 30000);
        if (this.hangSweepTimer.unref) this.hangSweepTimer.unref();
        this.guardSampleTimer = setInterval(() => {
          this.guardSample().catch(() => {});
        }, Math.max(1, this.guard.config.sampleSec) * 1000);
        if (this.guardSampleTimer.unref) this.guardSampleTimer.unref();
        resolve(this.server);
      });
    });
  }

  close() {
    if (this.guardSampleTimer) clearInterval(this.guardSampleTimer);
    if (this.castSweepTimer) clearInterval(this.castSweepTimer);
    if (this.hangSweepTimer) clearInterval(this.hangSweepTimer);
    this.refresher.stop();
    this.guard.stop();
    if (this.server) return new Promise((r) => this.server.close(r));
    return Promise.resolve();
  }
}

if (require.main === module) {
  const app = new ConsoleServer();
  app.listen().then(() => {
    console.log(`[webconsole] listening on http://0.0.0.0:${CONFIG.port}`);
    console.log(`[webconsole] local api: ${CONFIG.localApiBase} (key ${app.apiKey ? 'configured' : 'MISSING'})`);
    console.log(`[webconsole] opsbox proxy: /opsbox/ -> 127.0.0.1:${CONFIG.opsboxPort}`);
  });
  const shutdown = () => { app.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { ConsoleServer, CONFIG, makeToken, verifyToken };
