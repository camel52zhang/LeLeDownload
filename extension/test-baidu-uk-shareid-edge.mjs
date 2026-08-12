// 边界/对抗用例：百度网盘 yunData 解析（QA 独立验证，commit 7a552c8）
//
// 本文件与 test-baidu-uk-shareid.mjs 一样，把 background.js 的三个纯函数/异步函数
// 原样内联（MV3 background.js 不是 ES module，无法 import），以便 mock globalThis.fetch
// 做隔离测试。三个函数实现逐字拷贝自 extension/background.js 574-632。
//
// 覆盖背景任务要求的对抗场景：
//   a. yunData 字符串值里的转义引号 \" / 路径反斜杠 —— 不能让 extractYunData 的字符串跳过循环挂起或提前截断
//   b. uk/shareid 作为更长 key 的子串（myuk / buk）—— pickNum 不得误匹配
//   c. 单引号定界符——extractYunData 必须兼容 " 与 '（其值分支已支持）；并标注 pickNum 对单引号 key 的已知限制
//   d. api/shareinfo 返回 errno:-12（需密码，无 data）后，带 pwd 的 POST 兜底成功，绝不抛错/挂起
//   e. 两端都失败（页面无 yunData 且 shareinfo 返回 {}）—— 返回空，调用方抛「链接可能已失效」
//   f. uk 作为嵌套属性出现在顶层 uk 之前 —— 标注 pickNum 取首个匹配的特性及其对真实 Baidu schema 的安全性
//
// 运行： node --test extension/test-baidu-uk-shareid-edge.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ===== 以下实现逐字拷贝自 extension/background.js (574-632) =====

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

// fetchJson 镜像 background.js：包 globalThis.fetch，非 JSON 抛错（支撑 baiduResolveUkShareid 策略 B）
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

// ===== 工具：记录型 fetch mock =====
function makeRecorder() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) || '' });
    return fn._handler(String(url), opts || {});
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// a. yunData 字符串值含转义引号 \" 与路径反斜杠 \d —— 不得挂起/提前截断
//    （真实 Baidu 文件名常含引号/空格，这是现实场景，不是纯理论）
// ---------------------------------------------------------------------------
test('a. extractYunData 抗转义引号与路径反斜杠：完整抽取且 uk/shareid 正确', () => {
  // 模板字符串里 \\ -> 一个反斜杠，\" -> 一个双引号。
  // 生成的原始 HTML 行：window.yunData = {"filename":"My \"quote\" file.txt", "path":"C:\dir", "uk":123456, "shareid":789012, "errno":0};
  const html = [
    '<!doctype html><html><head>',
    '<script>',
    'window.yunData = {"filename":"My \\"quote\\" file.txt", "path":"C:\\dir", "uk":123456, "shareid":789012, "errno":0};',
    '</script>',
    '</head><body>分享页面</body></html>',
  ].join('\n');

  const yd = extractYunData(html);
  assert.ok(yd.length > 0, '应抽出 yunData 字面量（未挂起）');
  assert.ok(yd.startsWith('{'), '应以 { 开头');
  assert.ok(yd.endsWith('}'), '应在正确的 } 处结束（转义引号/反斜杠未提前截断）');
  // 关键：若循环在 \" 处错误地提前结束字符串，则 shareid 不会被抽到 → 此处断言证明已越过转义引号
  assert.ok(yd.includes('"shareid":789012'), '转义引号之后内容应被完整包含');
  assert.equal(pickNum(yd, 'uk'), '123456');
  assert.equal(pickNum(yd, 'shareid'), '789012');
});

// ---------------------------------------------------------------------------
// b. uk/shareid 作为更长 key 的子串 —— pickNum 不得误匹配 myuk / buk
// ---------------------------------------------------------------------------
test('b. pickNum 不误匹配子串 key（myuk / buk / uk_total）', () => {
  const blob = 'x = { myuk: 1, "buk": 2, "uk_total": 5, "shareid_x": 9 };';
  assert.equal(pickNum(blob, 'uk'), '', 'myuk / buk / uk_total 都不应命中');
  assert.equal(pickNum(blob, 'shareid'), '', 'shareid_x 不应命中');

  // 正向对照：真实 key 应命中
  assert.equal(pickNum('"uk": 42, "shareid": 7', 'uk'), '42');
  assert.equal(pickNum('"uk": 42, "shareid": 7', 'shareid'), '7');
  // 带下划线的更长 key 不应抢在真实 uk 之前
  assert.equal(pickNum('"uk_total": 5, "uk": 9', 'uk'), '9');
});

// ---------------------------------------------------------------------------
// c. 单引号定界符 —— extractYunData 必须兼容 " 与 '（其值分支已支持单引号）
// ---------------------------------------------------------------------------
test('c. extractYunData 处理单引号定界符（单引号键值 + 含双引号的单引号字符串值）', () => {
  const html = [
    '<html><body><script>',
    "window.yunData = { 'uk': 123, 'shareid': 456, 'name': 'a \"quoted\" value' };",
    '</script></body></html>',
  ].join('\n');
  const yd = extractYunData(html);
  assert.ok(yd.length > 0, '单引号 yunData 应被抽出');
  assert.ok(yd.includes("'uk': 123"), '应保留单引号键');
  assert.ok(yd.includes("'shareid': 456"), '应保留单引号键');
  // 单引号字符串值里的双引号 'a "quoted" value' 不应破坏括号/字符串匹配
  assert.ok(yd.endsWith('}'), '应在正确 } 处结束');
});

// ---------------------------------------------------------------------------
// c(已知限制). pickNum 当前只兼容 "uk":123 与 uk:123，不支持单引号 key。
//   但百度真实 yunData 是 JSON（双引号 key），故该限制对现实链接无影响。
//   此处锁定「当前行为」以便未来若改成支持单引号时能被发现。
// ---------------------------------------------------------------------------
test('c(已知限制). pickNum 不解析单引号 key —— 百度真实 yunData 用双引号故非现实缺陷', () => {
  const ydSingle = "{ 'uk': 123, 'shareid': 456 }";
  assert.equal(pickNum(ydSingle, 'uk'), '');
  assert.equal(pickNum(ydSingle, 'shareid'), '');
  // 双引号等价写法可正确命中 —— 证明解析逻辑本身正确，仅缺单引号分支
  assert.equal(pickNum('{ "uk": 123, "shareid": 456 }', 'uk'), '123');
  assert.equal(pickNum('{ "uk": 123, "shareid": 456 }', 'shareid'), '456');
});

// ---------------------------------------------------------------------------
// d. 策略 B：api/shareinfo 先返回 errno:-12（需密码，无 data），带 pwd 的 POST 兜底成功
// ---------------------------------------------------------------------------
test('d. 策略 B：errno -12(需密码)无 data → 带 pwd POST 兜底成功', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/init')) {
      return { text: async () => '<html><body>请登录后查看</body></html>', ok: true };
    }
    if (u.includes('api/shareinfo')) {
      const call = rec.calls[rec.calls.length - 1];
      if (call.method === 'POST') {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: 123456, shareid: 789012 } }), ok: true };
      }
      // GET：errno -12 且 data 为空（无 uk/shareid）
      return { text: async () => JSON.stringify({ errno: -12, data: {} }), ok: true };
    }
    throw new Error('unexpected fetch url: ' + u);
  };
  globalThis.fetch = rec;

  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '123456', shareid: '789012' }, 'errno -12 后应经 POST 兜底成功');
  const post = rec.calls.find((c) => c.method === 'POST');
  assert.ok(post, '应发起 api/shareinfo 的 POST 重试');
  assert.ok(post.body.includes('pwd=h7bq'), 'POST body 应携带提取码');
});

// d(子). errno -12 但调用方未提供 pwd → 优雅返回空，不抛错/不挂起
test('d(子). 策略 B：errno -12 且无 pwd → 优雅返回空（不抛错/不挂起）', async () => {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('share/init')) return { text: async () => '<html><body>x</body></html>', ok: true };
    if (u.includes('api/shareinfo')) return { text: async () => JSON.stringify({ errno: -12 }), ok: true }; // 无 data 字段
    throw new Error('unexpected ' + u);
  };
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', '');
  assert.deepStrictEqual(r, { uk: '', shareid: '' }, '无 pwd 时不应抛错，应返回空值');
});

// ---------------------------------------------------------------------------
// e. 双失败：页面无 yunData 且 api/shareinfo 返回 {}（无 data）→ 返回空，
//    调用方 resolveBaidu 的守卫抛「链接可能已失效」（复刻 background.js 649-651）
// ---------------------------------------------------------------------------
test('e. 双失败：页面无 yunData 且 shareinfo 返回 {} → 空值 + 调用方抛「链接可能已失效」', async () => {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('share/init')) return { text: async () => '<html><body>请登录后查看</body></html>', ok: true };
    if (u.includes('api/shareinfo')) return { text: async () => JSON.stringify({}), ok: true };
    throw new Error('unexpected ' + u);
  };
  const r = await baiduResolveUkShareid('YuZkVISgaH_6xSLGxqoLfw', 'h7bq');
  assert.deepStrictEqual(r, { uk: '', shareid: '' }, '双失败应返回空值');

  // 复刻 resolveBaidu 的守卫逻辑（background.js lines 649-651）
  const guard = ({ uk, shareid }, surl) => {
    if (!uk || !shareid) {
      throw new Error('百度获取 uk/shareid 失败（链接可能已失效或提取码不正确，errno -7）：' + surl);
    }
  };
  assert.throws(() => guard(r, 'YuZkVISgaH_6xSLGxqoLfw'), /链接可能已失效/,
    '调用方应能抛清晰错误而非崩溃');
});

// ---------------------------------------------------------------------------
// f(已知限制). pickNum 取「第一个」出现的 key。若嵌套 uk 出现在顶层 uk 之前会被误取。
//   百度真实 yunData：uk/shareid 为顶层，file_list 内不含 uk → 不触发，安全。
//   此处锁定该特性，并为「真实 schema 安全」提供依据。
// ---------------------------------------------------------------------------
test('f(已知限制). pickNum 取首个 uk：嵌套 uk 在顶层前会被误取（百度真实 schema 不触发）', () => {
  const blob = '{"file_list":[{"uk":999,"name":"x"}],"uk":123,"shareid":789}';
  assert.equal(pickNum(blob, 'uk'), '999', '当前实现返回首个匹配（嵌套 uk）');

  // 复刻真实 Baidu yunData：uk/shareid 顶层，list 内无 uk → 取顶层正确值
  const realBlob = '{"uk":123,"shareid":789,"file_list":{"errno":0,"list":[{"fs_id":1,"path":"/a","size":10}]}}';
  assert.equal(pickNum(realBlob, 'uk'), '123', '真实 schema 下取顶层 uk 正确');
  assert.equal(pickNum(realBlob, 'shareid'), '789', '真实 schema 下取顶层 shareid 正确');
});
