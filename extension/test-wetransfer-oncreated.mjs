// 回归测试：WeTransfer 原生下载 URL 判定与浏览器头组装
// （对应 extension/background.js 中 isWetransferDownloadUrl / assembleWetransferHeaders / buildWetransferHeaders）
//
// 目的：验证 background.js 的 downloads.onCreated 处理器在抓到
//   https://wetransfer.com/download/<slug>?id=<base64>
// 这一浏览器原生下载代理地址时，能识别为 WeTransfer 下载并组装出含
//   Referer / Origin / User-Agent（浏览器 UA）/ Cookie（会话）
// 的请求头，从而让 App 引擎带浏览器头真正下到正确文件（修复「接管了却下不下来」）。
//
// 纯函数逻辑（判定 + 头组装）在本文件内照搬 background.js 实现，便于 node --test 直接运行；
// buildWetransferHeaders 依赖 chrome.cookies.getAll，本测试以 globalThis.chrome 打桩模拟。
//
// 运行： node --test extension/test-wetransfer-oncreated.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中对应函数保持一致（仅 buildWetransferHeaders 用 globalThis.chrome 打桩）
// ---------------------------------------------------------------------------

// 判定是否为 WeTransfer 下载地址（与 extension/background.js 实现保持一致）
// 覆盖三类真实形态：
//   1) 流式代理 wetransfer.com/download/<slug>?id=<base64>
//   2) 直连下载域 download./filedownload./transfer.wetransfer.com
//   3) 2026 实际文件 CDN *-files.wetransfer.net（Expires= + Signature= 签名 URL）
// 注意：CDN 判定用 endsWith('files.wetransfer.net')，绝不用 endsWith('.wetransfer.net')，
// 否则 ekstrom / bsp-proxy / preview-eu 等 API/预览域名会被误判，破坏页面下载初始化。
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

// 由会话 Cookie 串组装下载请求头（纯函数）
function assembleWetransferHeaders(cookieString) {
  const headers = {
    'Referer': 'https://wetransfer.com/',
    'Origin': 'https://wetransfer.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (cookieString) {
    headers['Cookie'] = cookieString;
  }
  return headers;
}

// 用 chrome.cookies.getAll 读取指定 URL 可见的 Cookie，拼成 "k=v; k=v"（按名去重，后者覆盖前者）。
// 与 extension/background.js 中 readCookieStringForUrl 实现一致（失败抛错，由调用方降级）。
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
      if (name) map[name] = pair.trim(); // 按名去重，后者覆盖前者
    }
  }
  return Object.keys(map).map((k) => map[k]).join('; ');
}

// 用 chrome.cookies.getAll 取 wetransfer.com 的会话 Cookie，拼成 Cookie 头后组装完整下载头。
// 与 background.js 实现一致，仅读取 globalThis.chrome（测试中以打桩替换）。
async function buildWetransferHeaders() {
  let cookieString = '';
  try {
    cookieString = await readCookieStringForUrl('https://wetransfer.com/');
  } catch (_) { /* cookie 不可用时 Cookie 头为空，仍带 UA/Referer/Origin */ }
  return assembleWetransferHeaders(cookieString);
}

// 轻量去重冷却：与 background.js 中 wetransferCooldownMap / WETRANSFER_COOLDOWN_MS /
// isWetransferCaptureCooling 保持一致（本文件内副本，避免依赖 chrome 运行环境）。
const wetransferCooldownMap = new Map();
const WETRANSFER_COOLDOWN_MS = 1500;
function isWetransferCaptureCooling(url) {
  const now = Date.now();
  const last = wetransferCooldownMap.get(url) || 0;
  if (now - last < WETRANSFER_COOLDOWN_MS) {
    return true;
  }
  wetransferCooldownMap.set(url, now);
  return false;
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// 1) local-bartender 代理地址 → 判定为 WeTransfer 下载，且组装出含四类头的 headers
test('local-bartender 代理地址应判定为 WeTransfer 下载并带浏览器头', async () => {
  const url = 'https://wetransfer.com/download/local-bartender?id=eyJhcGlCYXNlIjoiL2FwaS92NCJ9';
  assert.equal(isWetransferDownloadUrl(url), true);

  // 打桩 chrome.cookies.getAll 返回固定会话 Cookie
  globalThis.chrome = {
    cookies: {
      getAll: (opts, cb) => {
        assert.equal(opts.url, 'https://wetransfer.com/');
        cb([
          { name: '_wt_session', value: 'abc123' },
          { name: 'm_wetransfer_api', value: 'tok-xyz' }
        ]);
      }
    },
    runtime: { lastError: null }
  };

  const headers = await buildWetransferHeaders();
  assert.equal(headers['Referer'], 'https://wetransfer.com/');
  assert.equal(headers['Origin'], 'https://wetransfer.com');
  assert.ok(headers['User-Agent'].includes('Chrome/120.0.0.0'), 'User-Agent 应为浏览器 UA');
  assert.ok(headers['Cookie'].includes('_wt_session=abc123'), 'Cookie 应含会话令牌');
  assert.ok(headers['Cookie'].includes('m_wetransfer_api=tok-xyz'), 'Cookie 应含 API 令牌');
  // 不应携带 App 默认 UA 标记
  assert.ok(!headers['User-Agent'].includes('LeLe-Download'), '不应使用 App 默认 UA');
});

// 2) 其它 /download/ 子路径（如 /download/foo）同样判定命中
test('wetransfer.com/download/foo 子路径也应判定为 WeTransfer 下载', () => {
  const url = 'https://wetransfer.com/download/foo?id=eyJzbHVnIjoiZm9vIn0';
  assert.equal(isWetransferDownloadUrl(url), true);
});

// 3) 非 wetransfer 域（如 example.com）不应判定为 WeTransfer 下载
test('非 wetransfer 域的普通文件 URL 不应判定为 WeTransfer 下载', () => {
  const url = 'https://example.com/some/file.zip';
  assert.equal(isWetransferDownloadUrl(url), false);
});

// 4) 误判隔离：CDN 判定必须限定在 files.wetransfer.net，
//    绝不能把预览 / API / 代理子域（preview-eu / ekstrom / bsp-proxy）误判为文件，
//    否则会破坏页面下载初始化；分享短链 we.tl 与无关域名同样不应命中。
test('预览/API 子域、分享短链、无关域名均不应判定为 WeTransfer 下载', () => {
  // 预览与 API 子域：误判会破坏页面下载初始化（content-script 会短路真实请求）
  assert.equal(isWetransferDownloadUrl('https://preview-eu.wetransfer.net/preview.pdf'), false);
  assert.equal(isWetransferDownloadUrl('https://ekstrom.wetransfer.net/api/v1/x'), false);
  assert.equal(isWetransferDownloadUrl('https://bsp-proxy.wetransfer.net/proxy'), false);
  // 分享短链（需先展开为 downloads 页面，本身不是文件地址）
  assert.equal(isWetransferDownloadUrl('https://we.tl/t-FcwxddGsw8aNmQeh'), false);
  // wetransfer.com 主域的非 /download/ 路径（下载落地页，不是文件）
  assert.equal(isWetransferDownloadUrl('https://wetransfer.com/downloads/abc/123?t_exp=1'), false);
  // 无关域名
  assert.equal(isWetransferDownloadUrl('https://example.com/some/file.zip'), false);
  assert.equal(isWetransferDownloadUrl('https://evil-files.wetransfer.net.attacker.com/x.zip'), false);
})

// 4b) 修复目标：直连下载域应判定为 WeTransfer 下载（旧版只认 /download/ 代理，导致漏加浏览器头）
test('直连下载域 download./filedownload./transfer.wetransfer.com 应判定为 WeTransfer 下载', () => {
  assert.equal(isWetransferDownloadUrl('https://download.wetransfer.com/abc.zip'), true);
  assert.equal(isWetransferDownloadUrl('https://filedownload.wetransfer.com/abc.zip'), true);
  assert.equal(isWetransferDownloadUrl('https://transfer.wetransfer.com/abc.zip'), true);
});

// 4c) 修复目标：2026 实际文件 CDN（*-files.wetransfer.net 签名 URL）应判定为 WeTransfer 下载。
//     这是用户反馈「点了下载没正确接管」的核心形态 —— 单文件下载箭头直连签名 CDN，
//     旧版判定漏掉它 → 走普通接管无浏览器头 → App 引擎被 WAF/鉴权拒绝。
test('2026 文件 CDN *-files.wetransfer.net 签名 URL 应判定为 WeTransfer 下载', () => {
  assert.equal(isWetransferDownloadUrl('https://eu-west-1-files.wetransfer.net/abc'), true);
  assert.equal(
    isWetransferDownloadUrl('https://eu-west-1-files.wetransfer.net/transfer/1/f.zip?Expires=1788195362&Signature=abc'),
    true
  );
  assert.equal(isWetransferDownloadUrl('https://us-east-1-files.wetransfer.net/f.xlsx?Expires=1&Signature=b'), true);
});

// 4d) 三类形态都应组装出浏览器头（Referer/Origin/UA/Cookie），确保 App 引擎能带头下载
test('三类 WeTransfer 形态均应组装出含 Referer/Origin/浏览器 UA/Cookie 的头', async () => {
  globalThis.chrome = {
    cookies: {
      getAll: (opts, cb) => cb([{ name: '_wt_session', value: 'sess-1' }])
    },
    runtime: { lastError: null }
  };
  const urls = [
    'https://wetransfer.com/download/local-bartender?id=eyJhIjoiYiJ9',
    'https://download.wetransfer.com/abc.zip',
    'https://eu-west-1-files.wetransfer.net/f.zip?Expires=1&Signature=s'
  ];
  for (const u of urls) {
    assert.equal(isWetransferDownloadUrl(u), true, u + ' 应判定为 WeTransfer 下载');
  }
  const headers = await buildWetransferHeaders();
  assert.equal(headers['Referer'], 'https://wetransfer.com/');
  assert.equal(headers['Origin'], 'https://wetransfer.com');
  assert.ok(headers['User-Agent'].includes('Chrome/120.0.0.0'));
  assert.ok(headers['Cookie'].includes('_wt_session=sess-1'));
});

// 5) cookie 为空时仍带 UA/Referer/Origin，但不带 Cookie 头
test('无会话 Cookie 时头仍含 UA/Referer/Origin，但不含 Cookie', async () => {
  globalThis.chrome = {
    cookies: {
      getAll: (opts, cb) => cb([]) // 无 cookie
    },
    runtime: { lastError: null }
  };
  const headers = await buildWetransferHeaders();
  assert.equal(headers['Referer'], 'https://wetransfer.com/');
  assert.equal(headers['Origin'], 'https://wetransfer.com');
  assert.ok(headers['User-Agent'].includes('Chrome/120.0.0.0'));
  assert.equal(headers['Cookie'], undefined, '无 cookie 时不带 Cookie 头');
});

// 6) cookie 同名去重：后者覆盖前者
test('同名 Cookie 应按名去重，后者覆盖前者', async () => {
  globalThis.chrome = {
    cookies: {
      getAll: (opts, cb) => cb([
        { name: '_wt_session', value: 'old' },
        { name: '_wt_session', value: 'new' }
      ])
    },
    runtime: { lastError: null }
  };
  const headers = await buildWetransferHeaders();
  assert.equal(headers['Cookie'], '_wt_session=new');
});

// 7) chrome.cookies.getAll 不可用时不应抛错，仍返回带 UA 的头
test('chrome.cookies 不可用时 buildWetransferHeaders 不应抛错', async () => {
  globalThis.chrome = undefined; // 模拟无 chrome 命名空间（如非扩展环境）
  const headers = await buildWetransferHeaders();
  assert.equal(headers['Referer'], 'https://wetransfer.com/');
  assert.equal(headers['User-Agent'].includes('Chrome/120.0.0.0'), true);
  assert.equal(headers['Cookie'], undefined);
});

// 8) 冷却逻辑：同一 URL 首次可接管（false），1.5s 内重复触发应跳过（true）
//    这是需求明确的「防重复接管」核心行为，此前未被任何用例覆盖。
test('同一 WeTransfer URL 在冷却期内重复触发应被跳过', () => {
  const url = 'https://wetransfer.com/download/cooldown-test?id=abc';
  assert.equal(isWetransferCaptureCooling(url), false, '首次触发应可接管（返回 false）');
  assert.equal(isWetransferCaptureCooling(url), true, '冷却期内重复触发应跳过（返回 true）');
});

// 9) 冷却按 URL 独立：不同 URL 互不干扰（不影响其它下载的接管 / 不误伤其它路径）
test('不同 WeTransfer URL 的冷却应相互独立', () => {
  const urlA = 'https://wetransfer.com/download/url-a?id=1';
  const urlB = 'https://wetransfer.com/download/url-b?id=2';
  assert.equal(isWetransferCaptureCooling(urlA), false);
  assert.equal(isWetransferCaptureCooling(urlB), false, '不同 URL 不应被 urlA 的冷却阻塞');
});
