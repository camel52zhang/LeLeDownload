// 回归测试：自动接管通用分支的「浏览器请求上下文」组装
// （对应 extension/background.js 中 buildBrowserHeaders / readCookieStringForUrl /
//   getBrowserUA / shouldSkipAutoCapture / fallbackFilenameFromUrl /
//   looksLikeUrlQueryString / buildDownloadPostBody / planGenericCapture /
//   handleGenericCapture / onCreated 监听器）
//
// 目的：验证 downloads.onCreated 通用分支对「先过 JS 反爬挑战再给文件」站点
// （维基文库 EPUB/MOBI/PDF 导出，域名 ws-export.wmcloud.org，被 Anubis 工作量证明
// 挑战把守，第一跳只返回 text/html 挑战页）能组装出浏览器请求上下文：
//   Cookie（该 URL 的浏览器会话 cookie）+ User-Agent（真实浏览器 UA）+ Referer
// 并与 item.filename 一并 POST 给 App，让 App 下到真文件而非挑战页 HTML；
// cookie 组装失败 → 回退无头发送（旧行为）；Cookie 按 UTF-8 字节超 8000 → 放弃接管
// （不发送、不取消浏览器下载，保留原生下载兜底）；item.filename 形似 URL query 串
// （Anubis 挑战通过前 Chrome 的 URL 推导名）→ 不透传 filename，由 App 从
// content-disposition 解析真实名。
//
// 纯函数逻辑与 onCreated 处理器在本文件内照搬 background.js 实现（node --test 无 chrome
// 运行环境），chrome.* API 以 globalThis.chrome 打桩模拟，sendToLeleDownload 以桩记录调用；
// 另设「镜像一致性」用例直读 background.js / magnet-context.js 源码，防常量漂移；
// F5 起新增「生产代码真身」提取（extractFunctionSource + new Function 求值
// background.js 的 looksLikeUrlQueryString / buildDownloadPostBody），
// 断言直接作用于生产代码，镜像只做行为对照。
//
// 运行： node --test extension/test-anubis-oncreated.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中对应函数保持一致（chrome.* 经 globalThis 打桩）
// ---------------------------------------------------------------------------

const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BROWSER_UA_STORAGE_KEY = 'lele_browser_ua';
// 与 background.js 一致：按 UTF-8 字节计的 8000 阈值（App sanitize_headers 对 >8192
// 字节的头静默丢弃，见 src-tauri/src/main.rs:214，留 192 字节余量）。
const MAX_COOKIE_HEADER_BYTES = 8000;

// WeTransfer 下载地址判定（通用分支前的专用分支，本文件只验证「不误入」）
function isWetransferDownloadUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host === 'wetransfer.com' && path.indexOf('/download/') === 0) return true;
  if (host === 'download.wetransfer.com') return true;
  if (host === 'filedownload.wetransfer.com') return true;
  if (host === 'transfer.wetransfer.com') return true;
  if (host.endsWith('files.wetransfer.net')) return true;
  return false;
}

function getBrowserUA() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([BROWSER_UA_STORAGE_KEY], (res) => {
        if (chrome.runtime.lastError) {
          resolve(DEFAULT_CHROME_UA);
          return;
        }
        const ua = res && res[BROWSER_UA_STORAGE_KEY];
        resolve(typeof ua === 'string' && ua ? ua : DEFAULT_CHROME_UA);
      });
    } catch (_) {
      resolve(DEFAULT_CHROME_UA);
    }
  });
}

async function readCookieStringForUrl(url) {
  if (typeof chrome === 'undefined' || !chrome.cookies || typeof chrome.cookies.getAll !== 'function') {
    throw new Error('chrome.cookies.getAll 不可用');
  }
  const cks = await new Promise((resolve, reject) => {
    try {
      chrome.cookies.getAll({ url: url }, (cks) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'cookies.getAll failed'));
          return;
        }
        resolve(cks || []);
      });
    } catch (e) {
      reject(e);
    }
  });
  const list = cks || [];
  const map = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const pair = c.name + '=' + c.value;
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.slice(0, idx).trim();
      if (name) map[name] = pair.trim();
    }
  }
  return Object.keys(map).map((k) => map[k]).join('; ');
}

async function buildBrowserHeaders(url, referrer) {
  const headers = {};
  const ua = await getBrowserUA();
  if (ua) headers['User-Agent'] = ua;
  if (referrer) headers['Referer'] = referrer;
  const cookieString = await readCookieStringForUrl(url);
  if (cookieString) headers['Cookie'] = cookieString;
  return headers;
}

function shouldSkipAutoCapture(url) {
  if (!/^https?:\/\//i.test(url || '')) return true;
  if (/addons\.mozilla\.org|chromewebstore\.google\.com|edgedaddons\.microsoft\.com/i.test(url || '')) return true;
  return false;
}

function fallbackFilenameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').pop();
    return seg || '';
  } catch (_) {
    return (url || '').split('/').pop() || '';
  }
}

function looksLikeUrlQueryString(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.indexOf('?') === 0) return true;
  if (name.indexOf('=') !== -1 && name.indexOf('&') !== -1) return true;
  if (name.indexOf('%') !== -1) {
    try {
      if (decodeURIComponent(name).indexOf('=') !== -1) return true;
    } catch (_) { /* 含孤立 % 时 decodeURIComponent 抛错，按不含 = 处理 */ }
  }
  return false;
}

function buildDownloadPostBody(url, headers, filename) {
  const body = { url: url, timestamp: Date.now() };
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    body.headers = headers;
  }
  if (filename && !looksLikeUrlQueryString(filename)) {
    body.filename = filename;
  }
  return body;
}

// 以下为 onCreated 处理器骨架的镜像（sendToLeleDownload / notify 以桩替换）
// 注意：planGenericCapture 的超限判定必须与 background.js 一致——按 UTF-8 实测字节
// （TextEncoder），超限返回 { send: false }（放弃接管），而非回退无头发送。

let autoCapture = true;
let sendResult = { ok: true };
const sentCalls = [];
const notifyCalls = [];
let chromeCalls;

async function sendToLeleDownload(url, headers, filename) {
  sentCalls.push({ url: url, headers: headers, filename: filename });
  return sendResult;
}

function notify(message) {
  notifyCalls.push(message);
}

async function planGenericCapture(item) {
  let headers;
  try {
    headers = await buildBrowserHeaders(item.url, item.referrer);
  } catch (e) {
    // cookie 组装本身失败：保持旧行为「无头发送」，不扩大行为变更面
    return { send: true, headers: undefined };
  }
  const cookie = headers['Cookie'];
  if (cookie) {
    const cookieBytes = new TextEncoder().encode(cookie).length;
    if (cookieBytes > MAX_COOKIE_HEADER_BYTES) {
      notifyCalls.push('Cookie 过大，本次不接管，保留浏览器下载');
      return { send: false };
    }
  }
  return { send: true, headers: headers };
}

async function handleGenericCapture(item, filename) {
  const plan = await planGenericCapture(item);
  if (!plan.send) {
    return { ok: false, abandoned: true };
  }
  const res = await sendToLeleDownload(item.url, plan.headers, filename);
  if (res.ok) {
    try {
      chrome.downloads.cancel(item.id);
      chrome.downloads.erase({ id: item.id });
    } catch (_) { /* Firefox 部分版本 cancel 行为差异，忽略 */ }
    notify('乐乐下载器已接管：' + filename);
  }
  return res;
}

// onCreated 监听器骨架镜像：返回走中的分支，便于断言跳过逻辑
function handleOnCreated(item) {
  if (!autoCapture) return 'skipped-off';
  if (shouldSkipAutoCapture(item.url)) return 'skipped-url';
  const filename = item.filename || fallbackFilenameFromUrl(item.url) || item.url;
  if (isWetransferDownloadUrl(item.url)) return 'wetransfer';
  handleGenericCapture(item, filename).catch(() => {});
  return 'generic';
}

// ---------------------------------------------------------------------------
// 生产代码真身提取：直读 background.js 源码，把 looksLikeUrlQueryString 与
// buildDownloadPostBody 抠出来在同一作用域求值（new Function），使断言直接作用于
// 生产代码——镜像只做行为对照，真身才是变异校验的靶子（改坏 background.js 必红）。
// ---------------------------------------------------------------------------

function extractFunctionSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function loadRealPostBodyFns() {
  const bgSrc = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const fnSrc = extractFunctionSource(bgSrc, 'looksLikeUrlQueryString');
  const bodySrc = extractFunctionSource(bgSrc, 'buildDownloadPostBody');
  assert.ok(fnSrc, 'background.js 应定义 looksLikeUrlQueryString');
  assert.ok(bodySrc, 'background.js 应定义 buildDownloadPostBody');
  const factory = new Function(
    fnSrc + '\n' + bodySrc +
    '\nreturn { looksLikeUrlQueryString: looksLikeUrlQueryString, buildDownloadPostBody: buildDownloadPostBody };'
  );
  return factory();
}

// ---------------------------------------------------------------------------
// chrome 打桩工具
// ---------------------------------------------------------------------------

function installChromeMock(opts) {
  opts = opts || {};
  const calls = {
    getAllUrls: [],
    storageGets: [],
    cancel: [],
    erase: [],
    notifications: []
  };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get: (keys, cb) => {
          calls.storageGets.push(keys);
          if (opts.storageGetThrows) throw new Error('storage boom');
          cb(opts.storageData || {});
        },
        set: (obj, cb) => { if (cb) cb(); }
      }
    },
    cookies: {
      getAll: (o, cb) => {
        calls.getAllUrls.push(o.url);
        if (opts.cookiesMode === 'throw-sync') throw new Error('cookies boom');
        if (opts.cookiesMode === 'lastError') {
          globalThis.chrome.runtime.lastError = { message: 'no permission' };
          cb([]);
          globalThis.chrome.runtime.lastError = null;
          return;
        }
        cb(opts.cookieList || []);
      }
    },
    downloads: {
      cancel: (id) => calls.cancel.push(id),
      erase: (o) => calls.erase.push(o.id)
    },
    notifications: {
      create: (o) => calls.notifications.push(o)
    }
  };
  chromeCalls = calls;
  return calls;
}

function resetState() {
  sentCalls.length = 0;
  notifyCalls.length = 0;
  sendResult = { ok: true };
  autoCapture = true;
}

// 维基文库导出真实形态：<a href> 常规导航到 ws-export，Anubis 挑战通过后才产出下载项
const WSEXPORT_URL = 'https://ws-export.wmcloud.org/?format=epub&lang=zh&page=%E5%B8%8C%E8%85%8A%E5%85%AC%E5%AF%93';
const WSEXPORT_FILENAME = '希臘公廁.epub';
const WSEXPORT_ITEM = {
  id: 42,
  url: WSEXPORT_URL,
  referrer: 'https://zh.wikisource.org/wiki/%E5%B8%8C%E8%85%8A%E5%85%AC%E5%AF%93',
  filename: WSEXPORT_FILENAME
};

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// 1) 核心场景：ws-export（Anubis 挑战站点）onCreated → 组装 Cookie/UA/Referer + filename
//    一并下发；res.ok 时 cancel+erase 浏览器下载并通知。
test('ws-export 维基文库导出：onCreated 接管应组装 Cookie/UA/Referer + filename 一并下发', async () => {
  resetState();
  const calls = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [
      { name: 'techaro.lua-anubis-cookie', value: 'proof-abc' },
      { name: 'within.website-x-cmd-anubis-auth', value: 'signed-token' }
    ]
  });

  const branch = handleOnCreated(WSEXPORT_ITEM);
  assert.equal(branch, 'generic', 'ws-export URL 应走通用接管分支');
  await new Promise((r) => setTimeout(r, 0)); // 放行 async 链

  assert.equal(sentCalls.length, 1, '应下发一次');
  const call = sentCalls[0];
  assert.equal(call.url, WSEXPORT_URL);
  assert.equal(call.filename, WSEXPORT_FILENAME, 'item.filename 应透传');

  // 浏览器请求上下文三要素
  assert.deepEqual(calls.getAllUrls, [WSEXPORT_URL], 'Cookie 应按下载 URL 读取');
  assert.ok(call.headers['Cookie'].includes('techaro.lua-anubis-cookie=proof-abc'), 'Cookie 应含 Anubis 挑战通过凭证');
  assert.ok(call.headers['Cookie'].includes('within.website-x-cmd-anubis-auth=signed-token'));
  assert.ok(call.headers['User-Agent'].includes('Chrome/131.0.0.0'), 'UA 应为 magnet-context.js 上报的真实浏览器 UA');
  assert.equal(call.headers['Referer'], WSEXPORT_ITEM.referrer, 'Referer 应为下载来源页');

  // POST body 组装：filename 透传可跳过 App 侧 HEAD 探测（挑战页对 HEAD 也返回 HTML）
  const body = buildDownloadPostBody(call.url, call.headers, call.filename);
  assert.equal(body.filename, WSEXPORT_FILENAME);
  assert.equal(body.headers['Cookie'], call.headers['Cookie']);
  assert.equal(typeof body.timestamp, 'number');

  // res.ok → 取消 + 擦除浏览器下载并通知
  assert.deepEqual(calls.cancel, [42]);
  assert.deepEqual(calls.erase, [42]);
  assert.equal(notifyCalls.length, 1);
  assert.ok(notifyCalls[0].includes(WSEXPORT_FILENAME));
});

// 2) 兜底不变：App 未接收（res.ok=false）时不得取消浏览器下载、不得通知
test('App 未接收时不应取消浏览器下载（兜底行为不变）', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'techaro.lua-anubis-cookie', value: 'proof-abc' }]
  });
  sendResult = { ok: false, msg: 'create_failed' };

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1, '仍应尝试下发');
  assert.equal(sentCalls[0].headers['Cookie'].includes('proof-abc'), true);
  assert.deepEqual(chromeCalls.cancel, [], 'App 未接收不得 cancel');
  assert.deepEqual(chromeCalls.erase, [], 'App 未接收不得 erase');
  assert.equal(notifyCalls.length, 0, 'App 未接收不得通知');
});

// 3) 健壮性：chrome.cookies.getAll 同步抛错 → 回退无头发送，接管不阻塞，兜底不变
test('chrome.cookies.getAll 抛错时应回退无头发送且兜底行为不变', async () => {
  resetState();
  const calls = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookiesMode: 'throw-sync'
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1, '组装失败不应阻塞接管');
  assert.equal(sentCalls[0].headers, undefined, '组装失败应回退无头发送');
  assert.equal(sentCalls[0].filename, WSEXPORT_FILENAME, 'filename 仍应透传');
  // 兜底：res.ok 时依旧 cancel+erase
  assert.deepEqual(calls.cancel, [42]);
  assert.deepEqual(calls.erase, [42]);
});

// 3b) 健壮性：getAll 回调带 lastError → 同样回退无头发送
test('chrome.cookies.getAll lastError 时应回退无头发送', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookiesMode: 'lastError'
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].headers, undefined, 'lastError 应回退无头发送');
});

// 3c) 健壮性：chrome.cookies 整体缺失 → 回退无头发送
test('无 chrome.cookies 命名空间时应回退无头发送', async () => {
  resetState();
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: { local: { get: (keys, cb) => cb({ lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' }) } },
    downloads: { cancel: () => {}, erase: () => {} }
  };

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].headers, undefined);
});

// 4) P1 修正：Cookie 头按 UTF-8 字节超过 8000 → 放弃接管（不发送、不 cancel/erase、
//    不通知「已接管」），仅提示为何未接管；浏览器原生下载继续，用户至少能下到正确文件。
//    背景：App sanitize_headers 对 >8192 字节的头静默丢弃（main.rs:214），硬接管只会
//    存下挑战页垃圾文件，而浏览器下载已被取消——放弃接管是唯一安全降级。
test('Cookie 头超过 8000 字节应放弃接管：不发送、不取消浏览器下载', async () => {
  resetState();
  const calls = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'huge', value: 'x'.repeat(8000) }] // 'huge=' + 8000 = 8005 字节 > 8000
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 0, '超限应放弃接管，不得发送（含不得回退无头发送）');
  assert.deepEqual(calls.cancel, [], '放弃接管不得 cancel 浏览器下载');
  assert.deepEqual(calls.erase, [], '放弃接管不得 erase 浏览器下载');
  assert.ok(
    notifyCalls.some((m) => m.includes('Cookie 过大')),
    '应通知用户本次为何未接管，避免困惑'
  );
  assert.equal(
    notifyCalls.some((m) => m.includes('已接管')),
    false,
    '放弃接管不得发出「已接管」通知'
  );
});

// 4b) 边界：8000 字节整（未超限）应正常携带；8001 字节（超 1 字节）即放弃接管
test('Cookie 头 8000/8001 字节边界：整限携带、超一字节放弃接管', async () => {
  // 4b-i) 'ok=' + 7996 个 x = 8000 字节整 → 未超限，正常携带
  resetState();
  const valueAtLimit = 'x'.repeat(8000 - 'ok='.length);
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'ok', value: valueAtLimit }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1, '8000 字节整未超限，应发送');
  assert.equal(sentCalls[0].headers['Cookie'], 'ok=' + valueAtLimit, '未超限 Cookie 应携带');

  // 4b-ii) 'ok=' + 7997 个 x = 8001 字节 → 超 1 字节，放弃接管
  resetState();
  const valueOverLimit = 'x'.repeat(8001 - 'ok='.length);
  const calls2 = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'ok', value: valueOverLimit }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 0, '8001 字节超限，应放弃接管');
  assert.deepEqual(calls2.cancel, []);
  assert.deepEqual(calls2.erase, []);
});

// 4c) UTF-16/UTF-8 单位差专治：CJK cookie 字符数远小于 8000，但 UTF-8 字节数超 8000
//     （1 个中文字符 = 1 个 UTF-16 码元 = 3 个 UTF-8 字节）。按 .length（码元）判断会漏过。
test('CJK cookie 码元数不超限但字节数超限时应放弃接管（UTF-8 实测）', async () => {
  // 4c-i) 'zh=' + 2666 个中文字符：码元数 3+2666=2669 < 8000，字节数 3+3*2666=8001 > 8000 → 放弃
  resetState();
  const cjkOver = '中'.repeat(2666);
  assert.ok(('zh=' + cjkOver).length < 8000, '前提：码元数未超限');
  assert.equal(new TextEncoder().encode('zh=' + cjkOver).length, 8001, '前提：字节数超限');
  const callsA = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'zh', value: cjkOver }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 0, '字节数超限应放弃接管（不能被码元数蒙混过关）');
  assert.deepEqual(callsA.cancel, []);
  assert.deepEqual(callsA.erase, []);

  // 4c-ii) 对照组：'zh=' + 2665 个中文字符 = 7998 字节 ≤ 8000 → 正常携带
  resetState();
  const cjkAtLimit = '中'.repeat(2665);
  assert.equal(new TextEncoder().encode('zh=' + cjkAtLimit).length, 7998);
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'zh', value: cjkAtLimit }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1, '7998 字节未超限，应发送');
  assert.equal(sentCalls[0].headers['Cookie'], 'zh=' + cjkAtLimit);
});

// 5) cookie jar 为空（该域无 cookie）不是错误：仍带 UA/Referer，仅无 Cookie 头
test('无 Cookie 的普通站点仍应带 UA/Referer 下发（不含 Cookie 头）', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: []
  });
  const item = {
    id: 8,
    url: 'https://example.com/files/report.pdf',
    referrer: 'https://example.com/list',
    filename: 'report.pdf'
  };

  handleOnCreated(item);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].headers['Cookie'], undefined);
  assert.ok(sentCalls[0].headers['User-Agent'].includes('Chrome/131.0.0.0'));
  assert.equal(sentCalls[0].headers['Referer'], 'https://example.com/list');
});

// 6) item.referrer 缺失（MV3 部分场景不填充）时不应带 Referer 头，其余照常
test('item.referrer 缺失时不应带 Referer 头，UA/Cookie 照常', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'sid', value: '1' }]
  });
  const item = { id: 9, url: WSEXPORT_URL, filename: 'a.epub' };

  handleOnCreated(item);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls[0].headers['Referer'], undefined);
  assert.equal(sentCalls[0].headers['Cookie'], 'sid=1');
  assert.ok(sentCalls[0].headers['User-Agent']);
});

// 7) 真实 UA 缺失（从未打开过 http(s) 页面 / storage 抛错）→ 回退桌面 Chrome UA 常量
test('真实浏览器 UA 缺失或 storage 读取失败时应回退桌面 Chrome UA 常量', async () => {
  // 7a) storage 无该键
  resetState();
  installChromeMock({ storageData: {}, cookieList: [] });
  const headersA = await buildBrowserHeaders('https://example.com/a.zip', null);
  assert.equal(headersA['User-Agent'], DEFAULT_CHROME_UA);

  // 7b) storage.local.get 抛错
  resetState();
  installChromeMock({ storageGetThrows: true, cookieList: [] });
  const headersB = await buildBrowserHeaders('https://example.com/a.zip', null);
  assert.equal(headersB['User-Agent'], DEFAULT_CHROME_UA);
  assert.ok(headersB['User-Agent'].includes('Chrome/120.0.0.0'));
});

// 8) 跳过逻辑：非 http(s) 与 addon 商店 URL 不接管（不干扰浏览器自身行为）
test('非 http(s) 与 addon 商店 URL 应被跳过，不下发', async () => {
  resetState();
  installChromeMock({ storageData: {}, cookieList: [] });

  const skipUrls = [
    'blob:https://zh.wikisource.org/550e8400-e29b-41d4-a716-446655440000',
    'data:application/epub+zip;base64,UEsDBBQAAAAA',
    'magnet:?xt=urn:btih:abc',
    'https://addons.mozilla.org/zh-CN/firefox/addon/lele/',
    'https://chromewebstore.google.com/detail/lele/abcdefghijklmnop',
    'https://edgedaddons.microsoft.com/detail/lele/abcdefgh'
  ];
  for (const u of skipUrls) {
    assert.equal(shouldSkipAutoCapture(u), true, u + ' 应被跳过');
    assert.equal(handleOnCreated({ id: 1, url: u, filename: 'x' }), 'skipped-url', u + ' 应走跳过分支');
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sentCalls.length, 0, '跳过的 URL 不得下发');

  // 普通 http(s) 不跳过
  assert.equal(shouldSkipAutoCapture('https://example.com/a.zip'), false);
  assert.equal(shouldSkipAutoCapture('http://example.com/a.zip'), false);
  assert.equal(shouldSkipAutoCapture(WSEXPORT_URL), false);
});

// 8b) 跳过逻辑按 URL 独立：WeTransfer 下载 URL 不应被跳过判定误伤
test('WeTransfer 下载 URL 不应被通用跳过判定误伤', () => {
  assert.equal(shouldSkipAutoCapture('https://wetransfer.com/download/local-bartender?id=abc'), false);
  assert.equal(shouldSkipAutoCapture('https://eu-west-1-files.wetransfer.net/f.zip?Expires=1&Signature=s'), false);
});

// 9) 文件名兜底：item.filename 缺失时剥 query/hash 取末段；ws-export 全 query URL 得空串后回退 item.url
test('fallbackFilenameFromUrl 应剥掉 query/hash，全 query URL 得空串', () => {
  assert.equal(fallbackFilenameFromUrl('https://example.com/a/b/file.zip?x=1#frag'), 'file.zip');
  assert.equal(fallbackFilenameFromUrl('https://example.com/a/b/'), '');
  assert.equal(fallbackFilenameFromUrl(WSEXPORT_URL), '');
  assert.equal(fallbackFilenameFromUrl('not-a-url'), 'not-a-url');
  // onCreated 中的组合：item.filename 优先 → URL 末段 → item.url
  const item = { id: 3, url: WSEXPORT_URL };
  const filename = item.filename || fallbackFilenameFromUrl(item.url) || item.url;
  assert.equal(filename, item.url);
});

// 10) 旧行为不变：不传 headers/filename 时 POST body 仅含 url + timestamp
test('不传 headers/filename 时请求体仅含 url 与 timestamp（旧路径行为不变）', () => {
  const body = buildDownloadPostBody('https://example.com/a.zip', undefined, undefined);
  assert.deepEqual(Object.keys(body).sort(), ['timestamp', 'url']);
  // 空对象 headers 同样不应进入 body
  const body2 = buildDownloadPostBody('https://example.com/a.zip', {}, '');
  assert.equal(body2.headers, undefined);
  assert.equal(body2.filename, undefined);
});

// 11) WeTransfer 分支不回退：cookie 读取失败时仍带 UA/Referer/Origin，仅无 Cookie 头
//     （readCookieStringForUrl 重构后 buildWetransferHeaders 的降级行为必须与旧版一致）
test('WeTransfer 头组装不回退：cookie 读取失败仍带 UA/Referer/Origin', async () => {
  // 镜像 background.js 的 assembleWetransferHeaders + buildWetransferHeaders
  function assembleWetransferHeaders(cookieString) {
    const headers = {
      'Referer': 'https://wetransfer.com/',
      'Origin': 'https://wetransfer.com/',
      'User-Agent': DEFAULT_CHROME_UA
    };
    if (cookieString) headers['Cookie'] = cookieString;
    return headers;
  }
  async function buildWetransferHeaders() {
    let cookieString = '';
    try {
      cookieString = await readCookieStringForUrl('https://wetransfer.com/');
    } catch (_) { /* cookie 不可用时 Cookie 头为空，仍带 UA/Referer/Origin */ }
    return assembleWetransferHeaders(cookieString);
  }

  // 11a) 正常：带回 wetransfer.com 的会话 Cookie
  resetState();
  installChromeMock({ cookieList: [{ name: '_wt_session', value: 'sess-1' }] });
  const okHeaders = await buildWetransferHeaders();
  assert.deepEqual(chromeCalls.getAllUrls, ['https://wetransfer.com/'], 'WeTransfer 仍按 wetransfer.com 读 cookie');
  assert.equal(okHeaders['Referer'], 'https://wetransfer.com/');
  assert.equal(okHeaders['Origin'], 'https://wetransfer.com/');
  assert.equal(okHeaders['Cookie'], '_wt_session=sess-1');

  // 11b) 失败（同步抛错）：降级为无 Cookie 头，不抛错、不回退无头发送
  resetState();
  installChromeMock({ cookiesMode: 'throw-sync' });
  const failHeaders = await buildWetransferHeaders();
  assert.equal(failHeaders['Referer'], 'https://wetransfer.com/');
  assert.equal(failHeaders['Origin'], 'https://wetransfer.com/');
  assert.ok(failHeaders['User-Agent'].includes('Chrome/120.0.0.0'));
  assert.equal(failHeaders['Cookie'], undefined);

  // 11c) 失败（lastError）：同样降级
  resetState();
  installChromeMock({ cookiesMode: 'lastError' });
  const errHeaders = await buildWetransferHeaders();
  assert.equal(errHeaders['Cookie'], undefined);
  assert.equal(errHeaders['Referer'], 'https://wetransfer.com/');
});

// 12) WeTransfer URL 走专用分支，不进入通用带上下文分支（职责分离不回退）
test('WeTransfer 下载 URL 应走专用分支而非通用分支', async () => {
  resetState();
  installChromeMock({ storageData: {}, cookieList: [] });
  const branch = handleOnCreated({
    id: 5,
    url: 'https://wetransfer.com/download/local-bartender?id=eyJhIjoiYiJ9',
    referrer: 'https://wetransfer.com/',
    filename: 'foo.zip'
  });
  assert.equal(branch, 'wetransfer');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sentCalls.length, 0, '专用分支由 background.js 内既有链路处理，本镜像不模拟其发送');
});

// 13) P2：autoCapture=false（弹窗关闭自动接管）时 onCreated 完全不发送、不动浏览器下载
test('autoCapture=false 时 onCreated 应完全不发送', async () => {
  resetState();
  const calls = installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'techaro.lol-anubis-auth-abc', value: 'jwt' }]
  });
  autoCapture = false;

  assert.equal(handleOnCreated(WSEXPORT_ITEM), 'skipped-off');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 0, '开关关闭时不得发送');
  assert.deepEqual(calls.cancel, [], '开关关闭时不得 cancel');
  assert.deepEqual(calls.erase, [], '开关关闭时不得 erase');
  assert.equal(notifyCalls.length, 0, '开关关闭时不得通知');
});

// 14) 镜像一致性：直读 background.js / magnet-context.js 源码，防本文件镜像漂移。
//     尤其守护 P1 修正后的两个关键常量：阈值 8000（UTF-8 字节）与 UA storage 键名。
test('镜像一致性：background.js 常量与 magnet-context.js 键名应与本测试一致', () => {
  const bgSrc = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const magnetSrc = readFileSync(new URL('./magnet-context.js', import.meta.url), 'utf8');

  // 阈值：8000 字节（对齐 App sanitize_headers 的 8192 头上限，main.rs:214）
  assert.ok(
    bgSrc.includes('MAX_COOKIE_HEADER_BYTES = 8000'),
    'background.js 的 MAX_COOKIE_HEADER_BYTES 应为 8000'
  );
  assert.equal(MAX_COOKIE_HEADER_BYTES, 8000, '本测试镜像阈值应为 8000');

  // UA 上报键名：magnet-context.js 写入 ↔ background.js 读取必须同一键
  assert.ok(
    bgSrc.includes("BROWSER_UA_STORAGE_KEY = 'lele_browser_ua'"),
    "background.js 应定义 BROWSER_UA_STORAGE_KEY = 'lele_browser_ua'"
  );
  assert.ok(
    magnetSrc.includes('lele_browser_ua'),
    'magnet-context.js 应写入同一 storage 键 lele_browser_ua'
  );
  assert.equal(BROWSER_UA_STORAGE_KEY, 'lele_browser_ua', '本测试镜像键名应为 lele_browser_ua');

  // 超限判定必须按 UTF-8 实测字节（TextEncoder），而非字符串 .length（UTF-16 码元）
  assert.ok(
    bgSrc.includes('new TextEncoder().encode(cookie).length'),
    'background.js 应按 UTF-8 实测字节判定 Cookie 长度'
  );

  // F5：POST body 组装前必须过滤形似 URL query 串的 filename（与 App 侧
  // pick_explicit_filename 的 looks_like_url_query_string 同标准、双保险）
  assert.ok(
    bgSrc.includes('if (filename && !looksLikeUrlQueryString(filename))'),
    'background.js 组装 POST body 前应过滤形似 query 串的 filename'
  );
  assert.ok(
    extractFunctionSource(bgSrc, 'looksLikeUrlQueryString') !== null,
    'background.js 应定义纯函数 looksLikeUrlQueryString'
  );
});

// 15) F5 核心：onCreated 的 item.filename 为 query 串（Anubis 挑战通过前 Chrome 只能
//     从 ws-export URL 推导出 'format=epub&lang=zh&page=...'）时，POST body 不含
//     filename 字段——真实名由 App 从 content-disposition 解析（App extract_filename
//     已做原生 UA 二次探测，Anubis 放行原生 UA）。url/浏览器请求上下文照常下发。
//     断言用 background.js 生产代码真身（loadRealPostBodyFns），改坏生产代码必红。
test('onCreated 的 item.filename 为 query 串时 POST body 不含 filename 字段', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'techaro.lua-anubis-cookie', value: 'proof-abc' }]
  });
  const item = {
    id: 77,
    url: WSEXPORT_URL,
    referrer: 'https://zh.wikisource.org/wiki/x',
    filename: 'format=epub&lang=zh&page=x'
  };

  handleOnCreated(item);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1, '仍应下发一次（url/headers 不受影响）');
  const call = sentCalls[0];
  assert.equal(call.url, WSEXPORT_URL, 'url 照常下发');
  assert.ok(call.headers['Cookie'].includes('proof-abc'), '浏览器请求上下文照常下发');

  // 生产代码真身组装 POST body：query 串 filename 必须被过滤
  const real = loadRealPostBodyFns();
  const body = real.buildDownloadPostBody(call.url, call.headers, call.filename);
  assert.equal('filename' in body, false, 'query 串 filename 不得进入 POST body');
  assert.equal(body.url, WSEXPORT_URL);
  assert.equal(body.headers['Cookie'], call.headers['Cookie']);

  // 镜像与生产代码行为一致（防镜像漂移）
  const mirrorBody = buildDownloadPostBody(call.url, call.headers, call.filename);
  assert.equal('filename' in mirrorBody, false, '镜像组装同样不得含 query 串 filename');
});

// 16) F5 反例保护：正常文件名（含中文/空格/哈希串/html）仍透传，其他平台不受影响
test('正常文件名的 POST body 仍含 filename 字段（反例保护）', () => {
  const real = loadRealPostBodyFns();
  const keep = [
    'test.epub',
    '希臘公廈.epub',
    '中山狼傳.epub',
    'Far East Spring 2027_001.pdf',
    '醒名花.mobi',
    'bc8df8d8c2-147_165756-0.html',
    'download'
  ];
  for (const name of keep) {
    const body = real.buildDownloadPostBody('https://example.com/a', { Cookie: 'x=1' }, name);
    assert.equal(body.filename, name, name + ' 应照常透传');
  }
});

// 17) F5 单元：background.js 生产代码 looksLikeUrlQueryString 判定矩阵
//     （与 Rust 侧 looks_like_url_query_string 同标准：含=且含& / 以?开头 /
//       decode 后含=；正常文件名不得命中）
test('background.js looksLikeUrlQueryString 判定矩阵（生产代码真身）', () => {
  const f = loadRealPostBodyFns().looksLikeUrlQueryString;
  // query 串形态 → true
  assert.equal(f('format=epub&lang=zh&page=x'), true);
  assert.equal(f('?a=b'), true);
  assert.equal(f('page=%E4%B8%AD%E5%B1%B1%E7%8B%BC%E5%82%B3'), true);
  // 正常文件名 → false
  assert.equal(f('test.epub'), false);
  assert.equal(f('希臘公廈.epub'), false);
  assert.equal(f('Far East Spring 2027_001.pdf'), false);
  assert.equal(f('bc8df8d8c2-147_165756-0.html'), false);
  assert.equal(f('download'), false);
  // 单侧形态（只含 = 或只含 &）与百分号非编码用途不命中
  assert.equal(f('key=value.txt'), false);
  assert.equal(f('Tom & Jerry.pdf'), false);
  assert.equal(f('100%_done.txt'), false);
  // 边界：空值/非字符串不命中
  assert.equal(f(''), false);
  assert.equal(f(undefined), false);
  assert.equal(f(null), false);
});
