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

// 判定是否为 WeTransfer 原生下载代理地址（host 精确为 wetransfer.com，且路径以 /download/ 开头）
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
  return host === 'wetransfer.com' && path.indexOf('/download/') === 0;
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

// 用 chrome.cookies.getAll 取 wetransfer.com 的会话 Cookie，拼成 Cookie 头后组装完整下载头。
// 与 background.js 实现一致，仅读取 globalThis.chrome（测试中以打桩替换）。
async function buildWetransferHeaders() {
  let cookieString = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies && typeof chrome.cookies.getAll === 'function') {
      const cks = await new Promise((resolve) => {
        chrome.cookies.getAll({ url: 'https://wetransfer.com/' }, (cks) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(cks || []);
        });
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
      cookieString = Object.keys(map).map((k) => map[k]).join('; ');
    }
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

// 4) 非 wetransfer 域不应带任何 wetransfer 头（assembleWetransferHeaders 只在判定命中时调用）
test('非 wetransfer 域调用 assembleWetransferHeaders 不应产生 wetransfer 头（逻辑隔离校验）', () => {
  // 即便误调用，组装出的头也应仅含浏览器头、且 Cookie 来自传入串；
  // 此处校验“非 wetransfer 域不调用此函数”的隔离：判定函数返回 false。
  assert.equal(isWetransferDownloadUrl('https://download.wetransfer.com/abc.zip'), false);
  assert.equal(isWetransferDownloadUrl('https://eu-west-1-files.wetransfer.net/abc'), false);
  assert.equal(isWetransferDownloadUrl('https://we.tl/t-FcwxddGsw8aNmQeh'), false);
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
