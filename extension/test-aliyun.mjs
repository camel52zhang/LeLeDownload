// 回归测试：阿里云盘解析（对齐「零配置自动读取 alipan.com 登录态」实现）
//
// 背景：原实现从站点 cookie 读 refresh_token，但阿里云盘（alipan.com）的
//   refresh_token 存于 localStorage 的 `token` 字段（JSON），并不在 http cookie 里，
//   导致阿里解析永远拿不到 refresh_token 而不可用。
//   新实现（与夸克一致）注入 content-script 到已登录的 alipan.com 页面，读取
//   localStorage 的 token 取 refresh_token，从而「零配置」自动解析：
//     1) getAliyunRefreshToken 优先复用已打开的 alipan.com 标签页注入读取；
//        若无则临时开后台标签页、注入读取后立即关闭（不泄漏用户页面）；
//        兜底读 chrome.storage.local.aliyun_refresh_token（用户手动配置）。
//     2) readAliyunToken 在页面上下文执行，self-contained（只用 localStorage/JSON），
//        整体 try/catch 永不 throw（executeScript 注入函数 throw 会被吞成 result:null）。
//     3) resolveAliyun 用 refresh_token 换 access_token，再按官方分享流程
//        get_share_token → file/list → get_share_link_download_url。
//
// 本测试把上述实现原样内联（MV3 background.js 非 ES module，无法 import），
// 用 mock 的 globalThis.fetch（返回 .text 形态）与 globalThis.chrome
// （mock tabs/scripting/storage）做隔离测试。
//
// 运行： node --test extension/test-aliyun.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node 18+/浏览器均提供全局 navigator（含 userAgent），无需手动设置。
// resolveAliyun 末尾用到 navigator.userAgent，直接依赖 Node 内置即可。

// ===== 以下实现镜像 extension/background.js（与零配置自动读取当前实现一致） =====

// 统一的 JSON 请求封装（与 background.js fetchJson 一致：非 JSON 响应报错带 [HTTP 状态码]）
async function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal, cache: 'no-store', credentials: 'include' }, opts));
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { throw new Error('[HTTP ' + res.status + '] 非 JSON 响应: ' + text.slice(0, 300)); }
  } finally {
    clearTimeout(timer);
  }
}

// getCookieString 的可控 mock：阿里路径已不再依赖 cookie 取 refresh_token，此处返回空
async function getCookieString(_url) { return ''; }

function bytesToSize(n) {
  if (n === undefined || n === null || n === '') return '';
  n = Number(n);
  if (isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + u[i];
}

const ALI_CANARY = 'client=web,app=share,version=v2.3.1';

// 读取 alipan.com 登录态中的 refresh_token（页面上下文执行）。
// 必须 self-contained：只用 localStorage / JSON，不得引用 SW 作用域变量；
// 整体 try/catch 永不 throw（executeScript 注入函数 throw 会被吞成 result:null）。
function readAliyunToken() {
  try {
    const raw = localStorage.getItem('token');
    if (!raw) {
      return { ok: false, step: 'local-storage-empty', reason: '可能未登录 alipan.com' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, step: 'json-parse', reason: String(e) };
    }
    const refreshToken = parsed.refresh_token != null ? parsed.refresh_token : parsed.refreshToken;
    if (refreshToken == null || refreshToken === '') {
      return { ok: false, step: 'field-missing', reason: 'token 中无 refresh_token' };
    }
    return { ok: true, value: String(refreshToken) };
  } catch (err) {
    return { ok: false, step: 'exception', reason: String(err) };
  }
}

// 找一个已打开的 alipan.com / aliyundrive.com 标签页；没有则返回 null
async function getAliyunPageTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.alipan.com/*',
        'https://alipan.com/*',
        'https://www.aliyundrive.com/*',
        'https://aliyundrive.com/*',
      ],
    });
    return tabs && tabs.length ? tabs[0].id : null;
  } catch (_) {
    return null;
  }
}

// 等待标签页加载完成（最多 ~10s）
async function waitTabComplete(tabId) {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return;
    } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// 协调获取阿里云盘 refresh_token（SW 侧，永不抛错，返回 string）
async function getAliyunRefreshToken() {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) return '';
  let tabId = null;
  let tempTabId = null;
  try {
    tabId = await getAliyunPageTab();
    if (tabId == null) {
      const created = await chrome.tabs.create({ url: 'https://www.alipan.com/', active: false });
      tempTabId = created;
      tabId = created.id;
      await waitTabComplete(created.id);
    }
    // 等 SPA 稳定（测试内联版缩短延时，逻辑与源码一致）
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 2; i++) {
      const inj = await chrome.scripting.executeScript({ target: { tabId }, func: readAliyunToken });
      const r = inj && inj[0] && inj[0].result;
      if (r && r.ok && r.value) {
        return r.value;
      }
      console.log('[ali] readAliyunToken attempt', i, '=', JSON.stringify(r));
    }
  } catch (e) {
    console.log('[ali] getAliyunRefreshToken error:', String((e && e.message) || e));
  } finally {
    if (tempTabId != null) {
      try { await chrome.tabs.remove(tempTabId.id); } catch (_) {}
    }
  }
  // 兜底：用户手动配置
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const stored = await new Promise((res) => {
        try {
          chrome.storage.local.get(['aliyun_refresh_token'], (rr) => res((rr && rr.aliyun_refresh_token) || ''));
        } catch (_) { res(''); }
      });
      if (stored) return stored;
    }
  } catch (_) {}
  return '';
}

async function resolveAliyun(url, pwd) {
  const refreshToken = await getAliyunRefreshToken();
  if (!refreshToken) {
    throw new Error('未检测到阿里云盘 refresh_token：请先在 alipan.com 登录（扩展会自动读取登录态）；若仍失败，可在扩展存储手动配置 chrome.storage.local.set({aliyun_refresh_token:"..."})');
  }

  const tokenResp = await fetchJson('https://auth.alipan.com/v2/account/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const accessToken = tokenResp.access_token;
  if (!accessToken) throw new Error('阿里获取 access_token 失败（refresh_token 可能已过期，请重新登录）');

  // share_id 直接从分享链接提取：https://www.alipan.com/s/<shareId>
  const sm = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const shareId = sm ? sm[1] : '';
  if (!shareId) throw new Error('无法从链接提取阿里云盘 share_id');

  const stBody = { share_id: shareId };
  if (pwd) stBody.share_pwd = pwd;
  const st = await fetchJson('https://api.alipan.com/v2/share_link/get_share_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stBody),
  });
  const shareToken = st.share_token;
  if (!shareToken) {
    const code = st.code || '';
    if (String(code).indexOf('SharePwd') >= 0) throw new Error('阿里云盘分享需要提取码，或提取码不正确');
    throw new Error('阿里获取 share_token 失败：' + JSON.stringify(st).slice(0, 200));
  }

  const shareHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + accessToken,
    'x-share-token': shareToken,
    'X-Canary': ALI_CANARY,
  };

  // 列文件（分页 marker 直到取完；单次上限 200）
  const items = [];
  let marker = '';
  do {
    const body = {
      share_id: shareId, parent_file_id: 'root', limit: 200,
      order_by: 'name', order_direction: 'ASC',
      image_thumbnail_process: '', image_url_process: '', video_thumbnail_process: '',
    };
    if (marker) body.marker = marker;
    const flist = await fetchJson('https://api.alipan.com/adrive/v3/file/list', {
      method: 'POST', headers: shareHeaders, body: JSON.stringify(body),
    });
    (flist.items || []).forEach((x) => items.push(x));
    marker = flist.next_marker || '';
  } while (marker && items.length < 1000);

  const files = items.filter((x) => x.type === 'file');
  if (!files.length) throw new Error('阿里分享内没有可下载文件（仅含文件夹时暂不支持递归）');

  const out = [];
  for (const f of files) {
    const dl = await fetchJson('https://api.alipan.com/v2/file/get_share_link_download_url', {
      method: 'POST', headers: shareHeaders,
      body: JSON.stringify({ share_id: shareId, file_id: f.file_id, expire_sec: 600 }),
    });
    const durl = dl.download_url || dl.url;
    if (!durl) throw new Error('阿里未返回直链：' + JSON.stringify(dl).slice(0, 200));
    out.push({
      name: f.name,
      size: bytesToSize(f.size),
      url: durl,
      headers: { Referer: 'https://www.alipan.com/', 'User-Agent': navigator.userAgent },
    });
  }
  return out;
}

// ===========================================================================
// 测试夹具
// ===========================================================================
function makeRecorder() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {}, method: (opts && opts.method) || 'GET', body: (opts && opts.body) || '' });
    return fn._handler(String(url), opts || {});
  };
  fn.calls = calls;
  return fn;
}
function findCall(calls, needle) { return calls.find((c) => c.url.includes(needle)); }

// 构造一个阿里 chrome mock。各回调缺省为「正常但有结果的极简形态」，由测试覆盖。
function makeAliChrome(overrides) {
  const o = overrides || {};
  const tabs = o.tabs || {};
  const storage = o.storage || {};
  return {
    tabs: {
      query: tabs.query || (async () => [{ id: 1 }]),
      create: tabs.create || (async () => ({ id: 99 })),
      get: tabs.get || (async () => ({ status: 'complete' })),
      remove: tabs.remove || (async () => {}),
    },
    scripting: {
      executeScript: o.executeScript || (async () => [{ result: { ok: true, value: 'rt_inject' } }]),
    },
    storage: {
      local: {
        get: storage.get || ((_keys, cb) => cb && cb({})),
      },
    },
    runtime: {},
  };
}

// 默认 fetch 链：auth token / get_share_token / file/list / download_url 全返回正常
function makeAliApiHandler({ accessToken, shareToken, items, downloadUrl, shareCode } = {}) {
  return (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) {
      return { text: async () => JSON.stringify({ access_token: accessToken || 'ATOK' }), ok: true };
    }
    if (s.includes('share_link/get_share_token')) {
      if (shareCode) return { text: async () => JSON.stringify({ code: shareCode }), ok: true };
      return { text: async () => JSON.stringify({ share_token: shareToken || 'STOK' }), ok: true };
    }
    if (s.includes('adrive/v3/file/list')) {
      return { text: async () => JSON.stringify({ items: items || [{ type: 'file', name: 'a.txt', size: 1024, file_id: 'F1' }] }), ok: true };
    }
    if (s.includes('get_share_link_download_url')) {
      return { text: async () => JSON.stringify({ download_url: downloadUrl || 'https://dl.alipan.com/a.txt' }), ok: true };
    }
    throw new Error('unexpected ' + s);
  };
}

// ---------------------------------------------------------------------------
// A1: 公开链接成功 → 返回 [{name,size,url,headers}] 且 url 为 download_url
// ---------------------------------------------------------------------------
test('resolveAliyun 公开链接成功：返回带直链的文件数组，url 为 download_url', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  const rec = makeRecorder();
  rec._handler = makeAliApiHandler({});
  globalThis.fetch = rec;
  try {
    const out = await resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', '');
    assert.equal(out.length, 1, '应解析出 1 个文件');
    assert.equal(out[0].name, 'a.txt');
    assert.equal(out[0].size, bytesToSize(1024));
    assert.equal(out[0].url, 'https://dl.alipan.com/a.txt');
    assert.equal(out[0].headers.Referer, 'https://www.alipan.com/');
    assert.ok(out[0].headers['User-Agent'].length > 0, '回传 UA 不得为空');
    // refresh_token 来自注入读取
    const tokenCall = findCall(rec.calls, 'auth.alipan.com/v2/account/token');
    assert.ok(tokenCall.body.includes('"refresh_token":"rt_123"'), 'token 请求应携带注入读取的 refresh_token，实际: ' + tokenCall.body);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A2: 带提取码正确 → pwd 透传进 get_share_token body 的 share_pwd
// ---------------------------------------------------------------------------
test('resolveAliyun 带提取码：get_share_token body 含 share_pwd', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  const rec = makeRecorder();
  rec._handler = makeAliApiHandler({});
  globalThis.fetch = rec;
  try {
    await resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', 'mypwd');
    const stCall = findCall(rec.calls, 'share_link/get_share_token');
    assert.ok(stCall, '应请求 get_share_token');
    assert.ok(stCall.body.includes('"share_pwd":"mypwd"'), 'get_share_token body 应透传 share_pwd，实际: ' + stCall.body);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A3: 提取码错误 → get_share_token 返回 {code:'SharePwd...'} → 抛「提取码不正确」
// ---------------------------------------------------------------------------
test('resolveAliyun 提取码错误：get_share_token 返回 SharePwd code → 抛「提取码不正确」', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) return { text: async () => JSON.stringify({ access_token: 'ATOK' }), ok: true };
    if (s.includes('share_link/get_share_token')) return { text: async () => JSON.stringify({ code: 'SharePwdInvalid' }), ok: true };
    throw new Error('unexpected ' + s);
  };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', 'bad'), /提取码不正确/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A4: 无 tab 自动开临时页 → 断言最终拿到 rt 且 chrome.tabs.remove(99) 被调用
// ---------------------------------------------------------------------------
test('resolveAliyun 无已开 alipan 页：自动开临时标签页注入读取，结束移除临时页', async () => {
  const removed = [];
  globalThis.chrome = makeAliChrome({
    tabs: {
      query: async () => [],                       // 无已开页面
      create: async () => ({ id: 99 }),            // 临时开 99
      remove: async (id) => { removed.push(id); },
    },
    executeScript: async () => [{ result: { ok: true, value: 'rt' } }],
  });
  const rec = makeRecorder();
  rec._handler = makeAliApiHandler({});
  globalThis.fetch = rec;
  try {
    const out = await resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', '');
    assert.equal(out.length, 1, '应能拿到 rt 并解析出文件');
    assert.ok(removed.includes(99), '应移除临时页 chrome.tabs.remove(99)，实际: ' + JSON.stringify(removed));
    const tokenCall = findCall(rec.calls, 'auth.alipan.com/v2/account/token');
    assert.ok(tokenCall.body.includes('"refresh_token":"rt"'), '应使用注入读取的 rt，实际: ' + tokenCall.body);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A5: storage 兜底 → 无 tab、注入 ok:false，但 chrome.storage.local.aliyun_refresh_token 有值 → 用兜底值
// ---------------------------------------------------------------------------
test('resolveAliyun 注入失败时回退到 chrome.storage.local 手动配置的 refresh_token', async () => {
  globalThis.chrome = makeAliChrome({
    tabs: { query: async () => [], create: async () => ({ id: 99 }) },
    executeScript: async () => [{ result: { ok: false, step: 'local-storage-empty', reason: '未登录' } }],
    storage: { get: (_keys, cb) => cb({ aliyun_refresh_token: 'stored_rt' }) },
  });
  const rec = makeRecorder();
  rec._handler = makeAliApiHandler({});
  globalThis.fetch = rec;
  try {
    const out = await resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', '');
    assert.equal(out.length, 1);
    const tokenCall = findCall(rec.calls, 'auth.alipan.com/v2/account/token');
    assert.ok(tokenCall.body.includes('"refresh_token":"stored_rt"'), '应使用 storage 兜底的 stored_rt，实际: ' + tokenCall.body);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A6: 注入 local-storage-empty 且无 storage → 回退后 resolveAliyun 抛「未检测到阿里云盘 refresh_token」
// ---------------------------------------------------------------------------
test('resolveAliyun 注入失败且无 storage 兜底 → 抛「未检测到阿里云盘 refresh_token」', async () => {
  globalThis.chrome = makeAliChrome({
    tabs: { query: async () => [], create: async () => ({ id: 99 }) },
    executeScript: async () => [{ result: { ok: false, step: 'local-storage-empty', reason: '未登录' } }],
    storage: { get: (_keys, cb) => cb({}) },
  });
  globalThis.fetch = async () => { throw new Error('不应被调用'); };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', ''), /未检测到阿里云盘 refresh_token/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A7: share_token 缺失（非 SharePwd）→ 抛「获取 share_token 失败」
// ---------------------------------------------------------------------------
test('resolveAliyun get_share_token 无 share_token 且无 SharePwd code → 抛「获取 share_token 失败」', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) return { text: async () => JSON.stringify({ access_token: 'ATOK' }), ok: true };
    if (s.includes('share_link/get_share_token')) return { text: async () => JSON.stringify({}), ok: true };
    throw new Error('unexpected ' + s);
  };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', ''), /获取 share_token 失败/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A8: file/list 返回仅文件夹（type!=='file'）→ 抛「没有可下载文件」
// ---------------------------------------------------------------------------
test('resolveAliyun file/list 仅含文件夹 → 抛「没有可下载文件」', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) return { text: async () => JSON.stringify({ access_token: 'ATOK' }), ok: true };
    if (s.includes('share_link/get_share_token')) return { text: async () => JSON.stringify({ share_token: 'STOK' }), ok: true };
    if (s.includes('adrive/v3/file/list')) return { text: async () => JSON.stringify({ items: [{ type: 'folder', name: 'sub', file_id: 'D1' }] }), ok: true };
    throw new Error('unexpected ' + s);
  };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', ''), /没有可下载文件/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A9: download_url 缺失 → 抛「未返回直链」
// ---------------------------------------------------------------------------
test('resolveAliyun get_share_link_download_url 无 download_url → 抛「未返回直链」', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) return { text: async () => JSON.stringify({ access_token: 'ATOK' }), ok: true };
    if (s.includes('share_link/get_share_token')) return { text: async () => JSON.stringify({ share_token: 'STOK' }), ok: true };
    if (s.includes('adrive/v3/file/list')) return { text: async () => JSON.stringify({ items: [{ type: 'file', name: 'a.txt', size: 1024, file_id: 'F1' }] }), ok: true };
    if (s.includes('get_share_link_download_url')) return { text: async () => JSON.stringify({}), ok: true };
    throw new Error('unexpected ' + s);
  };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', ''), /未返回直链/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// A10: access_token 缺失 → 抛「获取 access_token 失败」
// ---------------------------------------------------------------------------
test('resolveAliyun token 接口无 access_token → 抛「获取 access_token 失败」', async () => {
  globalThis.chrome = makeAliChrome({
    executeScript: async () => [{ result: { ok: true, value: 'rt_123' } }],
  });
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('auth.alipan.com/v2/account/token')) return { text: async () => JSON.stringify({}), ok: true };
    throw new Error('unexpected ' + s);
  };
  try {
    await assert.rejects(() => resolveAliyun('https://www.alipan.com/s/AbCdEfGh123', ''), /获取 access_token 失败/);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// 附加 A11: readAliyunToken 页面上下文函数（直接调用，mock localStorage）
//   成功路径：localStorage 的 token 含 refresh_token → {ok:true, value}
// ---------------------------------------------------------------------------
test('readAliyunToken 页面上下文：token 含 refresh_token → ok:true value', () => {
  globalThis.localStorage = {
    store: { token: JSON.stringify({ refresh_token: 'RT_VAL', access_token: 'AT' }) },
    getItem(k) { return this.store[k] != null ? this.store[k] : null; },
  };
  try {
    const r = readAliyunToken();
    assert.equal(r.ok, true);
    assert.equal(r.value, 'RT_VAL');
  } finally {
    delete globalThis.localStorage;
  }
});

// ---------------------------------------------------------------------------
// 附加 A12: readAliyunToken 兼容驼峰 refreshToken + 各失败分支
// ---------------------------------------------------------------------------
test('readAliyunToken：兼容驼峰 refreshToken；localStorage 空/解析失败/缺字段分别返回正确 step', () => {
  // 驼峰兼容
  globalThis.localStorage = {
    store: { token: JSON.stringify({ refreshToken: 'RT_CAMEL' }) },
    getItem(k) { return this.store[k] != null ? this.store[k] : null; },
  };
  try {
    let r = readAliyunToken();
    assert.equal(r.ok, true, '应兼容驼峰 refreshToken');
    assert.equal(r.value, 'RT_CAMEL');

    // 空 localStorage
    globalThis.localStorage.store = {};
    r = readAliyunToken();
    assert.equal(r.ok, false);
    assert.equal(r.step, 'local-storage-empty');

    // 解析失败
    globalThis.localStorage.store = { token: 'not json {' };
    r = readAliyunToken();
    assert.equal(r.ok, false);
    assert.equal(r.step, 'json-parse');

    // 缺字段
    globalThis.localStorage.store = { token: JSON.stringify({ access_token: 'AT' }) };
    r = readAliyunToken();
    assert.equal(r.ok, false);
    assert.equal(r.step, 'field-missing');
  } finally {
    delete globalThis.localStorage;
  }
});
