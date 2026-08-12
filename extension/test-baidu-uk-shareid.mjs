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
  const idx = html.indexOf('window.yunData');
  if (idx < 0) return '';
  const eq = html.indexOf('=', idx);
  if (eq < 0) return '';
  const i = html.indexOf('{', eq);
  if (i < 0) return '';
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

// 从 yunData 文本里按 key 取数字值（兼容 "uk":123 与 uk:123 两种写法）
function pickNum(blob, key) {
  // 兼容 key 带引号（"uk":123）与不带引号（uk:123）两种写法：key 与分隔符之间允许一个可选引号
  const m = blob.match(new RegExp('(?:^|[^A-Za-z0-9_])' + key + '\\s*"?\\s*[:=]\\s*"?(\\d+)"?'));
  return m ? m[1] : '';
}

// fetchJson 镜像 background.js：包 globalThis.fetch，非 JSON 抛错（用于支撑 baiduResolveUkShareid 策略 B）
async function fetchJson(url, opts) {
  const res = await fetch(url, opts || {});
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { throw new Error('非 JSON 响应: ' + text.slice(0, 200)); }
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
    if (yd) { uk = pickNum(yd, 'uk'); shareid = pickNum(yd, 'shareid'); }
  } catch (_) {}
  // 策略 B：api/shareinfo 兜底（带密分享传 pwd 重试）
  if (!uk || !shareid) {
    try {
      const url = 'https://pan.baidu.com/api/shareinfo?shorturl=' + encodeURIComponent(surl) + '&sub=1';
      let li = await fetchJson(url, {});
      let d = (li && li.data) || li || {};
      uk = uk || String(d.uk || ''); shareid = shareid || String(d.shareid || '');
      if ((!uk || !shareid) && pwd) {
        li = await fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'pwd=' + encodeURIComponent(pwd),
        });
        d = (li && li.data) || li || {};
        uk = uk || String(d.uk || ''); shareid = shareid || String(d.shareid || '');
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
function makeFetchMock(initHtml, shareinfoJson) {
  return async (url) => {
    const u = String(url);
    if (u.includes('share/init')) {
      return { text: async () => initHtml, ok: true };
    }
    if (u.includes('api/shareinfo')) {
      return { text: async () => JSON.stringify(shareinfoJson), ok: true };
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
      return { text: async () => '<html><body>请登录后查看</body></html>', ok: true };
    }
    if (u.includes('api/shareinfo')) {
      calls.push({ method: (opts && opts.method) || 'GET', body: (opts && opts.body) || '' });
      // GET 不返回 uk/shareid；POST 带 pwd 才返回
      if ((opts && opts.method) === 'POST') {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: 123456, shareid: 789012 } }), ok: true };
      }
      return { text: async () => JSON.stringify({ errno: 0, data: {} }), ok: true };
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
