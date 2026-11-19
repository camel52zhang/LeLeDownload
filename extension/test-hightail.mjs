// 回归测试：Hightail 公开分享解析 —— 直接加载 extension/background.js 真实源码。
//
// 链路（2026-11-19 真机抓包确认）：
//   sessionInfo → spaces/url/<shareId> → files/<spaceId>/untagged → download/<versionId>
// 本文件对 background.js 里的 Hightail 函数做「原样抽取 + new Function 执行」，
// 保证对真实源码的改动能被行为断言抓到（而非测试副本自洽）。
//
// 运行： node --test extension/test-hightail.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');

const FN_NAMES = [
  'detectNetdiskPlatform',
  'extractHightailShareId',
  'ensureHightailAuthHeaders',
  'fetchHightailChildren',
  'resolveHightail',
  'fetchJson',
  'bytesToSize',
];

// ------------------ 工具：从源码切出 function NAME(...) {...} ------------------
function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('background.js 中找不到函数：' + name);
  const pre = src.slice(Math.max(0, i - 8), i);
  const isAsync = /(^|\s)async\s+$/.test(pre);
  const start = isAsync ? i - 'async '.length : i;
  let depth = 0, seen = false;
  let k = src.indexOf('{', i);
  const q = { str: null, tpl: 0, line: false, block: false };
  for (; k < src.length; k++) {
    const c = src[k], p = src[k - 1];
    if (q.line) { if (c === '\n') q.line = false; continue; }
    if (q.block) { if (c === '/' && p === '*') q.block = false; continue; }
    if (q.str) { if (c === q.str && p !== '\\') q.str = null; continue; }
    if (q.tpl) { if (c === '`' && p !== '\\') q.tpl = 0; continue; }
    if (c === '/' && src[k + 1] === '/') { q.line = true; continue; }
    if (c === '/' && src[k + 1] === '*') { q.block = true; continue; }
    if (c === '"' || c === "'") { q.str = c; continue; }
    if (c === '`') { q.tpl = 1; continue; }
    if (c === '{') { depth++; seen = true; }
    else if (c === '}') { depth--; if (seen && depth === 0) return src.slice(start, k + 1); }
  }
  throw new Error('花括号未闭合：' + name);
}

function loadRealImpl() {
  const parts = [];
  for (const c of ['HIGHTAIL_API', 'HIGHTAIL_UA', 'HIGHTAIL_REFERER', 'HIGHTAIL_AUTH_RULE_ID']) {
    const i = BG.indexOf('const ' + c + ' =') >= 0 ? BG.indexOf('const ' + c + ' =') : BG.indexOf('let ' + c + ' =');
    if (i < 0) throw new Error('background.js 中找不到常量：' + c);
    // 常量均为单行声明；UA 字符串内部含 ';'，不能用 indexOf(';') 截断
    const e = BG.indexOf('\n', i);
    parts.push(BG.slice(i, e < 0 ? BG.length : e));
  }
  for (const n of FN_NAMES) parts.push(extractFunction(BG, n));
  parts.push('return {' + FN_NAMES.join(',') + '};');
  return new Function(parts.join('\n'))();
}
const IMPL = loadRealImpl();

// ------------------ fetch / chrome 替身 ------------------
function res(body, init = {}) {
  const status = init.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText || '',
    url: init.url || '',
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? init.location || null : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let lastCalls = [];
function mockFetch(router) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    const r = await router(u, opts || {});
    if (!r) throw new Error('未预期的请求：' + u);
    return r;
  };
  lastCalls = calls;
  return calls;
}

let dnrRules = [];
function mockChrome() {
  dnrRules = [];
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: async ({ addRules, removeRuleIds }) => {
        dnrRules = dnrRules.filter((r) => !(removeRuleIds || []).includes(r.id));
        dnrRules.push(...(addRules || []));
      },
    },
  };
}

const SHARE = 'tHUPrxIRuD';
const SHARE_URL = 'https://spaces.hightail.com/receive/' + SHARE;
const SPACE_ID = 'sp-f69db944-799f-4d0a-aadb-a558470c28d3';
const SESSION_ID = '30036f2419ec07fb16d1bfdcf90fa8e325e5b7f356ad4bd766a8e1f4a1f69cc7_s';

const sessionInfo = () => res({ sessionId: SESSION_ID, entitlements: {} });
const spaceInfo = () => res({ id: SPACE_ID, status: 'SEND', url: SHARE, privileges: ['SPACE_DOWNLOAD'] });
const oneFile = (over = {}) => Object.assign({
  name: 'CD708000008 Sb Hr Bell Jean_NIGHT AT THE THEATER_59.5x182 IN RPT_SENT.tif',
  size: 3162188564,
  fileId: 'fi-335b9858-3934-4574-85fc-65261f5d3d46',
  versionId: 'fv-7b61e904-539a-4231-836a-71e3128406d3',
  isDirectory: false,
  isDeleted: false,
}, over);
const listing = (children, over = {}) => res(Object.assign({ children, totalFileCount: String(children.length) }, over));

// 按 URL 片段路由的标准全链路
function standardRouter(childrenByParent) {
  return (u) => {
    if (u.includes('/auth/sessionInfo')) return sessionInfo();
    if (u.includes('/spaces/url/')) return spaceInfo();
    if (u.includes('/files/') && u.includes('/untagged')) return listing(childrenByParent[''] || []);
    if (u.includes('/spacetags/files/')) {
      const m = u.match(/\/spacetags\/files\/([^?]+)/);
      return listing(childrenByParent[decodeURIComponent(m ? m[1] : '')] || []);
    }
    return null;
  };
}

// ------------------ 平台识别 ------------------
test('[实源] detectNetdiskPlatform 精确识别 Hightail 官方域，不误伤相似域名', () => {
  assert.equal(IMPL.detectNetdiskPlatform(SHARE_URL), 'hightail');
  assert.equal(IMPL.detectNetdiskPlatform('https://SPACES.HIGHTAIL.COM/receive/abc'), 'hightail');
  assert.equal(IMPL.detectNetdiskPlatform('https://a.spaces.hightail.com/receive/abc'), 'hightail');
  // 变异拦截点：不能用宽松 includes('hightail')
  assert.equal(IMPL.detectNetdiskPlatform('https://spaces.hightail.com.evil.com/receive/abc'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://hightail.com/receive/abc'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://nothightail.com/x'), null);
  // 既有平台不被挤掉
  assert.equal(IMPL.detectNetdiskPlatform('https://pan.baidu.com/s/1a'), 'baidu');
  assert.equal(IMPL.detectNetdiskPlatform('https://we.tl/t-x'), 'wetransfer');
});

test('[实源] extractHightailShareId 覆盖正常/畸形输入且一律不抛异常', () => {
  assert.equal(IMPL.extractHightailShareId(SHARE_URL), SHARE);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/receive/' + SHARE + '/'), SHARE);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/receive/' + SHARE + '?utm=1'), SHARE);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/receive/' + SHARE + '#f'), SHARE);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/'), null);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/receive/'), null);
  assert.equal(IMPL.extractHightailShareId('https://spaces.hightail.com/files/' + SHARE), null);
  for (const bad of ['', 'not a url', null, undefined, 'javascript:alert(1)']) {
    assert.equal(IMPL.extractHightailShareId(bad), null, '畸形输入应返回 null：' + String(bad));
  }
});

// ------------------ 单文件分享（用户当前案例） ------------------
test('[实源] resolveHightail 单文件：走完四步链路并返回真实名/大小/Cookie 头', async () => {
  mockChrome();
  const calls = mockFetch(standardRouter({ '': [oneFile()] }));
  const out = await IMPL.resolveHightail(SHARE_URL, '');

  assert.equal(out.files.length, 1);
  const f = out.files[0];
  assert.equal(f.name, oneFile().name);
  assert.equal(f.size, '2.95 GB');
  assert.equal(f.url, 'https://download.spaces.hightail.com/api/v1/download/fv-7b61e904-539a-4231-836a-71e3128406d3?redirectOnError=%2Freceive%2FtHUPrxIRuD');
  assert.equal(f.headers.Cookie, 'sessionId=' + SESSION_ID);
  assert.equal(f.headers.Referer, 'https://spaces.hightail.com/');
  assert.ok(/Chrome\//.test(f.headers['User-Agent']));

  // 链路顺序：sessionInfo → spaces/url → files/untagged
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes('/auth/sessionInfo'));
  assert.ok(calls[1].url.includes('/spaces/url/tHUPrxIRuD?status=SEND'));
  assert.ok(calls[2].url.includes('/files/' + SPACE_ID + '/untagged'));
  assert.ok(calls[2].url.includes('spaceUrl=tHUPrxIRuD'));

  // DNR 注入规则覆盖 api.spaces.hightail.com
  assert.equal(dnrRules.length, 1);
  assert.equal(dnrRules[0].condition.urlFilter, '||api.spaces.hightail.com/');
  const hdrs = dnrRules[0].action.requestHeaders;
  assert.ok(hdrs.some((h) => h.header === 'Cookie' && h.value === 'sessionId=' + SESSION_ID));
});

// ------------------ 多文件 + 目录递归 + 分页 ------------------
test('[实源] resolveHightail 多文件：顶层 + 目录递归全部展开', async () => {
  mockChrome();
  const dirId = 'fi-dir-1';
  const nested = oneFile({ name: 'nested.tif', versionId: 'fv-nested', size: 2048 });
  const calls = mockFetch(standardRouter({
    '': [oneFile({ name: 'top.tif', versionId: 'fv-top', size: 1024 }), { fileId: dirId, isDirectory: true, name: 'folder' }],
    [dirId]: [nested],
  }));
  const out = await IMPL.resolveHightail(SHARE_URL, '');
  assert.equal(out.files.length, 2);
  assert.deepEqual(out.files.map((f) => f.name).sort(), ['nested.tif', 'top.tif']);
  assert.ok(calls.some((c) => c.url.includes('/spacetags/files/' + dirId)), '应请求目录子项端点');
});

test('[实源] resolveHightail 目录环不会死循环（seenDirs 去重）', async () => {
  mockChrome();
  const dirId = 'fi-loop';
  mockFetch(standardRouter({
    '': [{ fileId: dirId, isDirectory: true, name: 'loop' }],
    [dirId]: [{ fileId: dirId, isDirectory: true, name: 'loop' }, oneFile({ name: 'leaf.bin', versionId: 'fv-leaf' })],
  }));
  const out = await IMPL.resolveHightail(SHARE_URL, '');
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].name, 'leaf.bin');
});

test('[实源] resolveHightail 超过一页时分批拉取', async () => {
  mockChrome();
  const page1 = Array.from({ length: 100 }, (_, i) => oneFile({ name: 'f' + i + '.bin', versionId: 'fv-' + i }));
  const page2 = [oneFile({ name: 'last.bin', versionId: 'fv-last' })];
  let page = 0;
  mockFetch((u) => {
    if (u.includes('/auth/sessionInfo')) return sessionInfo();
    if (u.includes('/spaces/url/')) return spaceInfo();
    if (u.includes('/files/') && u.includes('/untagged')) return listing(page++ === 0 ? page1 : page2);
    return null;
  });
  const out = await IMPL.resolveHightail(SHARE_URL, '');
  assert.equal(out.files.length, 101);
  assert.ok(out.files.some((f) => f.name === 'last.bin'));
});

// ------------------ 异常分支 ------------------
test('[实源] resolveHightail 非 Hightail 链接直接抛错，不发任何请求', async () => {
  mockChrome();
  const calls = mockFetch(() => null);
  await assert.rejects(() => IMPL.resolveHightail('https://pan.baidu.com/s/1a', ''), /无法从链接提取 Hightail 分享 ID/);
  assert.equal(calls.length, 0);
});

test('[实源] resolveHightail sessionInfo 失败时抛错且不继续后续链路', async () => {
  mockChrome();
  const calls = mockFetch((u) => (u.includes('/auth/sessionInfo') ? res('<html>err</html>', { status: 500 }) : null));
  await assert.rejects(() => IMPL.resolveHightail(SHARE_URL, ''), /建立会话失败/);
  assert.equal(calls.length, 1);
});

test('[实源] resolveHightail sessionInfo 缺 sessionId 时抛错', async () => {
  mockChrome();
  mockFetch((u) => (u.includes('/auth/sessionInfo') ? res({ entitlements: {} }) : null));
  await assert.rejects(() => IMPL.resolveHightail(SHARE_URL, ''), /未返回 sessionId/);
});

test('[实源] resolveHightail 分享失效（无 space id）时抛明确错误', async () => {
  mockChrome();
  mockFetch((u) => {
    if (u.includes('/auth/sessionInfo')) return sessionInfo();
    if (u.includes('/spaces/url/')) return res({ status: 'EXPIRED' });
    return null;
  });
  await assert.rejects(() => IMPL.resolveHightail(SHARE_URL, ''), /未返回 space id/);
});

test('[实源] resolveHightail 空分享 / 全部条目无 versionId 时抛错', async () => {
  mockChrome();
  for (const children of [[], [oneFile({ versionId: '' })], [oneFile({ isDeleted: true })], [oneFile({ gone: true })]]) {
    mockFetch(standardRouter({ '': children }));
    await assert.rejects(() => IMPL.resolveHightail(SHARE_URL, ''), /没有可下载文件/);
  }
});

test('[实源] ensureHightailAuthHeaders 在无 chrome/DNR 时静默降级不抛', async () => {
  const saved = globalThis.chrome;
  delete globalThis.chrome;
  try {
    await IMPL.ensureHightailAuthHeaders(SESSION_ID);
  } finally {
    globalThis.chrome = saved;
  }
});

// ------------------ 变异守卫：源码关键片段必须存在 ------------------
test('[实源] 源码关键契约防变异', () => {
  assert.ok(BG.includes("case 'hightail': return await resolveHightail(req.url, req.pwd);"), 'dispatcher 必须挂载 hightail');
  assert.ok(BG.includes("h === 'spaces.hightail.com' || h.endsWith('.spaces.hightail.com')"), '平台识别必须精确匹配');
  assert.ok(BG.includes('https://download.spaces.hightail.com/api/v1/download/'), '下载直链基址不可改');
  assert.ok(BG.includes("'Cookie': 'sessionId=' + sessionId"), '回传 App 的 Cookie 头不可丢');
});
