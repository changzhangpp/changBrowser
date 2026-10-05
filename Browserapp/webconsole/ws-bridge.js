'use strict';

// 零依赖 WebSocket 服务端 + CDP 上游桥接。
// - 接受浏览器 WS 连接（路径 /cdp/<profileId>/<targetId>?token=...）
// - 鉴权后经 Node 22 全局 WebSocket 连接本地 CDP (ws://127.0.0.1:<port>/devtools/page/<id>)
// - 双向透传文本帧（CDP JSON 消息），处理 ping/pong/close 与分片
//
// 仅实现控制台所需子集：服务端→客户端帧不带掩码；客户端→服务端帧必须带掩码（RFC6455）。

const crypto = require('crypto');

const MAX_FRAME = 32 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// 编码一帧（服务端发出：无掩码）
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1
  return Buffer.concat([header, payload]);
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.onMessage = null; // (string) => void
    this.onClose = null;
    this.closed = false;
    this.lastSeen = Date.now();
    socket.on('data', (chunk) => this.feed(chunk));
    const end = () => this.teardown();
    socket.on('close', end);
    socket.on('end', end);
    socket.on('error', end);
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (_) { /* ignore */ }
    if (this.onClose) this.onClose();
  }

  feed(chunk) {
    this.lastSeen = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = this.parseFrame();
      if (!parsed) break;
      this.handleFrame(parsed);
      if (this.closed) break;
    }
  }

  parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    let opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) {
        this.teardown();
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_FRAME) {
      this.teardown();
      return null;
    }
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.slice(offset, offset + len);
    this.buffer = buf.slice(offset + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    if (!fin) {
      // 分片：首片记录 opcode，后续片累积
      if (opcode !== 0) {
        this.fragOpcode = opcode;
        this.fragments = [payload];
      } else {
        this.fragments.push(payload);
      }
      return null; // 等待后续分片
    }
    if (opcode === 0) {
      this.fragments.push(payload);
      payload = Buffer.concat(this.fragments);
      opcode = this.fragOpcode;
      this.fragments = [];
      this.fragOpcode = 0;
    }
    return { opcode, payload };
  }

  handleFrame({ opcode, payload }) {
    if (opcode === 0x1) {
      if (this.onMessage) this.onMessage(payload.toString('utf8'));
    } else if (opcode === 0x2) {
      // 二进制帧：CDP 桥用不到，忽略
    } else if (opcode === 0x8) {
      try { this.socket.write(encodeFrame(0x8, payload.slice(0, 2))); } catch (_) { /* ignore */ }
      this.teardown();
    } else if (opcode === 0x9) {
      try { this.socket.write(encodeFrame(0xA, payload)); } catch (_) { /* ignore */ }
    } // 0xA pong 忽略
  }

  sendText(text) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
    } catch (_) {
      this.teardown();
    }
  }

  sendPing() {
    if (this.closed) return;
    // 半开连接检测：连续多个周期无任何入站帧（浏览器会自动回 WS pong，
    // 应用层心跳也产生文本帧），判定链路已死，主动清理避免长期占用 CDP
    if (this.lastSeen && Date.now() - this.lastSeen > 40000) {
      this.teardown();
      return;
    }
    try { this.socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch (_) {
      this.teardown();
    }
  }

  sendClose() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch (_) { /* ignore */ }
    this.teardown();
  }
}

// 完成升级握手；失败返回 false
function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return false;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  return true;
}

// CDP 桥：浏览器 WS <-> 本地 CDP WS
// - 应用层心跳：WS 层 ping（浏览器自动 pong），防止反向代理掐断空闲连接
// - 上游断开自动重连（重放 Page.enable/startScreencast），控制台无感
function bridgeToCdp(clientWs, upstreamUrl, logError) {
  let upstream = null;
  let closed = false;
  let retries = 0;
  const pending = [];
  const MAX_PENDING = 100;
  let lastSetup = []; // 客户端会话建立消息（去 id），上游重连后重放

  const flushPending = () => {
    while (pending.length && upstream && upstream.readyState === 1) {
      try { upstream.send(pending.shift()); } catch (_) { break; }
    }
  };

  const connect = () => {
    if (closed || clientWs.closed) return;
    try {
      upstream = new global.WebSocket(upstreamUrl);
    } catch (error) {
      if (logError) logError(`upstream connect failed: ${error.message}`);
      clientWs.sendClose();
      return;
    }
    upstream.onopen = () => {
      retries = 0;
      // 屏蔽页面反调试 debugger 暂停：防止风控页把渲染主线程冻结
      try { upstream.send(JSON.stringify({ id: 999000001, method: 'Debugger.enable', params: {} })); } catch (_) { /* ignore */ }
      try { upstream.send(JSON.stringify({ id: 999000002, method: 'Debugger.setSkipAllPauses', params: { skip: true } })); } catch (_) { /* ignore */ }
      for (const text of lastSetup) {
        try { upstream.send(text); } catch (_) { /* ignore */ }
      }
      flushPending();
    };
    upstream.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      clientWs.sendText(data);
    };
    upstream.onclose = () => {
      if (closed || clientWs.closed) return;
      if (retries < 6) {
        retries += 1;
        setTimeout(() => { if (!closed && !clientWs.closed) connect(); }, 600);
      } else {
        clientWs.sendClose();
      }
    };
    upstream.onerror = () => {
      if (logError) logError(`upstream error: ${upstreamUrl}`);
    };
  };
  connect();

  const pingIv = setInterval(() => {
    if (clientWs.closed) { clearInterval(pingIv); return; }
    clientWs.sendPing();
  }, 15000);
  if (pingIv.unref) pingIv.unref();

  clientWs.onMessage = (text) => {
    // 控制台应用层心跳：直接回 pong，不转发 CDP
    if (text.length <= 32 && text.indexOf('"bridge"') !== -1) {
      try { clientWs.sendText('{"bridge":"pong"}'); } catch (_) { /* ignore */ }
      return;
    }
    // 记录会话建立消息（去掉 id 变为通知帧），供上游重连后重放
    if (text.indexOf('Page.enable') !== -1 || text.indexOf('Page.startScreencast') !== -1) {
      const stripped = text.replace(/"id":\d+,?/, '');
      if (lastSetup.indexOf(stripped) === -1) {
        lastSetup.push(stripped);
        if (lastSetup.length > 4) lastSetup.shift();
      }
    }
    if (upstream && upstream.readyState === 1) {
      try { upstream.send(text); } catch (_) { /* upstream 重连中，onclose 处理 */ }
    } else if (pending.length < MAX_PENDING) {
      pending.push(text);
    }
  };
  clientWs.onClose = () => {
    closed = true;
    clearInterval(pingIv);
    try { if (upstream) upstream.close(); } catch (_) { /* ignore */ }
  };
}

module.exports = { WsConnection, handshake, bridgeToCdp, encodeFrame, acceptKey };
