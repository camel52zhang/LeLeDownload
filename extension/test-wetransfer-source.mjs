// 回归测试：WeTransfer 解析 —— **直接加载 extension/background.js 真实源码** 的一层保险
//
// 为什么需要本文件（QA 复核发现）：
//   test-wetransfer-parse.mjs 里的实现是「照搬 background.js 的副本」。副本测试只能证明
//   「副本自己是自洽的」，对 background.js 的改动**零感知**——实测对 background.js 做 5 处
//   故意破坏（file_ids->file_id / 删 state 检查 / we.tl 改宽松匹配 / 删密码检查 / 删 items
//   检查），19 个用例依旧 155/155 全绿，一个都没抓到。
//
// 本文件补两层网：
//   1) 漂移守卫：比对 background.js 中相关函数与 test-wetransfer-parse.mjs 中副本的可执行
//      逻辑（去注释 / 去 console.log 语句 / 压空白）是否一致 —— 源改了副本没跟着改即失败；
//   2) 真实源码行为测试：把 background.js 的函数原样抽出来执行，即使「源和副本同步改错」，
//      行为断言也能抓到。
//
// 运行： node --test extension/test-wetransfer-source.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const COPY = fs.readFileSync(new URL('./test-wetransfer-parse.mjs', import.meta.url), 'utf8');

const FN_NAMES = [
  'fetchJson',
  'detectNetdiskPlatform',
  'extractWeTransferIds',
  'expandWeTransferUrl',
  'pickWeTransferError',
  'bytesToSize',
  'resolveWeTransfer',
];

// ---------------------------------------------------------------------------
// 工具：扫描式源码处理（正确跳过字符串 / 模板串 / 注释里的花括号）
// ---------------------------------------------------------------------------

// 从 src 中切出 function NAME(...) {...} 的完整源码（含 async 前缀）
function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('background.js 中找不到函数：' + name);
  const pre = src.slice(Math.max(0, i - 8), i);
  const isAsync = /(^|\s)async\s+$/.test(pre);
  const start = isAsync ? i - 'async '.length : i;

  let depth = 0;
  let seen = false;
  let k = src.indexOf('{', i);
  const q = { str: null, tpl: 0, line: false, block: false };
  for (; k < src.length; k++) {
    const c = src[k];
    const p = src[k - 1];
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

// 规范化：去注释、去 console.log 语句（副本为保持测试输出干净刻意省略）、压空白
// 这样比对的是「可执行逻辑」而非排版/日志。
function normalize(code) {
  let out = '';
  const i0 = 0;
  let i = i0;
  const q = { str: null, tpl: 0, line: false, block: false };
  while (i < code.length) {
    const c = code[i];
    const p = i > 0 ? code[i - 1] : '';
    if (q.line) { if (c === '\n') { q.line = false; out += '\n'; } i++; continue; }
    if (q.block) { if (c === '/' && p === '*') q.block = false; i++; continue; }
    if (q.str) { out += c; if (c === q.str && p !== '\\') q.str = null; i++; continue; }
    if (q.tpl) { out += c; if (c === '`' && p !== '\\') q.tpl = 0; i++; continue; }
    if (c === '/' && code[i + 1] === '/') { q.line = true; i++; continue; }
    if (c === '/' && code[i + 1] === '*') { q.block = true; i++; continue; }
    if (c === '"' || c === "'") { q.str = c; out += c; i++; continue; }
    if (c === '`') { q.tpl = 1; out += c; i++; continue; }
    // 整条 console.log(...) 语句连尾部分号一起丢弃
    if (code.startsWith('console.log(', i)) {
      let d = 0, j = i + 'console.log'.length;
      for (; j < code.length; j++) {
        const ch = code[j];
        const chp = code[j - 1];
        if (q.str || q.tpl) { /* 不会走到：已在上面分支处理 */ }
        if (ch === '"' || ch === "'") {
          const end = code.indexOf(ch, j + 1);
          j = end < 0 ? code.length : end;
          continue;
        }
        if (ch === '(') d++;
        else if (ch === ')') { d--; if (d === 0) { j++; break; } }
      }
      if (code[j] === ';') j++;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// 层 1：漂移守卫
// ---------------------------------------------------------------------------

test('漂移守卫：background.js 的 WeTransfer 相关函数必须与 test-wetransfer-parse.mjs 副本逻辑一致', () => {
  for (const n of FN_NAMES) {
    const a = normalize(extractFunction(BG, n));
    const b = normalize(extractFunction(COPY, n));
    assert.equal(
      a,
      b,
      `background.js 的 ${n} 与 test-wetransfer-parse.mjs 中的副本已不一致。` +
        `改了源码就必须同步改副本并补用例，否则副本测试只是自我安慰。`
    );
  }
});

test('漂移守卫：WETRANSFER_UA 常量在源码与副本中必须一致', () => {
  const pick = (s) => {
    const i = s.indexOf('const WETRANSFER_UA =');
    assert.ok(i >= 0, '找不到 WETRANSFER_UA 常量');
    return normalize(s.slice(i, s.indexOf("';", i) + 2));
  };
  assert.equal(pick(BG), pick(COPY));
});

// ---------------------------------------------------------------------------
// 层 2：真实源码行为测试
// ---------------------------------------------------------------------------

// 把 background.js 的函数原样抽出来，用 new Function 组装成可调用对象。
// 不从源码 import 是为了不改 background.js（它是浏览器 Service Worker 脚本，没有模块导出）。
function loadRealImpl() {
  const parts = [];
  {
    const i = BG.indexOf('const WETRANSFER_UA =');
    parts.push(BG.slice(i, BG.indexOf("';", i) + 2));
  }
  for (const n of FN_NAMES) parts.push(extractFunction(BG, n));
  parts.push('return {' + FN_NAMES.join(',') + '};');
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n'))();
}
const IMPL = loadRealImpl();

const TID = 'd841a4a6a30760cc66aa575be501ac0220260831141039';
const SH = '9ba367';
const SHORT = 'https://we.tl/t-BKu1vLhn5uhZxnwn';
const LONG = 'https://wetransfer.com/downloads/' + TID + '/' + SH + '?t_exp=1793369439';

// Response 替身：fetchJson 只用 text()；短链展开用 url / headers.get('location')
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
function mockFetch(router) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    const r = await router(u, opts || {});
    if (!r) throw new Error('未预期的请求：' + u);
    return r;
  };
  return calls;
}
const prepared = (o) =>
  Object.assign(
    {
      id: TID,
      state: 'downloadable',
      password_protected: false,
      items: [{ id: 'i1', name: 'a.bin', size: 1024 }],
    },
    o || {}
  );
const alwaysOkLink = (u) => {
  if (String(u).endsWith('/prepare-download')) return res(prepared());
  if (String(u).endsWith('/download')) return res({ direct_link: 'https://download.wetransfer.com/f?t=1' });
  return null;
};

// --- 平台识别：精确匹配，防误伤 ---------------------------------------------

test('[实源] detectNetdiskPlatform 精确匹配 we.tl / wetransfer.com，且不得宽松匹配', () => {
  assert.equal(IMPL.detectNetdiskPlatform(SHORT), 'wetransfer');
  assert.equal(IMPL.detectNetdiskPlatform('https://WE.TL/t-x'), 'wetransfer');
  assert.equal(IMPL.detectNetdiskPlatform('https://wetransfer.com/x'), 'wetransfer');
  assert.equal(IMPL.detectNetdiskPlatform('https://a.b.wetransfer.com/x'), 'wetransfer');
  // 宽松匹配（includes）会把这些全判成 wetransfer —— 这里是变异 M3 的拦截点
  assert.equal(IMPL.detectNetdiskPlatform('https://we.tl.evil.com/x'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://weather.com/'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://www.weibo.com/'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://wetransfer.com.evil.com/x'), null);
  assert.equal(IMPL.detectNetdiskPlatform('https://notwetransfer.com/downloads/a/b'), null);
  // 既有平台不被挤掉
  assert.equal(IMPL.detectNetdiskPlatform('https://pan.baidu.com/s/1a'), 'baidu');
  assert.equal(IMPL.detectNetdiskPlatform('https://pan.quark.cn/s/x'), 'quark');
  assert.equal(IMPL.detectNetdiskPlatform('https://www.123pan.com/s/x'), 'pan123');
  assert.equal(IMPL.detectNetdiskPlatform('https://cloud.189.cn/t/x'), 'tianyi');
});

// --- extractWeTransferIds：畸形输入矩阵 ---------------------------------------

test('[实源] extractWeTransferIds 覆盖畸形输入且一律不抛异常', () => {
  const ids = { transferId: TID, securityHash: SH };
  assert.deepEqual(IMPL.extractWeTransferIds(LONG), ids);
  assert.deepEqual(IMPL.extractWeTransferIds('https://wetransfer.com/downloads/' + TID + '/' + SH + '/'), ids, 'trailing slash');
  assert.deepEqual(IMPL.extractWeTransferIds('https://wetransfer.com/downloads/' + TID + '/' + SH + '/x/y'), ids, '多余路径段忽略');
  assert.deepEqual(IMPL.extractWeTransferIds('https://wetransfer.com/downloads//' + TID + '//' + SH + '//'), ids, '连续斜杠');
  assert.deepEqual(IMPL.extractWeTransferIds('https://wetransfer.com/downloads/' + TID + '/' + SH + '#f'), ids, 'fragment');
  assert.deepEqual(IMPL.extractWeTransferIds('https://www.wetransfer.com/downloads/' + TID + '/' + SH), ids, 'www 子域');

  assert.equal(IMPL.extractWeTransferIds('https://wetransfer.com/downloads/' + TID), null, '缺 security_hash');
  assert.equal(IMPL.extractWeTransferIds('https://wetransfer.com/downloads/'), null);
  assert.equal(IMPL.extractWeTransferIds('https://wetransfer.com/transfers/' + TID + '/' + SH), null);
  // 以下输入在过去曾导致未捕获异常，必须保持「返回 null」而不是崩
  for (const bad of ['', 'not a url', null, undefined, 'wetransfer://downloads/a/b', 'javascript:alert(1)']) {
    assert.equal(IMPL.extractWeTransferIds(bad), null, '畸形输入应返回 null：' + String(bad));
  }
});

// --- expandWeTransferUrl：短链展开的失败形态 ----------------------------------

test('[实源] expandWeTransferUrl 网络失败时必须抛错，绝不把原始短链往下传', async () => {
  mockFetch(async () => {
    throw new Error('Failed to fetch');
  });
  await assert.rejects(
    () => IMPL.expandWeTransferUrl(SHORT),
    (e) => {
      assert.ok(/短链展开失败/.test(e.message), '实际：' + e.message);
      return true;
    }
  );
});

test('[实源] expandWeTransferUrl 遇 HTTP 500/404 且未重定向时必须抛错', async () => {
  for (const status of [404, 500, 503]) {
    mockFetch(async () => res('<html>err</html>', { status, url: SHORT }));
    await assert.rejects(
      () => IMPL.expandWeTransferUrl(SHORT),
      /短链展开失败/,
      'HTTP ' + status + ' 未重定向时应抛错'
    );
  }
});

test('[实源] expandWeTransferUrl 在 response.url 与 Location 都拿不到时抛错', async () => {
  mockFetch(async () => res({}, { url: '' }));
  await assert.rejects(() => IMPL.expandWeTransferUrl(SHORT), /短链展开失败/);

  mockFetch(async () => res({}, { url: SHORT, location: null }));
  await assert.rejects(() => IMPL.expandWeTransferUrl(SHORT), /短链展开失败/);
});

test('[实源] expandWeTransferUrl 对非法 URL 抛「链接格式非法」而不是崩在 new URL', async () => {
  mockFetch(async () => {
    throw new Error('不应发起请求');
  });
  for (const bad of ['not a url', '', null, undefined]) {
    await assert.rejects(() => IMPL.expandWeTransferUrl(bad), /链接格式非法/, '输入：' + String(bad));
  }
});

test('[实源] expandWeTransferUrl 对落地页地址原样返回且不发请求', async () => {
  const calls = mockFetch(async () => {
    throw new Error('不应发起请求');
  });
  assert.equal(await IMPL.expandWeTransferUrl(LONG), LONG);
  assert.equal(calls.length, 0);
});

// --- pickWeTransferError：错误识别 -------------------------------------------

test('[实源] pickWeTransferError 覆盖 message / error / 非对象 / 正常响应', () => {
  assert.equal(IMPL.pickWeTransferError({ message: 'Missing parameter :security_hash' }), 'Missing parameter :security_hash');
  assert.equal(IMPL.pickWeTransferError({ error: 'boom' }), 'boom');
  assert.equal(IMPL.pickWeTransferError({ items: [], state: 'downloadable' }), '', '正常响应必须识别为无错误');
  assert.ok(IMPL.pickWeTransferError(null), 'null 响应应视为错误');
  assert.ok(IMPL.pickWeTransferError('a string'), '非对象响应应视为错误');
});

// --- resolveWeTransfer：关键不变量 -------------------------------------------

test('[实源] resolveWeTransfer 取直链必须使用 file_ids 数组（变异 M1 拦截点）', async () => {
  const bodies = [];
  mockFetch((u, o) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [{ id: 'i1', name: 'a.bin', size: 1 }] }));
    if (String(u).endsWith('/download')) {
      bodies.push(JSON.parse(o.body));
      return res({ direct_link: 'https://download.wetransfer.com/f?t=1' });
    }
    return null;
  });
  const { files } = await IMPL.resolveWeTransfer(LONG, '');
  assert.equal(files.length, 1);
  assert.equal(bodies.length, 1);
  assert.ok(Array.isArray(bodies[0].file_ids), 'file_ids 必须是数组，file_id/item_id 都会被接口拒');
  assert.deepEqual(bodies[0].file_ids, ['i1']);
  assert.equal(bodies[0].intent, 'single_file');
  assert.equal(bodies[0].security_hash, SH);
});

test('[实源] resolveWeTransfer 短链全链路：展开 -> prepare -> 逐文件直链', async () => {
  const calls = mockFetch((u) => {
    if (u === SHORT) return res({}, { url: LONG });
    return alwaysOkLink(u);
  });
  const { files } = await IMPL.resolveWeTransfer(SHORT, '');
  assert.equal(files.length, 1);
  assert.equal(files[0].url, 'https://download.wetransfer.com/f?t=1');
  assert.equal(calls.length, 3, '1 次展开 + 1 次 prepare + 1 次 download');
  assert.equal(calls[0].url, SHORT);
  assert.ok(calls[1].url.endsWith('/api/v4/transfers/' + TID + '/prepare-download'));
});

test('[实源] resolveWeTransfer 遇密码保护必须抛错（变异 M4 拦截点）', async () => {
  for (const pwd of ['', 'whatever']) {
    mockFetch((u) => (String(u).endsWith('/prepare-download') ? res(prepared({ password_protected: true })) : null));
    await assert.rejects(
      () => IMPL.resolveWeTransfer(LONG, pwd),
      /密码/,
      'pwd=' + JSON.stringify(pwd) + ' 时也应明确报错，而不是静默忽略密码'
    );
  }
});

test('[实源] resolveWeTransfer 遇非 downloadable state 必须抛错（变异 M2 拦截点）', async () => {
  for (const st of ['expired', 'deleted', 'uploading', 'processing']) {
    mockFetch((u) => (String(u).endsWith('/prepare-download') ? res(prepared({ state: st })) : null));
    await assert.rejects(
      () => IMPL.resolveWeTransfer(LONG, ''),
      (e) => {
        assert.ok(/过期|不可下载/.test(e.message), '实际：' + e.message);
        assert.ok(e.message.includes(st), '错误应带出 state 值，实际：' + e.message);
        return true;
      },
      'state=' + st
    );
  }
});

test('[实源] resolveWeTransfer 遇空 items / 非数组 items 必须抛错（变异 M5 拦截点）', async () => {
  for (const items of [[], null, undefined, 'oops', {}]) {
    mockFetch((u) => (String(u).endsWith('/prepare-download') ? res(prepared({ items })) : null));
    await assert.rejects(
      () => IMPL.resolveWeTransfer(LONG, ''),
      /没有可下载的文件/,
      'items=' + JSON.stringify(items) + ' 时应抛错，绝不能返回空数组冒充成功'
    );
  }
});

test('[实源] resolveWeTransfer 必须透出接口 HTTP 400/404 的 message（fetchJson 不查状态码）', async () => {
  // prepare-download 报错
  mockFetch((u) => (String(u).endsWith('/prepare-download') ? res({ message: 'Missing parameter :security_hash' }, { status: 400 }) : null));
  await assert.rejects(
    () => IMPL.resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/Missing parameter/.test(e.message), '实际：' + e.message);
      return true;
    }
  );

  // prepare 正常、但每个文件取直链都报 404
  mockFetch((u) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared());
    if (String(u).endsWith('/download')) return res({ message: "Couldn't find FileObject" }, { status: 404 });
    return null;
  });
  await assert.rejects(
    () => IMPL.resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/全部文件取直链失败/.test(e.message), '实际：' + e.message);
      assert.ok(/Couldn't find FileObject/.test(e.message), '应带出接口原因，实际：' + e.message);
      return true;
    }
  );
});

test('[实源] resolveWeTransfer 部分文件失败时保留清单、失败项 url 留空', async () => {
  mockFetch((u, o) => {
    if (String(u).endsWith('/prepare-download')) {
      return res(prepared({ items: [{ id: 'ok1', name: 'ok.bin', size: 10 }, { id: 'bad1', name: 'bad.bin', size: 20 }] }));
    }
    if (String(u).endsWith('/download')) {
      const id = JSON.parse(o.body).file_ids[0];
      if (id === 'bad1') return res({ message: 'nope' }, { status: 500 });
      return res({ direct_link: 'https://download.wetransfer.com/ok?t=1' });
    }
    return null;
  });
  const out = await IMPL.resolveWeTransfer(LONG, '');
  // F6 修复：部分失败时失败项被丢弃（url 空，Rust 也会过滤），成功项保留，warning 回传失败原因
  const files = out.files;
  assert.equal(files.length, 1, '仅成功文件进入 files');
  assert.equal(files[0].url, 'https://download.wetransfer.com/ok?t=1');
  assert.ok(out.warning && /1 个文件取直链失败/.test(out.warning), '应带部分失败 warning：' + out.warning);
});

test('[实源] resolveWeTransfer 遇非 JSON 响应（WAF 拦截）抛明确错误', async () => {
  mockFetch(async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => '<html>Access Denied</html>',
  }));
  await assert.rejects(() => IMPL.resolveWeTransfer(LONG, ''), /非 JSON 响应/);
});

test('[实源] resolveWeTransfer 对 items 含 null / 缺 id 不得崩溃', async () => {
  // 含 null 项：不崩，且 null 项被记为失败（url 留空）
  mockFetch((u, o) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [null, { id: 'ok1', name: 'ok.bin', size: 5 }] }));
    if (String(u).endsWith('/download')) {
      const id = JSON.parse(o.body).file_ids[0];
      if (id === 'null') return res({ message: 'bad id' }, { status: 400 });
      return res({ direct_link: 'https://download.wetransfer.com/ok?t=1' });
    }
    return null;
  });
  const out = await IMPL.resolveWeTransfer(LONG, '');
  // null 项不崩：其 id 解析为 'null'、下载 400 被记为失败并丢弃；ok1 正常成功（F6 部分失败语义）。
  const files = out.files;
  assert.equal(files.length, 1, 'null 项被记为失败并丢弃，不进入 files');
  assert.equal(files[0].name, 'ok.bin');
  assert.equal(files[0].url, 'https://download.wetransfer.com/ok?t=1');
  assert.ok(out.warning && /1 个文件取直链失败/.test(out.warning), '应带部分失败 warning：' + out.warning);

  // 全部为 null：全部失败 -> 抛错，而不是返回一堆空链接
  mockFetch((u) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [null, null] }));
    if (String(u).endsWith('/download')) return res({ message: 'bad id' }, { status: 400 });
    return null;
  });
  await assert.rejects(() => IMPL.resolveWeTransfer(LONG, ''), /全部文件取直链失败/);
});

test('[实源] resolveWeTransfer 的 size 处理：0 / 缺失 / 字符串 / 大数都单位化展示且不产生 undefined', async () => {
  // F5 修复后 size 走 bytesToSize，单位化展示。
  // 关键不变量仍是：缺失/空串/null → 空串（不产生 'undefined' / 'null' 字面量）。
  const cases = [
    [{ size: 0 }, '0.00 B', 'size=0 应单位化为 "0.00 B"'],
    [{}, '', 'size 缺失应为空串'],
    [{ size: '' }, '', 'size 空串应为空串'],
    [{ size: null }, '', 'size=null 应为空串'],
    [{ size: '2048' }, '2.00 KB', '字符串数字 size 也走单位化'],
    [{ size: 13886301 }, '13.24 MB', '正常字节数应单位化'],
  ];
  for (const [over, want, msg] of cases) {
    mockFetch((u) => {
      if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [Object.assign({ id: 'i', name: 'f.bin' }, over)] }));
      return res({ direct_link: 'https://download.wetransfer.com/f?t=1' });
    });
    const { files } = await IMPL.resolveWeTransfer(LONG, '');
    assert.equal(files[0].size, want, msg);
    assert.notEqual(files[0].size, 'undefined');
    assert.notEqual(files[0].size, 'null');
  }
});

test('[实源] resolveWeTransfer 的 name 处理：缺失 / 空串 / display_name 回退', async () => {
  const cases = [
    [{ id: 'a' }, 'file'],
    [{ id: 'a', name: '' }, 'file'],
    [{ id: 'a', display_name: 'fallback.zip' }, 'fallback.zip'],
    [{ id: 'a', name: 'x'.repeat(500) + '.zip' }, 'x'.repeat(500) + '.zip'],
    [{ id: 'a', name: '..\\..\\evil.exe' }, '..\\..\\evil.exe'],
  ];
  for (const [item, want] of cases) {
    mockFetch((u) => {
      if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [item] }));
      return res({ direct_link: 'https://download.wetransfer.com/f?t=1' });
    });
    const { files } = await IMPL.resolveWeTransfer(LONG, '');
    assert.equal(files[0].name, want, JSON.stringify(item));
    assert.equal(typeof files[0].name, 'string');
  }
});

// P2 修复（F2）：HTTP 500 + 空响应不再被误导为「items 为空」，应直接报 HTTP 状态码。
test('HTTP 500 且无 message/error 字段时应报 HTTP 状态码而非「items 为空」', async () => {
  mockFetch((u) => (String(u).endsWith('/prepare-download') ? res({}, { status: 500, statusText: 'Internal Server Error' }) : null));
  await assert.rejects(
    () => IMPL.resolveWeTransfer(LONG, ''),
    /HTTP 500/,
    'F2 已修复：服务端错应报 HTTP 状态码'
  );
});

// P2 修复（F6）：全部成功时不应带 warning，且所有文件进入 files。
test('[实源][F6] 全部成功时 warning 应为空', async () => {
  mockFetch((u) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared({ items: [{ id: 'i1', name: 'a.bin', size: 10 }, { id: 'i2', name: 'b.bin', size: 20 }] }));
    if (String(u).endsWith('/download')) return res({ direct_link: 'https://download.wetransfer.com/x?t=1' });
    return null;
  });
  const out = await IMPL.resolveWeTransfer(LONG, '');
  assert.equal(out.files.length, 2, '全部成功应返回 2 个文件');
  assert.equal(out.warning, undefined, '全成功不应带部分失败 warning');
});

// P2 修复（F9）：逐文件取直链应并发发起，最差耗时由 20N 降为单次 20s，避免撞前端 60s 超时。
test('[实源][F9] 逐文件 download 应并发发起（最大并发数 = 文件数，而非串行 1）', async () => {
  const N = 4;
  const items = [];
  for (let i = 1; i <= N; i++) items.push({ id: 'id' + i, name: 'f' + i + '.bin', size: i * 100 });
  let inFlight = 0;
  let maxInFlight = 0;
  mockFetch((u) => {
    if (String(u).endsWith('/prepare-download')) return res(prepared({ items }));
    if (String(u).endsWith('/download')) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 用 setTimeout 模拟网络耗时；串行时 d2 要等 d1 释放才会被调用
      return new Promise((resolve) => {
        setTimeout(() => { inFlight--; resolve(res({ direct_link: 'https://download.wetransfer.com/x?t=1' })); }, 5);
      });
    }
    return null;
  });
  const { files } = await IMPL.resolveWeTransfer(LONG, '');
  assert.equal(files.length, N, '并发下所有文件都应成功');
  assert.equal(maxInFlight, N, '应并发 ' + N + ' 个 download 请求（串行则为 1）');
});
