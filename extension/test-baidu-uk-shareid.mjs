// 回归测试：百度网盘 uk / shareid 解析（从 background.js 照搬同款实现，隔离测试）
//
// 背景：百度已停用 share/linkinfo 接口（对 share/init?surl= 短链返回 errno -7），
//       导致「链接失效」误报。新方案：优先抓取分享页 window.yunData 提取 uk/shareid，
//       并以 api/shareinfo 兜底（带密分享用 POST 传 pwd 重试）。
//
// 本测试锁定三个纯函数/异步函数的行为，避免该回退逻辑被再次改坏：
//   1) extractYunData —— 手动括号匹配，从 HTML 抽出完整 window.yunData 字面量；
//   2) pickNum       —— 从 yunData 文本按 key 取数字（兼容 "uk":123 与 uk:123）；
//   3) baiduResolveUkShareid —— 策略 A 页面 yunData 命中即返回，否则策略 B api/shareinfo 兜底。
//
// 运行： node --test extension/test-baidu-uk-shareid.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中三个函数完全一致（隔离测试，便于 mock fetch）
// ---------------------------------------------------------------------------

// 从分享页 HTML 提取 window.yunData 完整对象字面量（手动括号匹配，兼容字符串内花括号）
function extractYunData(html) {
  const m = html.match(/window\.yunData\s*=\s*\{/);
  if (!m) return '';
  const i = m.index + m[0].length - 1; // 定位到 '{'
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (c === '"' || c === "'") {
      const q = c; j++;
      // 注意：每个字符都必须推进 j，否则遇到非转义字符会死循环（字符串里几乎所有字符都不是反斜杠）
      while (j < html.length && html[j] !== q) { if (html[j] === '\\') j++; j++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(i, j + 1); }
  }
  return '';
}

// 从 yunData 文本里按 key 取数字值（兼容 "uk":123 / uk:123 / uk:'0' / uk:"0" 各种写法）
function pickNum(blob, key) {
  // key 与分隔符之间、分隔符与值之间均允许一个可选引号（单或双），以兼容不同来源页面
  const m = blob.match(new RegExp('(?:^|[^A-Za-z0-9_])' + key + '\\s*["\']?\\s*[:=]\\s*["\']?\\s*(\\d+)'));
  return m ? m[1] : '';
}

// fetchJson 镜像 background.js：包 globalThis.fetch，非 JSON 抛错（用于支撑 baiduResolveUkShareid 策略 B）
// 注意：与真实 fetchJson 保持一致的「[HTTP 状态码] 非 JSON 响应」报错格式；mock 的 fetch 返回值均带 status 字段以配合。
async function fetchJson(url, opts) {
  const res = await fetch(url, opts || {});
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { throw new Error('[HTTP ' + res.status + '] 非 JSON 响应: ' + text.slice(0, 300)); }
}

// 获取百度分享的 uk / shareid：优先页面 window.yunData，兜底 api/shareinfo
async function baiduResolveUkShareid(surl, pwd) {
  let uk = '', shareid = '';
  // 策略 A：分享页 window.yunData（百度已停用 share/linkinfo，返回 errno -7）
  try {
    const res = await fetch('https://pan.baidu.com/share/init?surl=' + encodeURIComponent(surl), {
      credentials: 'include', cache: 'no-store',
    });
    const yd = extractYunData(await res.text());
    if (yd) {
      // 分享所有者 uk 在 share_uk 字段（uk 是当前登录用户，未登录时为 '0'，不可用）；单/双引号都要兼容
      uk = pickNum(yd, 'share_uk') || pickNum(yd, 'uk');
      shareid = pickNum(yd, 'shareid');
    }
    // 百度对新短链会 302 规范化成 1 前缀的 canonical surl，api/shareinfo 必须用它否则 404
    try {
      const cs = new URL(res.url).searchParams.get('surl');
      if (cs) surl = cs;
    } catch (_) {}
  } catch (_) {}
  // 策略 B：api/shareinfo 兜底（带密分享传 pwd 重试），必须用规范化后的 canonical surl
  if (!uk || !shareid) {
    try {
      const url = 'https://pan.baidu.com/api/shareinfo?shorturl=' + encodeURIComponent(surl) + '&sub=1';
      let li = await fetchJson(url, {});
      let d = (li && li.data) || li || {};
      uk = uk || String(d.share_uk || d.uk || ''); shareid = shareid || String(d.shareid || '');
      if ((!uk || !shareid) && pwd) {
        li = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'pwd=' + encodeURIComponent(pwd),
        });
        d = (li && li.data) || li || {};
        uk = uk || String(d.share_uk || d.uk || ''); shareid = shareid || String(d.shareid || '');
      }
    } catch (_) {}
  }
  return { uk, shareid };
}

// ---------------------------------------------------------------------------
// 测试夹具：mock globalThis.fetch
//   - share/init 返回给定的分享页 HTML
//   - api/shareinfo 返回给定的 JSON（GET/POST 统一；如需区分可改用记录型 mock）
// ---------------------------------------------------------------------------
function makeFetchMock(initHtml, shareinfoJson, initUrl) {
  return async (url) => {
    const u = String(url);
    if (u.includes('share/init')) {
      // initUrl 用于模拟百度 302 后的最终 URL（surl 被规范化为 1 前缀）；缺省用请求 URL
      return { url: initUrl || u, text: async () => initHtml, ok: true, status: 200 };
    }
    if (u.includes('api/shareinfo')) {
      return { url: u, text: async () => JSON.stringify(shareinfoJson), ok: true, status: 200 };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
}

// 分享页 HTML：yunData 用标准带引号 key 的对象字面量
const HTML_QUOTED_YUNDATA = [
  '<!doctype html><html><head>',
  '<script>window.yunData = {"uk":123456,"shareid":789012,"sharename":"test","file_list":[],"errno":0};</script>',
  '</head><body>分享页面</body></html>',
].join('\n');

// 分享页 HTML：yunData 用不带引号 key 的对象字面量，且字符串/嵌套结构里含有花括号，
// 用来证明括号匹配器能正确跳过字符串内的 } 与嵌套 {}。
const HTML_UNQUOTED_NESTED_YUNDATA = [
  '<html><body>',
  '<script>',
  "window.yunData = {uk: 123456, shareid: 789012, sharename: \"a}b}c\", list: [{n: 1, s: \"x{y}z\"}], desc: {deep:{inner:true}}};",
  '</script>',
  '</body></html>',
].join('\n');

// ---------------------------------------------------------------------------
// Test 1: extractYunData + pickNum 从带引号 key 的 yunData 正确取值
// ---------------------------------------------------------------------------
test('extractYunData+pickNum 从带引号 key 的 yunData 提取 uk/shareid', () => {
  const yd = extractYunData(HTML_QUOTED_YUNDATA);
  assert.ok(yd.length > 0, '应抽出 yunData 字面量');
  assert.ok(yd.startsWith('{"uk":123456'), '抽出内容应以 { 开头并含 uk');
  assert.equal(pickNum(yd, 'uk'), '123456');
  assert.equal(pickNum(yd, 'shareid'), '789012');
  // 取不到的 key 应返回空串，而非误命中
  assert.equal(pickNum(yd, 'ukuk'), '');
  assert.equal(pickNum(yd, 'shareid_x'), '');
});

// ---------------------------------------------------------------------------
// Test 2: extractYunData 对不带引号 key + 字符串/嵌套中花括号的鲁棒性
// ---------------------------------------------------------------------------
test('extractYunData 鲁棒处理未引号 key 与字符串/嵌套内的花括号', () => {
  const yd = extractYunData(HTML_UNQUOTED_NESTED_YUNDATA);
  assert.ok(yd.length > 0, '应抽出 yunData 字面量');
  // 字符串 "a}b}c" 与 "x{y}z" 中的花括号不得提前截断；嵌套 {} 也须配平
  assert.ok(yd.endsWith('}'), '抽出内容须在正确的最外层 } 处结束');
  assert.equal(pickNum(yd, 'uk'), '123456');
  assert.equal(pickNum(yd, 'shareid'), '789012');
});

// 额外健壮用例：分享页里 window.yunData 不存在时 extractYunData 返回空串
test('分享页无 window.yunData 时 extractYunData 返回空串', () => {
  assert.equal(extractYunData('<html><body>请登录后查看</body></html>'), '');
});

// ---------------------------------------------------------------------------
// Test 3: baiduResolveUkShareid 命中策略 A（分享页 yunData）即返回，不依赖 api/shareinfo
// ---------------------------------------------------------------------------
test('baiduResolveUkShareid 优先采用分享页 yunData（策略 A）', async () => {
  globalThis.fetch = makeFetchMock(
    HTML_QUOTED_YUNDATA,
    { errno: 0, data: { uk: 111, shareid: 222 } }, // 与 yunData 不一致，用于证明未被使用
  );
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '123456', shareid: '789012' });
});

// ---------------------------------------------------------------------------
// Test 4: baiduResolveUkShareid 在页面无 yunData 时回退 api/shareinfo（策略 B）
// ---------------------------------------------------------------------------
test('baiduResolveUkShareid 页面无 yunData 时回退 api/shareinfo（策略 B）', async () => {
  globalThis.fetch = makeFetchMock(
    '<html><body>请登录后查看</body></html>',
    { errno: 0, data: { uk: 123456, shareid: 789012 } },
  );
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '123456', shareid: '789012' });
});

// ---------------------------------------------------------------------------
// Test 5: 策略 B 带密分享时，GET 拿不到则走 POST 传 pwd 重试
// ---------------------------------------------------------------------------
test('策略 B 带密分享：GET 无数据时用 POST+pwd 兜底成功', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('share/init')) {
      return { text: async () => '<html><body>请登录后查看</body></html>', ok: true, status: 200 };
    }
    if (u.includes('api/shareinfo')) {
      calls.push({ method: (opts && opts.method) || 'GET', body: (opts && opts.body) || '' });
      // GET 不返回 uk/shareid；POST 带 pwd 才返回
      if ((opts && opts.method) === 'POST') {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: 123456, shareid: 789012 } }), ok: true, status: 200 };
      }
      return { text: async () => JSON.stringify({ errno: 0, data: {} }), ok: true, status: 200 };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '123456', shareid: '789012' });
  // 应至少发起一次 POST 且 body 携带 pwd
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '应发起 api/shareinfo 的 POST 请求');
  assert.ok(post.body.includes('pwd=h7bq'), 'POST body 应携带提取码');
});

// ---------------------------------------------------------------------------
// Test 6: 两端都拿不到 uk/shareid 时返回空串（由 resolveBaidu 抛 errno -7 友好错误）
// ---------------------------------------------------------------------------
test('yunData 与 shareinfo 均无 uk/shareid 时返回空值', async () => {
  globalThis.fetch = makeFetchMock(
    '<html><body>请登录后查看</body></html>',
    { errno: -1, data: {} },
  );
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', '');
  assert.deepStrictEqual(r, { uk: '', shareid: '' });
});

// ===========================================================================
// 回归用例：真实百度分享页（单引号 uk + share_uk 字段）
//   之前 pickNum 只认双引号，导致 uk:'0' 取不到 → 抛 errno -7；
//   且分享所有者 uk 在 share_uk，而非当前用户的 uk。
// ===========================================================================
const HTML_REALISTIC = [
  '<!doctype html><html><head>',
  "<script>window.yunData={skinName:'white', neglect:1, bdstoken:'', uk:'0', loginstate:'0', share_uk:\"1099672802734\", shareid:\"55046620247\"};</script>",
  '</head><body>分享页面</body></html>',
].join('\n');

test('pickNum 兼容单引号包裹的值（uk:\'0\' 返回 0，share_uk 返回真值）', () => {
  const yd = extractYunData(HTML_REALISTIC);
  assert.ok(yd.length > 0, '应抽出 yunData 字面量');
  // 之前单引号值取不到，这里必须取到
  assert.equal(pickNum(yd, 'uk'), '0', '单引号包裹的 uk 必须取到');
  assert.equal(pickNum(yd, 'share_uk'), '1099672802734', 'share_uk 必须取到');
  assert.equal(pickNum(yd, 'shareid'), '55046620247', 'shareid 必须取到');
});

test('真实分享页（单引号 + share_uk）策略 A 以 share_uk 作为 uk', async () => {
  globalThis.fetch = makeFetchMock(
    HTML_REALISTIC,
    { errno: 0, data: { uk: 999, shareid: 888 } }, // 与 yunData 不一致，证明未被使用
  );
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '1099672802734', shareid: '55046620247' });
});

// ===========================================================================
// 回归用例：策略 B 必须用规范化后的 canonical surl（1 前缀）
//   之前直接传 bare surl 调用 api/shareinfo 会 404；百度对 ?surl=bare 会 302 成 1 前缀。
// ===========================================================================
test('策略 B 使用 302 规范化后的 canonical surl（1 前缀）调用 api/shareinfo', async () => {
  let shareinfoUrl = '';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('share/init')) {
      // 模拟百度 302 重定向后的最终 URL：surl 被规范化为 1 前缀
      return {
        url: 'https://pan.baidu.com/share/init?surl=1YuZkVISgaH_6xSLGxqoLfw&from=init',
        text: async () => '<html><body>请登录后查看</body></html>',
        ok: true, status: 200,
      };
    }
    if (u.includes('api/shareinfo')) {
      shareinfoUrl = u;
      return { url: u, text: async () => JSON.stringify({ errno: 0, data: { uk: 1099672802734, shareid: 55046620247 } }), ok: true, status: 200 };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '1099672802734', shareid: '55046620247' });
  assert.ok(shareinfoUrl.includes('shorturl=1YuZkVISgaH_6xSLGxqoLfw'), 'api/shareinfo 必须用 canonical surl，实际: ' + shareinfoUrl);
  assert.ok(!shareinfoUrl.includes('shorturl=YuZkVISgaH_6xSLGxqoLfw'), 'api/shareinfo 不得用 bare surl，实际: ' + shareinfoUrl);
});

// ===========================================================================
// resolveBaidu 全流程镜像 + 回归用例
//
// 背景（第 3 轮修复）：uk/shareid 已能取到，但 api/share/list 返回 HTTP 404
// （HTML 响应体 → fetchJson 抛「非 JSON 响应」）。两个独立缺陷：
//   1) api/share/list 与 api/sharedownload 未显式声明 credentials:'include'，
//      匿名请求被百度网关以 404 拒绝（只有 share/init 带了登录态才成功）；
//   2) 提取码丢失：用户只粘贴了含 &pwd=h7bq 的 URL，App 侧 req.pwd 为空，
//      导致请求 URL 出现 &pwd=（空），带密分享必然取不到文件列表。
//
// 注意：真实 background.js 的 fetchJson 通过
//   Object.assign({ signal, cache:'no-store', credentials:'include' }, opts)
// 也提供了 credentials 默认值；本镜像的 fetchJson（见上）刻意**不注入该默认值**，
// 直接透传 opts，这样下面的断言才能真正锁定「调用点显式传了 credentials」——
// 若有人把调用点的 credentials:'include' 删掉，用例会立刻失败。
// ===========================================================================

// bytesToSize 镜像 background.js
function bytesToSize(n) {
  if (n === undefined || n === null || n === '') return '';
  n = Number(n);
  if (isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + u[i];
}

// getCookieString 的可控 mock：真实实现读 chrome.cookies，此处用变量模拟登录态
let mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
async function getCookieString(_url) {
  return mockCookie;
}

// resolveBaidu 镜像 background.js（与 lines 643-683 一致）
async function resolveBaidu(url, pwd) {
  const cookie = await getCookieString('https://pan.baidu.com');
  if (!/BDUSS=/.test(cookie)) throw new Error('未检测到百度网盘登录态(BDUSS)，请先在浏览器登录');
  const u = new URL(url);
  let surl = (u.searchParams.get('surl') || '').trim();
  if (!surl) {
    const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    surl = m ? m[1] : '';
  }
  if (!surl) throw new Error('无法从链接提取 surl（请使用 pan.baidu.com 的分享链接）');
  // 链接里可能直接带 &pwd= 提取码；优先用调用方传入的，其次从 URL 取
  pwd = (pwd || '').trim() || (u.searchParams.get('pwd') || '').trim() || '';
  const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const { uk, shareid } = await baiduResolveUkShareid(surl, pwd);
  if (!uk || !shareid) {
    throw new Error('百度获取 uk/shareid 失败（链接可能已失效或提取码不正确，errno -7）：' + surl);
  }
  const pwdLabel = pwd ? ('pwd 已填(' + pwd.length + '位)') : 'pwd 缺失(空)';
  // 百度带密分享：list 之前必须先 api/share/verify 换 BDCLND cookie，否则网关直接返回
  // 404 HTML 页面（非 JSON 响应）。公开分享(pwd 空)跳过。
  if (pwd) {
    try {
      const verify = await fetchJson('https://pan.baidu.com/api/share/verify?shareid=' + shareid + '&uk=' + uk, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: 'pwd=' + encodeURIComponent(pwd),
      });
      const ven = (typeof verify.errno !== 'undefined') ? verify.errno : '';
      const vem = verify.errmsg || verify.error_msg || '';
      if (ven !== '' && Number(ven) !== 0) {
        throw new Error('百度提取码错误' + (vem ? '（errno ' + ven + ': ' + vem + '）' : '（errno ' + ven + '）') + '（pwd 已填(' + pwd.length + '位), uk=' + uk + ', shareid=' + shareid + '）');
      }
    } catch (e) {
      if (/百度提取码错误/.test(e.message)) throw e;
      throw new Error('百度 api/share/verify 失败（pwd 已填(' + pwd.length + '位), uk=' + uk + ', shareid=' + shareid + '）：' + e.message);
    }
  }
  let list;
  try {
    list = await fetchJson('https://pan.baidu.com/api/share/list?channel=chunlei&clienttype=0&web=1&uk=' + uk + '&shareid=' + shareid + '&order=asc&desc=0&showempty=0&pwd=' + encodeURIComponent(pwd || '') + '&dir=/', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
  } catch (e) {
    throw new Error('百度 api/share/list 失败（' + pwdLabel + ', uk=' + uk + ', shareid=' + shareid + '）：' + e.message);
  }
  const files = (list.list || []);
  if (!files.length) {
    const en = (typeof list.errno !== 'undefined') ? list.errno : '';
    const em = list.errmsg || list.error_msg || '';
    throw new Error('百度分享内没有文件或密码错误' + (en !== '' ? '（errno ' + en + (em ? ': ' + em : '') + '）' : '') + '（' + pwdLabel + ', uk=' + uk + ', shareid=' + shareid + '）');
  }
  const out = [];
  const ts = list.timestamp || Math.floor(Date.now() / 1000);
  const sign = list.sign || '';
  for (const f of files) {
    let sd;
    try {
      sd = await fetchJson('https://pan.baidu.com/api/sharedownload?channel=chunlei&clienttype=0&web=1&sign=' + encodeURIComponent(sign) + '&timestamp=' + ts, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'encrypt=0&product=share&uk=' + uk + '&primaryid=' + shareid + '&fid_list=%5B' + f.fs_id + '%5D' + (pwd ? '&pwd=' + encodeURIComponent(pwd) : ''),
      });
    } catch (e) {
      throw new Error('百度 api/sharedownload 失败（' + pwdLabel + ', uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）：' + e.message);
    }
    const dlink = sd.list && sd.list[0] && sd.list[0].dlink;
    if (!dlink) {
      const en = (typeof sd.errno !== 'undefined') ? sd.errno : '';
      const em = sd.errmsg || sd.error_msg || '';
      throw new Error('百度未返回 dlink' + (en !== '' ? '（errno ' + en + (em ? ': ' + em : '') + '）' : '') + '（' + pwdLabel + ', uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）：' + JSON.stringify(sd).slice(0, 200));
    }
    out.push({ name: f.server_filename, size: bytesToSize(f.size), url: dlink, headers: { 'User-Agent': BAIDU_UA, Referer: 'https://pan.baidu.com/', Cookie: cookie } });
  }
  return out;
}

// 用户实际粘贴的链接：surl 与提取码都在 URL 里，调用方 req.pwd 为空
const USER_SHARE_URL = 'https://pan.baidu.com/share/init?surl=YuZkVISgaH_6xSLGxqoLfw&pwd=h7bq';

// 全流程 fetch mock：记录每次调用的 URL 与 options，供断言 credentials / pwd
// init → HTML_REALISTIC（share_uk=1099672802734, shareid=55046620247）
// api/share/list → 1 个文件；api/sharedownload → dlink
function installBaiduFlowFetchMock() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/verify')) {
      // 第 5 轮新增：带密分享 list 前必须先 verify 换 BDCLND，默认返回成功（errno:0）
      return {
        url: u, ok: true, status: 200,
        text: async () => JSON.stringify({ errno: 0 }),
      };
    }
    if (u.includes('api/share/list')) {
      return {
        url: u, ok: true, status: 200,
        text: async () => JSON.stringify({
          errno: 0,
          list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }],
          timestamp: 123,
          sign: 's',
        }),
      };
    }
    if (u.includes('api/sharedownload')) {
      return {
        url: u, ok: true, status: 200,
        text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }),
      };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
  return calls;
}

// 便捷取用：按 URL 关键字找到那次调用
function findCall(calls, needle) {
  return calls.find((c) => c.url.includes(needle));
}

// ---------------------------------------------------------------------------
// Test A: 调用方 pwd 为空时，必须从 URL 的 &pwd= 兜底提取，并带进 api/share/list
//         （回归：此前 pwd 为空 → 请求出现 &pwd= → 带密分享 404 / 空列表）
// ---------------------------------------------------------------------------
test('resolveBaidu 在 pwd 为空时从 URL 提取提取码并带入 api/share/list', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = installBaiduFlowFetchMock();

  const out = await resolveBaidu(USER_SHARE_URL, ''); // 调用方 req.pwd 为空

  const listCall = findCall(calls, 'api/share/list');
  assert.ok(listCall, '应发起 api/share/list 请求');
  assert.ok(listCall.url.includes('pwd=h7bq'), 'api/share/list 必须携带从 URL 提取的 pwd=h7bq，实际: ' + listCall.url);
  assert.ok(!/[?&]pwd=(&|$)/.test(listCall.url), 'api/share/list 不得出现空 pwd 参数，实际: ' + listCall.url);
  // uk/shareid 仍取自 yunData 的 share_uk / shareid
  assert.ok(listCall.url.includes('uk=1099672802734'), 'api/share/list 应带 share_uk');
  assert.ok(listCall.url.includes('shareid=55046620247'), 'api/share/list 应带 shareid');
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// Test B: api/share/list 与 api/sharedownload 必须带 credentials:'include'
//         （回归：匿名请求被百度网关以 404 + HTML 拒绝 → 「非 JSON 响应」）
// ---------------------------------------------------------------------------
test('resolveBaidu 的 share/list 与 sharedownload 均带 credentials:include', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = installBaiduFlowFetchMock();

  await resolveBaidu(USER_SHARE_URL, '');

  const listCall = findCall(calls, 'api/share/list');
  const sdCall = findCall(calls, 'api/sharedownload');
  assert.ok(listCall, '应发起 api/share/list 请求');
  assert.ok(sdCall, '应发起 api/sharedownload 请求');
  assert.equal(listCall.opts.credentials, 'include', 'api/share/list 必须显式带 credentials:include（否则百度返回 404 HTML）');
  assert.equal(sdCall.opts.credentials, 'include', 'api/sharedownload 必须显式带 credentials:include（否则百度返回 404 HTML）');
  // share/init 早已带登录态，回归时一并锁定
  const initCall = findCall(calls, 'share/init');
  assert.equal(initCall.opts.credentials, 'include', 'share/init 必须保持 credentials:include');
  // sharedownload 仍是 POST，且提取码进 body（带密分享必需）
  assert.equal(sdCall.opts.method, 'POST');
  assert.ok(sdCall.opts.body.includes('pwd=h7bq'), 'sharedownload body 应携带提取码，实际: ' + sdCall.opts.body);
  assert.ok(sdCall.opts.body.includes('fid_list=%5B1%5D'), 'sharedownload body 应携带 fid_list');
});

// ---------------------------------------------------------------------------
// Test C: 成功流程返回带 dlink 的文件列表（含下载引擎所需的 Cookie/UA/Referer 头）
// ---------------------------------------------------------------------------
test('resolveBaidu 成功流程返回带 dlink 的文件', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  installBaiduFlowFetchMock();

  const out = await resolveBaidu(USER_SHARE_URL, '');

  assert.equal(out.length, 1, '应解析出 1 个文件');
  assert.equal(out[0].name, 'a.txt');
  assert.equal(out[0].url, 'https://d.pcs.baidu.com/dl/a.txt');
  assert.equal(out[0].size, '10.00 B');
  // 直链由 Rust 侧下载，不受浏览器禁止头限制，必须回传 Cookie/UA/Referer
  assert.ok(/BDUSS=/.test(out[0].headers.Cookie), '回传 headers 必须含 BDUSS Cookie');
  assert.equal(out[0].headers.Referer, 'https://pan.baidu.com/');
  assert.ok(out[0].headers['User-Agent'].includes('Chrome/'), '回传 headers 必须含浏览器 UA');
});

// ---------------------------------------------------------------------------
// Test D: 调用方显式传入的 pwd 优先于 URL 中的 pwd（避免兜底逻辑反向覆盖用户输入）
// ---------------------------------------------------------------------------
test('resolveBaidu 优先使用调用方传入的 pwd，其次才取 URL 中的 pwd', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = installBaiduFlowFetchMock();

  await resolveBaidu(USER_SHARE_URL, '  zzzz  '); // 带首尾空格，应被 trim

  const listCall = findCall(calls, 'api/share/list');
  assert.ok(listCall.url.includes('pwd=zzzz'), '应优先用调用方传入的 pwd 并 trim，实际: ' + listCall.url);
  assert.ok(!listCall.url.includes('pwd=h7bq'), 'URL 中的 pwd 不得覆盖调用方传入值');
});

// ---------------------------------------------------------------------------
// Test E: 无提取码的公开分享，body 不应追加空的 &pwd=
// ---------------------------------------------------------------------------
test('resolveBaidu 公开分享（无 pwd）时 sharedownload body 不追加空 pwd', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = installBaiduFlowFetchMock();

  await resolveBaidu('https://pan.baidu.com/s/1YuZkVISgaH_6xSLGxqoLfw', '');

  const sdCall = findCall(calls, 'api/sharedownload');
  assert.ok(!sdCall.opts.body.includes('pwd='), '无提取码时不得追加 pwd 参数，实际: ' + sdCall.opts.body);
  assert.equal(sdCall.opts.credentials, 'include', '公开分享同样需要登录态');
});

// ---------------------------------------------------------------------------
// Test F: 未登录（cookie 无 BDUSS）时给出明确错误，不发起任何 API 请求
// ---------------------------------------------------------------------------
test('resolveBaidu 未检测到 BDUSS 时抛登录态错误且不发请求', async () => {
  mockCookie = 'STOKEN=xyz789';
  const calls = installBaiduFlowFetchMock();

  await assert.rejects(
    () => resolveBaidu(USER_SHARE_URL, ''),
    /未检测到百度网盘登录态\(BDUSS\)/,
  );
  assert.equal(calls.length, 0, '未登录时不应发起任何网络请求');
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789'; // 复原，避免影响后续用例
});

// ---------------------------------------------------------------------------
// Test G: api/share/list 返回 HTTP 404（网关把带密分享当匿名请求拒掉，HTML 体）
//         → 诊断报错须同时带 [HTTP 404] 与 pwd 状态（URL 自带 &pwd=h7bq，故为「pwd 已填」）
// ---------------------------------------------------------------------------
test('resolveBaidu 当 share/list 返回 404 时诊断报含 [HTTP 404] 与 pwd 已填', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/verify')) {
      // 第 5 轮：verify 先于 list 执行；此处让 verify 成功（errno:0），以复现后续 list 404 的网关拒绝
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0 }) };
    }
    if (u.includes('api/share/list')) {
      // 百度网关对未带登录态/未验证的带密分享返回 404 + HTML，触发 fetchJson 的「非 JSON 响应」分支
      return { url: u, ok: false, status: 404, text: async () => '<html>404 Not Found</html>' };
    }
    throw new Error('unexpected fetch url: ' + u);
  };

  let err;
  await assert.rejects(() => resolveBaidu(USER_SHARE_URL, ''), (e) => { err = e; return true; });
  assert.ok(err, '应当抛出错误');
  assert.ok(err.message.includes('[HTTP 404]'), '诊断应带 HTTP 状态码，实际: ' + err.message);
  assert.ok(err.message.includes('pwd 已填(4位)'), '诊断应含 pwd 已填状态（URL 自带 h7bq），实际: ' + err.message);
  assert.ok(err.message.includes('uk=1099672802734'), '诊断应含所用 uk，实际: ' + err.message);
  assert.ok(err.message.includes('shareid=55046620247'), '诊断应含所用 shareid，实际: ' + err.message);
  assert.ok(err.message.includes('百度 api/share/list 失败'), '错误应被 share/list 的 try/catch 包裹，实际: ' + err.message);
});

// ---------------------------------------------------------------------------
// Test H: api/share/list 返回 200 JSON 但 errno=-12（密码错误/链接失效）
//         → 诊断报错须带 errno -12 与 pwd 状态
// ---------------------------------------------------------------------------
test('resolveBaidu 当 share/list 返回 errno -12 时诊断报含 errno 与 pwd 已填', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/verify')) {
      // 第 5 轮：verify 先于 list 执行；此处让 verify 成功，以复现后续 list 返回 errno -12 的分支
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0 }) };
    }
    if (u.includes('api/share/list')) {
      // 百度对密码错误返回 200 + JSON { errno:-12, errmsg:'密码错误' }，列表为空触发 !files.length 分支
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: -12, errmsg: '密码错误' }) };
    }
    throw new Error('unexpected fetch url: ' + u);
  };

  let err;
  await assert.rejects(() => resolveBaidu(USER_SHARE_URL, ''), (e) => { err = e; return true; });
  assert.ok(err, '应当抛出错误');
  assert.ok(err.message.includes('errno -12'), '诊断应带 errno，实际: ' + err.message);
  assert.ok(err.message.includes('密码错误'), '诊断应带 errmsg，实际: ' + err.message);
  assert.ok(err.message.includes('pwd 已填(4位)'), '诊断应含 pwd 已填状态，实际: ' + err.message);
  assert.ok(err.message.includes('uk=1099672802734'), '诊断应含所用 uk，实际: ' + err.message);
  assert.ok(err.message.includes('shareid=55046620247'), '诊断应含所用 shareid，实际: ' + err.message);
});

// ---------------------------------------------------------------------------
// Test I: 第 5 轮核心回归 —— 带密分享完整链路：先 verify（pwd=h7bq）→ 成功（errno:0）
//         → 随后 list 与 sharedownload 走通，返回带 dlink 的文件；verify 必须被调用 1 次。
// ---------------------------------------------------------------------------
test('resolveBaidu 带密分享：先 api/share/verify 成功再 list 返回 dlink', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {}, method: (opts && opts.method) || 'GET', body: (opts && opts.body) || '' });
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/verify')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0 }) };
    }
    if (u.includes('api/share/list')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }], timestamp: 123, sign: 's' }) };
    }
    if (u.includes('api/sharedownload')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }) };
    }
    throw new Error('unexpected fetch url: ' + u);
  };

  const out = await resolveBaidu(USER_SHARE_URL, ''); // URL 自带 &pwd=h7bq
  assert.equal(out.length, 1, '应解析出 1 个文件');
  assert.equal(out[0].url, 'https://d.pcs.baidu.com/dl/a.txt');

  const verifyCall = calls.find((c) => c.url.includes('api/share/verify'));
  assert.ok(verifyCall, '带密分享必须先调用 api/share/verify');
  assert.equal(verifyCall.method, 'POST', 'verify 必须是 POST');
  assert.ok(verifyCall.body.includes('pwd=h7bq'), 'verify body 应携带提取码，实际: ' + verifyCall.body);
  assert.ok(verifyCall.url.includes('shareid=55046620247'), 'verify URL 应带 shareid');
  assert.ok(verifyCall.url.includes('uk=1099672802734'), 'verify URL 应带 uk');
  const listCall = calls.find((c) => c.url.includes('api/share/list'));
  assert.ok(listCall, 'verify 成功后必须继续调用 api/share/list');
});

// ---------------------------------------------------------------------------
// Test J: 提取码错误 —— verify 返回 errno -9 → 清晰报错，且 list 不得被调用
// ---------------------------------------------------------------------------
test('resolveBaidu 提取码错误时 verify 返回 errno -9 并报错，不再调 list', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u });
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/verify')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: -9, errmsg: '提取码错误' }) };
    }
    throw new Error('unexpected fetch url: ' + u);
  };

  let err;
  await assert.rejects(() => resolveBaidu(USER_SHARE_URL, ''), (e) => { err = e; return true; });
  assert.ok(err, '应当抛出错误');
  assert.ok(err.message.includes('百度提取码错误'), '应报「百度提取码错误」，实际: ' + err.message);
  assert.ok(err.message.includes('errno -9'), '诊断应带 errno -9，实际: ' + err.message);
  assert.ok(err.message.includes('提取码错误'), '诊断应带 errmsg，实际: ' + err.message);
  assert.ok(err.message.includes('pwd 已填(4位)'), '诊断应含 pwd 已填状态，实际: ' + err.message);
  assert.ok(err.message.includes('uk=1099672802734'), '诊断应含所用 uk，实际: ' + err.message);
  assert.ok(err.message.includes('shareid=55046620247'), '诊断应含所用 shareid，实际: ' + err.message);
  // list 绝不被调用
  const listCall = calls.find((c) => c.url.includes('api/share/list'));
  assert.ok(!listCall, '提取码错误时不应继续调用 api/share/list');
});

// ---------------------------------------------------------------------------
// Test K: 公开分享（无 pwd）→ 跳过 verify，直接 list；verify 不得被调用
// ---------------------------------------------------------------------------
test('resolveBaidu 公开分享（无 pwd）时跳过 verify 直接 list', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u });
    if (u.includes('share/init')) {
      return { url: u, ok: true, status: 200, text: async () => HTML_REALISTIC };
    }
    if (u.includes('api/share/list')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0, list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }], timestamp: 123, sign: 's' }) };
    }
    if (u.includes('api/sharedownload')) {
      return { url: u, ok: true, status: 200, text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }) };
    }
    throw new Error('unexpected fetch url: ' + u);
  };

  const out = await resolveBaidu('https://pan.baidu.com/s/1YuZkVISgaH_6xSLGxqoLfw', '');
  assert.equal(out.length, 1, '公开分享应解析出 1 个文件');
  const verifyCall = calls.find((c) => c.url.includes('api/share/verify'));
  assert.ok(!verifyCall, '公开分享（无 pwd）不得调用 api/share/verify');
  const listCall = calls.find((c) => c.url.includes('api/share/list'));
  assert.ok(listCall, '公开分享应直接调用 api/share/list');
});
