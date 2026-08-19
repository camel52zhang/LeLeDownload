// 123云盘解析器回归测试（r12+）
// 设计原则：直接从 extension/background.js 抽取【真实】pan123 helper + resolvePan123 源码 eval 执行，
// 彻底避免"测试镜像与实现漂移"导致的假绿（xunlei 已落地）。
// r12 模型参考 netdisk-resolver-v1.4 pan123/api.py + alist 123_share 驱动：
//   - 端点已迁移到 https://yun.123pan.cn/b/api
//   - 所有请求必须带签名（timeSign=<ts>-<random>-<dataSign>）
//   - /share/get 是 GET（不是 POST）；/share/download/info 是 POST
//   - data.InfoList[]（不是 data.fileList.data）；Type=1 文件夹、Type=0 文件
//   - DownloadURL 是 ?params=base64(真直链) 二次包装，且默认 auto_redirect=0 要改成 1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bgPath = join(__dirname, 'background.js');

// ---- 从 background.js 抽取 r12 块（fetchJson + bytesToSize + pan123 helpers + resolvePan123）----
function extractPan123Block(src) {
  // 1) 找到 resolvePan123 函数体的结束 "}"
  const resolveMarker = 'async function resolvePan123';
  const resolveStart = src.indexOf(resolveMarker);
  if (resolveStart < 0) throw new Error('background.js 中找不到 resolvePan123（确认 r12 已写入）');
  let i = src.indexOf('{', resolveStart);
  let depth = 0, inStr = null, inTmpl = false, inLineCmt = false, inBlockCmt = false;
  let resolveEnd = -1;
  for (; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (inLineCmt) { if (ch === '\n') inLineCmt = false; continue; }
    if (inBlockCmt) { if (ch === '*' && next === '/') { inBlockCmt = false; i++; } continue; }
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTmpl) { if (ch === '\\') { i++; continue; } if (ch === '`') inTmpl = false; continue; }
    if (ch === '/' && next === '/') { inLineCmt = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockCmt = true; i++; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '`') { inTmpl = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { resolveEnd = i; break; } }
  }
  if (resolveEnd < 0) throw new Error('未匹配到 resolvePan123 结束');

  // 2) 块起点：fetchJson 上一行注释（line ~410），这样 resolvePan123 内部调用的 fetchJson + bytesToSize 也在作用域内
  const fetchJsonMarker = 'async function fetchJson';
  const fetchJsonStart = src.indexOf(fetchJsonMarker);
  if (fetchJsonStart < 0) throw new Error('background.js 中找不到 fetchJson');
  const blockStart = src.lastIndexOf('//', fetchJsonStart);

  return src.slice(blockStart, resolveEnd + 1);
}

const bgSrc = readFileSync(bgPath, 'utf8');
const block = extractPan123Block(bgSrc);
// 在测试作用域内 eval 整块代码，把符号暴露给后续用例
const _ctx = {};
const factory = new Function('exports', block + '\nexports.pan123SignPath = pan123SignPath;\nexports.pan123SignedUrl = pan123SignedUrl;\nexports.pan123NormalizeDownloadUrl = pan123NormalizeDownloadUrl;\nexports.pan123DecodeParamsUrl = pan123DecodeParamsUrl;\nexports.pan123Crc32IEEE = pan123Crc32IEEE;\nexports.pan123BusinessError = pan123BusinessError;\nexports.readPan123Token = readPan123Token;\nexports.resolvePan123 = resolvePan123;\nexports.fetchJson = fetchJson;\nexports.bytesToSize = bytesToSize;\nreturn exports;');
const mod = factory(_ctx);
const { pan123SignPath, pan123SignedUrl, pan123NormalizeDownloadUrl, pan123DecodeParamsUrl, pan123Crc32IEEE, pan123BusinessError, readPan123Token, resolvePan123, fetchJson, bytesToSize } = mod;

// ---- mock helpers ----
function res(body, status = 200) {
  const s = JSON.stringify(body);
  return { status, json: async () => body, text: async () => s };
}

function makeFetch(handlers) {
  return async (u, opts) => {
    const url = String(u);
    for (const h of handlers) if (h.match(url, opts)) return h.respond(url, opts);
    throw new Error('未匹配的 fetch: ' + url.slice(0, 160));
  };
}

// 解 query string 为对象（兼容 URLSearchParams）
function parseQs(u) {
  const q = u.indexOf('?');
  if (q < 0) return {};
  const out = {};
  for (const part of u.slice(q + 1).split('&')) {
    const [k, v = ''] = part.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

// base64 包装一个真实 URL（模拟 123 的二次包装）
function wrapParamsUrl(inner) {
  return 'https://wp.imgapi.com/x?params=' + Buffer.from(inner, 'utf8').toString('base64');
}

// 替换 globalThis.fetch，让 resolvePan123 走 mock（必须 async，确保 fn() 返回的 promise 在 mock 生效期间解析）
async function withMockFetch(handlers, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = makeFetch(handlers);
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// =================== 用例 ===================

// X1: 签名算法 sanity——同一 path + 同秒内生成的 [timeSign, fullSign] 结构符合参考项目
test('pan123SignPath 输出 [timeSign, ts-rand-dataSign] 格式', () => {
  const [key, val] = pan123SignPath('/share/get', 'web', '3');
  assert.equal(typeof key, 'string');
  assert.match(key, /^\d+$/);  // crc32 数字串
  const m = val.match(/^(\d+)-(\d+)-(\d+)$/);
  assert.ok(m, 'fullSign 应为 ts-rand-dataSign 三段');
  const ts = +m[1], rand = +m[2], ds = +m[3];
  const now = Math.floor(Date.now() / 1000) + 8 * 3600;  // 容忍 CST 偏移
  assert.ok(Math.abs(ts - now) < 60, '时间戳偏差 < 60s');
  assert.ok(rand >= 0 && rand <= 1e7, '随机数在 0..1e7');
  assert.match(String(ds), /^\d+$/);
});

// X2: pan123SignedUrl 拼接带签名的完整 URL
test('pan123SignedUrl 在 URL 上挂签名查询参数', () => {
  const url = pan123SignedUrl('/share/get', { shareKey: 'ABC', Page: '1' });
  assert.ok(url.startsWith('https://yun.123pan.cn/b/api/share/get?'), 'base 应正确');
  const qs = parseQs(url);
  const sigKey = Object.keys(qs).find((k) => /^\d+$/.test(k));
  assert.ok(sigKey, '签名键名应为纯数字串');
  assert.match(qs[sigKey], /^\d+-\d+-\d+$/);
  assert.equal(qs.shareKey, 'ABC');
  assert.equal(qs.Page, '1');
});

// X3: auto_redirect=0 → 1
test('pan123NormalizeDownloadUrl 把 auto_redirect=0 改 1', () => {
  assert.equal(
    pan123NormalizeDownloadUrl('https://cdn.example/f?auto_redirect=0&token=1'),
    'https://cdn.example/f?auto_redirect=1&token=1'
  );
  assert.equal(
    pan123NormalizeDownloadUrl('https://cdn.example/f?token=1'),
    'https://cdn.example/f?token=1',
    '无 auto_redirect=0 时保持原样'
  );
  assert.equal(pan123NormalizeDownloadUrl(''), '');
});

// X4: 解码 base64 params 二次包装 → 真直链 + auto_redirect 改写
test('pan123DecodeParamsUrl 解码 ?params=base64 包装', () => {
  const inner = 'https://download-cdn.123295.com/file?auto_redirect=0&token=1';
  const wrapped = wrapParamsUrl(inner);
  const decoded = pan123DecodeParamsUrl(wrapped);
  assert.equal(decoded, 'https://download-cdn.123295.com/file?auto_redirect=1&token=1');
});
test('pan123DecodeParamsUrl 没有 params 时直接 normalize', () => {
  const direct = 'https://cdn.example/f?auto_redirect=0';
  assert.equal(pan123DecodeParamsUrl(direct), 'https://cdn.example/f?auto_redirect=1');
});

// X5: 根目录单文件 → list + download/info 取直链
test('resolvePan123 根目录单文件 → /share/get + /share/download/info 取直链', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: (u) => {
        const qs = parseQs(u);
        assert.equal(qs.parentFileId, '0');
        assert.equal(qs.Page, '1');
        assert.equal(qs.shareKey, 'KEY1');
        return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [{
          FileId: 100, FileName: 'a.txt', Type: 0, Size: 4096, S3KeyFlag: '100-0', Etag: 'etagA',
        }] } });
      },
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: (u, opts) => {
        const body = JSON.parse((opts && opts.body) || '{}');
        assert.equal(body.shareKey, 'KEY1');
        assert.equal(body.fileId, 100);
        assert.equal(body.s3keyFlag, '100-0');
        assert.equal(body.etag, 'etagA');
        assert.equal(body.size, 4096);
        return res({ code: 0, message: 'ok', data: {
          DownloadURL: wrapParamsUrl('https://download-cdn.123295.com/a?auto_redirect=0&token=zz'),
        } });
      },
    },
  ];
  const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY1', ''));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a.txt');
  assert.equal(result[0].size, '4.00 KB');
  assert.equal(result[0].url, 'https://download-cdn.123295.com/a?auto_redirect=1&token=zz');
  assert.equal(result[0].headers.Referer, 'https://yun.123pan.cn/');
});

// X6: 文件夹递归（Type=1）
test('resolvePan123 文件夹递归下钻子文件', async () => {
  const calls = { list: 0, dl: 0 };
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: (u) => {
        calls.list++;
        const qs = parseQs(u);
        if (qs.parentFileId === '0') {
          return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
            { FileId: 1, FileName: 'top.txt', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
            { FileId: 2, FileName: 'sub', Type: 1, Size: 0, S3KeyFlag: '', Etag: '' },
          ] } });
        }
        if (qs.parentFileId === '2') {
          return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
            { FileId: 3, FileName: 'inside.txt', Type: 0, Size: 50, S3KeyFlag: '3-0', Etag: 'e3' },
          ] } });
        }
        return res({ code: 1, message: '未知 parentFileId' });
      },
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: (u, opts) => {
        calls.dl++;
        const body = JSON.parse((opts && opts.body) || '{}');
        return res({ code: 0, message: 'ok', data: {
          DownloadURL: wrapParamsUrl('https://download-cdn.123295.com/' + body.fileId + '?auto_redirect=0'),
        } });
      },
    },
  ];
  const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', ''));
  assert.equal(result.length, 2);
  const names = result.map((f) => f.name).sort();
  assert.deepEqual(names, ['inside.txt', 'top.txt']);
  assert.equal(calls.list, 2);
  assert.equal(calls.dl, 2);
  assert.equal(result.find((f) => f.name === 'inside.txt').url,
    'https://download-cdn.123295.com/3?auto_redirect=1');
});

// X7: 提取码错 → 抛带"提取码"前缀的错误
test('resolvePan123 提取码错误抛业务异常', async () => {
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: () => res({ code: 1, message: '提取码错误' }),
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', 'wrong')),
    /提取码错误/
  );
});

// X8: 分享失效
test('resolvePan123 分享不存在或已失效抛业务异常', async () => {
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: () => res({ code: 1, message: '分享不存在或已失效' }),
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /分享不存在或已失效/
  );
});

// X9: 列表分页（Next 不等于 -1）
test('resolvePan123 InfoList 分页（Next != "-1"）继续翻页', async () => {
  const seenPages = [];
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: (u) => {
        const qs = parseQs(u);
        seenPages.push(+qs.Page);
        if (qs.Page === '1') {
          return res({ code: 0, message: 'ok', data: { Next: 'NEXT_TOK', InfoList: [
            { FileId: 11, FileName: 'p1.txt', Type: 0, Size: 1, S3KeyFlag: '11-0', Etag: 'ea' },
          ] } });
        }
        return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
          { FileId: 12, FileName: 'p2.txt', Type: 0, Size: 2, S3KeyFlag: '12-0', Etag: 'eb' },
        ] } });
      },
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: () => res({ code: 0, message: 'ok', data: {
        DownloadURL: wrapParamsUrl('https://download-cdn.123295.com/x?auto_redirect=0'),
      } }),
    },
  ];
  const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', ''));
  assert.deepEqual(seenPages, [1, 2]);
  assert.equal(result.length, 2);
});

// X10: 列表空 → "没有可下载文件" 错误
test('resolvePan123 空 InfoList 抛"没有可下载文件"', async () => {
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [] } }),
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /没有可下载文件/
  );
});

// X11: 缺 etag / s3keyFlag → 抛"缺少 Etag/S3KeyFlag"错误
test('resolvePan123 文件缺 Etag/S3KeyFlag 抛错', async () => {
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
      { FileId: 99, FileName: 'broken.txt', Type: 0, Size: 10, S3KeyFlag: '', Etag: '' },
    ] } }),
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /缺少 Etag\/S3KeyFlag/
  );
});

// X12: download/info 业务错（如限速）→ 抛带文件名 + code 的错误
test('resolvePan123 /download/info 业务错抛带文件名与 code 的错误', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 5, FileName: 'x.bin', Type: 0, Size: 10, S3KeyFlag: '5-0', Etag: 'e5' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: () => res({ code: 429, message: 'too many requests' }),
    },
  ];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /⛔ 123云盘业务层限制（x\.bin）：too many requests \[错误码 429\]/
  );
});

// X13: folder 循环引用（F2 → F2）用 visited Set 阻止死循环
test('resolvePan123 folder 自循环引用 visited Set 阻止死循环', async () => {
  let calls = 0;
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: (u) => {
      calls++;
      const qs = parseQs(u);
      if (qs.parentFileId === '0') {
        return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
          { FileId: 2, FileName: 'loop', Type: 1, Size: 0, S3KeyFlag: '', Etag: '' },
        ] } });
      }
      // 自循环：parentFileId=2 仍返回 fileId=2（既是父又是子）→ 应该被 visited 阻止
      return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 2, FileName: 'loop', Type: 1, Size: 0, S3KeyFlag: '', Etag: '' },
      ] } });
    },
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /没有可下载文件/
  );
  assert.ok(calls <= 3, '应被 visited 阻止（不无限递归），calls=' + calls);
});

// X14: 嵌套超过 10 层 → 截断但不丢浅层文件
test('resolvePan123 嵌套超过 10 层 → 截断不丢浅层', async () => {
  let depth = 0;
  const handlers = [{
    match: (u) => u.includes('/share/get'),
    respond: (u) => {
      depth++;
      const qs = parseQs(u);
      const id = qs.parentFileId === '0' ? 1 : Number(qs.parentFileId) + 1;
      if (id <= 12) {
        return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
          { FileId: id, FileName: 'd' + id, Type: 1, Size: 0, S3KeyFlag: '', Etag: '' },
        ] } });
      }
      return res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [] } });
    },
  }];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /没有可下载文件/
  );
  assert.ok(depth <= 15, 'depth 不应无限增长（被 MAX_DEPTH=10 截断），实际=' + depth);
});

// X15: pan123BusinessError 友好输出（区分游客流量拦截/用户未登录/链接失效/提取码/其他）
test('pan123BusinessError 把业务码翻译成用户可读提示', () => {
  // r16 修正：5112「分享方提取流量包不足」= 分享方未给游客开放提取流量 → 引导登录重试
  const e1 = pan123BusinessError('书源/独乐乐（1011).json', 5112, '分享方提取流量包不足');
  assert.match(e1, /⛔ 123云盘分享未向游客开放提取流量/);
  assert.match(e1, /请登录 123 账号（会员更佳）后重试/);
  assert.match(e1, /\[错误码 5112\]/);
  assert.doesNotMatch(e1, /任何下载器都无法绕过/, 'r16 关键：游客流量拦截 ≠ 无解，登录可能可下');
  // 用户未登录/付费（r12 匿名 fetch 触发的就是这种）—— 同样 code=5112 走不同分支
  const e2 = pan123BusinessError('西游记.1996.S01E30.1080P.H265.mp4', 5112, '您需要注册登录或付费后下载');
  assert.match(e2, /⛔ 123云盘当前用户未登录或非会员/);
  assert.match(e2, /请在浏览器登录 pan\.xunlei\.com \/ yun\.123pan\.cn 后重试/);
  assert.match(e2, /\[错误码 5112\]/);
  assert.doesNotMatch(e2, /任何下载器都无法绕过/, 'r14 必须区分：用户未登录 ≠ 分享方限制');
  // 链接失效
  const e3 = pan123BusinessError('根目录', 5108, '分享不存在');
  assert.match(e3, /⛔ 123云盘分享不存在或已失效/);
  // 提取码（r14 用"提取码"更精确避免与"提取次数"歧义）
  const e4 = pan123BusinessError('根目录', 5104, '提取码错误');
  assert.match(e4, /⛔ 123云盘提取码错误\/需要/);
  // 提取次数 → 游客流量拦截分支（r16 归到登录引导）
  const e5 = pan123BusinessError('根目录', 5112, '您的提取次数已用完');
  assert.match(e5, /⛔ 123云盘分享未向游客开放提取流量/);
  // 未知码兜底
  const e6 = pan123BusinessError('根目录', 9999, '未知错误');
  assert.match(e6, /⛔ 123云盘业务层限制/);
  assert.match(e6, /\[错误码 9999\]/);
});

// X16: /share/download/info 返回 5112 流量包 → r16 触发登录重试，无 token 时给出"游客流量拦截"引导
test('resolvePan123 download/info 返 5112 流量包 → 引导登录重试', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: 'f.json', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: () => res({ code: 5112, message: '分享方提取流量包不足', data: null }),
    },
  ];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /⛔ 123云盘分享未向游客开放提取流量（f\.json）：分享方提取流量包不足（请登录 123 账号（会员更佳）后重试；若登录后仍失败，才是分享方主动关闭了提取，需请对方重新分享） \[错误码 5112\]/
  );
});

// X17: /share/get（listDir）根目录即返 5112 → 同样走 helper
test('resolvePan123 listDir 返 5112 → 友好业务错误', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 5112, message: '分享方提取流量包不足', data: null }),
    },
  ];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /⛔ 123云盘分享未向游客开放提取流量（根目录）：分享方提取流量包不足.*\[错误码 5112\]/
  );
});

// X18: download/info 5112 + "您需要注册登录或付费后下载" → r14 必须识别为"用户未登录"（非分享方限制）
// （chrome 环境缺失时走不了注入，重试后仍无 token → 抛准确提示）
test('resolvePan123 download/info 返 5112 用户登录错 → 走"未登录"分支（r14 关键修复）', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: '西游记.1996.S01E30.1080P.H265.mp4', Type: 0, Size: 990646380, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: () => res({ code: 5112, message: '您需要注册登录或付费后下载', data: null }),
    },
  ];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    (err) => {
      const msg = err && err.message || '';
      assert.match(msg, /⛔ 123云盘当前用户未登录或非会员/);
      assert.match(msg, /西游记\.1996\.S01E30/);
      assert.match(msg, /您需要注册登录或付费后下载/);
      assert.match(msg, /请在浏览器登录 pan\.xunlei\.com \/ yun\.123pan\.cn 后重试/);
      assert.match(msg, /\[错误码 5112\]/);
      assert.doesNotMatch(msg, /任何下载器都无法绕过/, 'r14 关键：未登录 ≠ 分享方限制');
      return true;
    }
  );
});

// X19: listDir 5112 + "您需要注册登录或付费后下载" → 同样走"未登录"分支
test('resolvePan123 listDir 返 5112 用户登录错 → 走"未登录"分支', async () => {
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 5112, message: '您需要注册登录或付费后下载', data: null }),
    },
  ];
  await assert.rejects(
    () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
    /⛔ 123云盘当前用户未登录或非会员（根目录）：您需要注册登录或付费后下载.*\[错误码 5112\]/
  );
});

// ---- r14+ 登录态注入（Authorization token）----
// mock chrome.tabs / chrome.scripting：executeScript 返回预设注入结果（不真跑页面代码）。
function mockChrome123(executeResultOrFn) {
  const fn = typeof executeResultOrFn === 'function' ? executeResultOrFn : () => executeResultOrFn;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 42 }],
      create: async () => ({ id: 42 }),
      remove: async () => {},
    },
    scripting: { executeScript: async () => [{ result: fn() }] },
    storage: { local: { get: (_keys, cb) => cb({}) } },
  };
}

// X20: 注入无 token（用户未登录 123）→ download/info 5112 → 重试注入仍无 → 抛"当前用户未登录或非会员"
test('resolvePan123 注入无 token → 5112 未登录 → 抛准确提示', async () => {
  mockChrome123({ ok: false, step: 'no-token', reason: '未登录' });
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: 'f.mp4', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: () => res({ code: 5112, message: '您需要注册登录或付费后下载', data: null }),
    },
  ];
  try {
    await assert.rejects(
      () => withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', '')),
      /⛔ 123云盘当前用户未登录或非会员（f\.mp4）：您需要注册登录或付费后下载.*\[错误码 5112\]/
    );
  } finally {
    delete globalThis.chrome;
  }
});

// X21: 注入有 token → download/info 带 Authorization 成功；若先匿名失败也会强制刷新后重试
test('resolvePan123 带 token → Authorization 头 → 成功取直链', async () => {
  mockChrome123({ ok: true, value: 'tok123' });
  let authCalls = 0;
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: 'f.mp4', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: (u, opts) => {
        const hdrs = (opts && opts.headers) || {};
        // 带 Bearer tok123 → 成功（记录带 token 请求次数）
        if (hdrs.Authorization === 'Bearer tok123') {
          authCalls++;
          return res({ code: 0, message: 'ok', data: {
            DownloadURL: wrapParamsUrl('https://cdn.123/f?auto_redirect=0&t=1'),
          } });
        }
        // 匿名请求 → 5112 未登录
        return res({ code: 5112, message: '您需要注册登录或付费后下载', data: null });
      },
    },
  ];
  try {
    const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', ''));
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://cdn.123/f?auto_redirect=1&t=1');
    assert.ok(authCalls >= 1, '至少有一次带 Authorization 的 download/info 请求');
  } finally {
    delete globalThis.chrome;
  }
});

// X22: readPan123Token 探测 localStorage（直接 key / userInfo JSON / 长度>50 校验）
test('readPan123Token 从 localStorage 探测 token（userInfo JSON）', () => {
  const orig = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => {
      if (k === 'userInfo') return JSON.stringify({ nickname: 'x', token: 'T'.repeat(60) });
      return null;
    },
  };
  try {
    const r = readPan123Token();
    assert.equal(r.ok, true);
    assert.equal(r.value, 'T'.repeat(60));
  } finally {
    globalThis.localStorage = orig;
  }
});

// X23: 5112「分享方提取流量包不足」+ 注入有 token → r16 触发登录重试 → 成功（r16 关键修复）
// 说明：游客流量拦截（分享方未开放游客提取）登录用户/会员可能可下，必须带 token 重试一次
test('resolvePan123 5112 流量包 + 有 token → 带 Authorization 重试成功（r16 关键）', async () => {
  mockChrome123({ ok: true, value: 'tok123' });
  let authCalls = 0;
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: 'f.json', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: (u, opts) => {
        const hdrs = (opts && opts.headers) || {};
        if (hdrs.Authorization === 'Bearer tok123') {
          authCalls++;
          return res({ code: 0, message: 'ok', data: {
            DownloadURL: wrapParamsUrl('https://cdn.123/f?auto_redirect=0&t=1'),
          } });
        }
        return res({ code: 5112, message: '分享方提取流量包不足', data: null });
      },
    },
  ];
  try {
    const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', ''));
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://cdn.123/f?auto_redirect=1&t=1');
    assert.ok(authCalls >= 1, 'r16 关键：5112 流量包必须触发登录态重试');
  } finally {
    delete globalThis.chrome;
  }
});

test('readPan123Token 直接 key authorToken 命中；短 token（<50）忽略', () => {
  const orig = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => {
      if (k === 'authorToken') return 'T'.repeat(60);
      if (k === 'token') return 'short';  // <50，应被忽略
      return null;
    },
  };
  try {
    const r = readPan123Token();
    assert.equal(r.ok, true);
    assert.equal(r.value, 'T'.repeat(60));
  } finally {
    globalThis.localStorage = orig;
  }
});

// X24: r17 JWT 兜底遍历——未知 key 名存 JWT 格式也能抓到
test('readPan123Token JWT 兜底遍历抓未知 key 的 token', () => {
  const orig = globalThis.localStorage;
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.' + 'x'.repeat(60);
  globalThis.localStorage = {
    getItem: (k) => (k === 'someUnknownKeyName' ? jwt : null),
    key: (i) => ['someUnknownKeyName'][i],
    length: 1,
  };
  try {
    const r = readPan123Token();
    assert.equal(r.ok, true);
    assert.equal(r.value, jwt);
  } finally {
    globalThis.localStorage = orig;
  }
});
test('readPan123Token 短字符串不误判（非 JWT 非长字符串忽略）', () => {
  const orig = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (k === 'theme' ? 'dark' : null),  // 短值不应被当 token
    key: (i) => ['theme'][i],
    length: 1,
  };
  try {
    const r = readPan123Token();
    assert.equal(r.ok, false);
  } finally {
    globalThis.localStorage = orig;
  }
});

// X25: r17 多标签页注入——第一个 tab 无 token，第二个 tab 有 token → 依次注入成功
test('resolvePan123 多标签页注入：逐个注入直到读到 token', async () => {
  let injectCall = 0;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      create: async () => ({ id: 1 }),
      remove: async () => {},
    },
    scripting: {
      executeScript: async () => {
        injectCall++;
        // tab1 无 token，tab2 有 token
        return [{ result: injectCall === 1 ? { ok: false, step: 'no-token' } : { ok: true, value: 'tok-multi' } }];
      },
    },
    storage: { local: { get: (_keys, cb) => cb({}) } },
  };
  let authCalls = 0;
  const handlers = [
    {
      match: (u) => u.includes('/share/get'),
      respond: () => res({ code: 0, message: 'ok', data: { Next: '-1', InfoList: [
        { FileId: 1, FileName: 'f.json', Type: 0, Size: 100, S3KeyFlag: '1-0', Etag: 'e1' },
      ] } }),
    },
    {
      match: (u) => u.includes('/share/download/info'),
      respond: (u, opts) => {
        const hdrs = (opts && opts.headers) || {};
        if (hdrs.Authorization === 'Bearer tok-multi') {
          authCalls++;
          return res({ code: 0, message: 'ok', data: {
            DownloadURL: wrapParamsUrl('https://cdn.123/f?auto_redirect=0&t=1'),
          } });
        }
        return res({ code: 5112, message: '您需要注册登录或付费后下载', data: null });
      },
    },
  ];
  try {
    const result = await withMockFetch(handlers, () => resolvePan123('https://www.123pan.com/s/KEY', ''));
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://cdn.123/f?auto_redirect=1&t=1');
    assert.ok(authCalls >= 1, '多标签页注入后应带 token 成功');
  } finally {
    delete globalThis.chrome;
  }
});

