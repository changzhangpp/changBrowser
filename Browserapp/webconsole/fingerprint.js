'use strict';

// 随机指纹人设生成器。
// 输出与 Local API `profiles/update` 允许字段对齐（automation/local-api-server.js）：
// os, platform{type}, userAgent, resolution, windowSize, timezone, locale,
// languageCode, webglVendor, webglRenderer, hardwareConcurrency, deviceMemory,
// doNotTrack, privacy.fingerprint。
// 一致性不变量：UA 平台标记、platform.type、分辨率方向、UA-CH 必须同属一个 OS 家族。

const crypto = require('crypto');

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

// WebGL 厂商-渲染器真实配对表（按平台族）
const WEBGL_BY_FAMILY = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(R) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ],
  macos: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
  ],
  android: [
    { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' },
    { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)' },
    { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G615, OpenGL ES 3.2)' },
  ],
};

const CHROME_MAJORS = [130, 131, 132, 133, 134];

const WINDOWS_VERSIONS = [
  { ch: '10.0.0', platform: 'Windows NT 10.0; Win64; x64' },
  { ch: '15.0.0', platform: 'Windows NT 10.0; Win64; x64' },
];

const MAC_VERSIONS = [
  { ch: '13.5.0', platform: 'Macintosh; Intel Mac OS X 10_15_7' },
  { ch: '14.4.0', platform: 'Macintosh; Intel Mac OS X 10_15_7' },
];

const ANDROID_DEVICES = [
  { model: 'Pixel 7', w: 1080, h: 2400, dpr: 2.625 },
  { model: 'Pixel 8 Pro', w: 1344, h: 2992, dpr: 3 },
  { model: 'SM-S918B', w: 1080, h: 2340, dpr: 2.8125 },
];

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London',
  'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore',
];

const LANGUAGES = [
  { code: 'en-US', locale: 'en-US,en' },
  { code: 'zh-CN', locale: 'zh-CN,zh,en' },
  { code: 'ja-JP', locale: 'ja-JP,ja,en-US,en' },
  { code: 'de-DE', locale: 'de-DE,de,en-US,en' },
  { code: 'en-GB', locale: 'en-GB,en' },
];

function buildChromeUA(family, major, ver) {
  if (family === 'windows') {
    return `Mozilla/5.0 (${ver.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (family === 'macos') {
    return `Mozilla/5.0 (${ver.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return '';
}

function buildAndroidUA(major, model) {
  return `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

// family: 'windows' | 'macos' | 'android'
function generatePersona(options = {}) {
  const family = options.family || pick(['windows', 'windows', 'macos', 'android']);
  const major = pick(CHROME_MAJORS);
  const tz = options.timezone || pick(TIMEZONES);
  const lang = pick(LANGUAGES);

  const persona = { family, timezone: tz, languageCode: lang.code, locale: lang.locale };
  const webgl = pick(WEBGL_BY_FAMILY[family]);
  persona.webglVendor = webgl.vendor;
  persona.webglRenderer = webgl.renderer;

  if (family === 'windows') {
    const ver = pick(WINDOWS_VERSIONS);
    persona.os = 'windows';
    persona.platform = 'Win32';
    persona.userAgent = buildChromeUA('windows', major, ver);
    persona.uaChPlatform = 'Windows';
    persona.uaChPlatformVersion = ver.ch;
    persona.windowSize = `${pick([1366, 1536, 1600, 1920])}x${pick([768, 864, 900, 1080])}`;
    persona.hardwareConcurrency = pick([4, 6, 8, 12, 16]);
    persona.deviceMemory = pick([4, 8, 8, 16]);
  } else if (family === 'macos') {
    const ver = pick(MAC_VERSIONS);
    persona.os = 'macos';
    persona.platform = 'MacIntel';
    persona.userAgent = buildChromeUA('macos', major, ver);
    persona.uaChPlatform = 'macOS';
    persona.uaChPlatformVersion = ver.ch;
    persona.windowSize = `${pick([1440, 1512, 1728, 1920])}x${pick([900, 982, 1080])}`;
    persona.hardwareConcurrency = pick([8, 10, 12]);
    persona.deviceMemory = 8;
  } else {
    const dev = pick(ANDROID_DEVICES);
    persona.os = 'android';
    persona.platform = 'Linux armv8l';
    persona.userAgent = buildAndroidUA(major, dev.model);
    persona.uaChPlatform = 'Android';
    persona.uaChPlatformVersion = '14.0.0';
    persona.windowSize = `${dev.w}x${dev.h}`;
    persona.hardwareConcurrency = pick([6, 8]);
    persona.deviceMemory = pick([4, 6, 8]);
  }

  // Canvas / WebGL / Audio 噪声种子（引擎按 seed 派生噪声）
  persona.fingerprint = {
    seed: crypto.randomBytes(16).toString('hex'),
    canvasNoise: Number((crypto.randomInt(10, 40) / 10000).toFixed(6)),
    webglNoise: Number((crypto.randomInt(10, 40) / 10000).toFixed(6)),
    audioNoise: Number((crypto.randomInt(1, 30) / 1e7).toFixed(9)),
  };

  persona.doNotTrack = pick(['unset', 'unset', '1']);
  return persona;
}

// 将人设映射为 Local API profiles/update 载荷
function personaToUpdatePayload(persona) {
  const payload = {
    os: persona.os,
    platform: persona.platform,
    userAgent: persona.userAgent,
    resolution: persona.windowSize,
    windowSize: persona.windowSize,
    timezone: persona.timezone,
    locale: persona.locale,
    languageCode: persona.languageCode,
    webglVendor: persona.webglVendor,
    webglRenderer: persona.webglRenderer,
    hardwareConcurrency: persona.hardwareConcurrency,
    deviceMemory: persona.deviceMemory,
    doNotTrack: persona.doNotTrack,
    privacy: {
      fingerprint: {
        seed: persona.fingerprint.seed,
        canvasNoise: persona.fingerprint.canvasNoise,
        webglNoise: persona.fingerprint.webglNoise,
        audioNoise: persona.fingerprint.audioNoise,
        uaChPlatform: persona.uaChPlatform,
        uaChPlatformVersion: persona.uaChPlatformVersion,
      },
    },
  };
  return payload;
}

// 一致性校验（Correctness Property 5）
function isConsistent(persona) {
  if (!persona || !persona.userAgent) return false;
  const ua = persona.userAgent;
  const family = persona.family;
  if (family === 'windows') {
    return ua.includes('Windows NT 10.0') && persona.platform === 'Win32'
      && !/Mobile/.test(ua) && persona.uaChPlatform === 'Windows';
  }
  if (family === 'macos') {
    return ua.includes('Mac OS X') && persona.platform === 'MacIntel'
      && !/Mobile/.test(ua) && persona.uaChPlatform === 'macOS';
  }
  if (family === 'android') {
    return ua.includes('Android') && ua.includes('Mobile')
      && persona.uaChPlatform === 'Android';
  }
  return false;
}

module.exports = { generatePersona, personaToUpdatePayload, isConsistent, pick, randInt };
