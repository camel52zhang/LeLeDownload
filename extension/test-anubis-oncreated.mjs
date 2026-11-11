// 回归测试：自动接管通用分支的「浏览器请求上下文」组装
// （对应 extension/background.js 中 buildBrowserHeaders / readCookieStringForUrl /
//   getBrowserUA / shouldSkipAutoCapture / fallbackFilenameFromUrl /
//   buildDownloadPostBody / captureDownloadItem / handleGenericCapture / onCreated 监听器）
//
// 目的：验证 downloads.onCreated 通用分支对「先过 JS 反爬挑战再给文件」站点
// （维基文库 EPUB/MOBI/PDF 导出，域名 ws-export.wmcloud.org，被 Anubis 工作量证明
// 挑战把守，第一跳只返回 text/html 挑战页）能组装出浏览器请求上下文：
//   Cookie（该 URL 的浏览器会话 cookie）+ User-Agent（真实浏览器 UA）+ Referer
// 并与 item.filename 一并 POST 给 App，让 App 下到真文件而非挑战页 HTML；
// 组装失败 / Cookie 超长 → 回退无头发送，兜底（不取消浏览器下载）行为不变。
//
// 纯函数逻辑与 onCreated 处理器在本文件内照搬 background.js 实现（node --test 无 chrome
// 运行环境），chrome.* API 以 globalThis.chrome 打桩模拟，sendToLeleDownload 以桩记录调用。
//
// 运行： node --test extension/test-anubis-oncreated.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中对应函数保持一致（chrome.* 经 globalThis 打桩）
// ---------------------------------------------------------------------------

const DEFAULT_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BROWSER_UA_STORAGE_KEY = 'lele_browser_ua';
const MAX_COOKIE_HEADER_BYTES = 16384;

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

function buildDownloadPostBody(url, headers, filename) {
  const body = { url: url, timestamp: Date.now() };
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    body.headers = headers;
  }
  if (filename) {
    body.filename = filename;
  }
  return body;
}

// 以下三者为 onCreated 处理器骨架的镜像（sendToLeleDownload / notify 以桩替换）

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

async function captureDownloadItem(item, filename) {
  let headers = null;
  try {
    headers = await buildBrowserHeaders(item.url, item.referrer);
    if (headers['Cookie'] && headers['Cookie'].length > MAX_COOKIE_HEADER_BYTES) {
      headers = null;
    }
  } catch (e) {
    headers = null;
  }
  return sendToLeleDownload(item.url, headers || undefined, filename);
}

async function handleGenericCapture(item, filename) {
  const res = await captureDownloadItem(item, filename);
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

// 4) 健壮性：Cookie 头超过 16KB → 回退无头发送（App 侧也会因单头超 8KB 丢弃）
test('Cookie 头超过 16KB 时应回退无头发送', async () => {
  resetState();
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'huge', value: 'x'.repeat(17000) }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].headers, undefined, '超长 Cookie 应回退无头发送');
});

// 4b) 边界：Cookie 头未超限（含 16KB 整）应正常携带
test('Cookie 头未超限时应正常携带下发', async () => {
  resetState();
  const value = 'x'.repeat(16384 - 'ok='.length);
  installChromeMock({
    storageData: { lele_browser_ua: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36' },
    cookieList: [{ name: 'ok', value: value }]
  });

  handleOnCreated(WSEXPORT_ITEM);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].headers['Cookie'], 'ok=' + value, '未超限 Cookie 应携带');
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
