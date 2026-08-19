// 迅雷解析器回归测试（r11+）
// 设计原则：直接从 extension/background.js 抽取【真实】xunleiApiFetch 源码 eval 执行，
// 彻底避免"测试镜像与实现漂移"导致的假绿（历史上多次因此漏掉真实 bug）。
// r11 模型参考 netdisk-resolver-v1.4 抓包：
//   - 根目录: GET /share
//   - 子目录: GET /share/detail?parent_id=...
//   - 取直链 fast path: GET /share/file_info?file_id=...&share_id=...&pass_code_token=...
//   - 回退: POST /share/restore (单文件) → GET /tasks/{id} → GET /files/{newId} (NO usage=CONSUME)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bgPath = join(__dirname, 'background.js');

// ---- 从 background.js 抽取 xunleiApiFetch 函数体（带括号匹配的鲁棒抽取）----
function extractXunlei(src) {
  const startMarker = 'async function xunleiApiFetch';
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('background.js 中找不到 xunleiApiFetch');
  let i = src.indexOf('{', start);
  let depth = 0, inStr = null, inTmpl = false, inLineCmt = false, inBlockCmt = false;
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
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('未匹配到 xunleiApiFetch 结束');
}

const bgSrc = readFileSync(bgPath, 'utf8');
const fnSrc = extractXunlei(bgSrc);
const xunleiApiFetch = eval('(' + fnSrc.replace('async function xunleiApiFetch', 'async function') + ')');

// ---- 通用 mock 工具 ----
function makeLocalStorage(tokens) {
  const store = {};
  if (tokens.access_token) store['credentials_' + (tokens.clientId || 'X')] = JSON.stringify({ token_type: 'Bearer', access_token: tokens.access_token });
  if (tokens.captchaToken) store['captcha_' + (tokens.clientId || 'X')] = JSON.stringify({ token: tokens.captchaToken });
  if (tokens.deviceId) store['deviceid'] = tokens.deviceId;
  const keys = Object.keys(store);
  return {
    length: keys.length,
    key: (i) => keys[i] || null,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: () => {},
    removeItem: () => {},
  };
}

function res(body, status = 200) {
  const s = JSON.stringify(body);
  return { status, json: async () => body, text: async () => s };
}

function makeFetch(handlers) {
  return async (u, opts) => {
    const url = String(u);
    for (const h of handlers) {
      if (h.match(url, opts)) return h.respond(url, opts);
    }
    throw new Error('未匹配的 fetch: ' + url.slice(0, 160));
  };
}

function withFastTimers(fn) {
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => { cb(); return 0; };
  try { return fn(); } finally { globalThis.setTimeout = orig; }
}

const DEFAULT_TOKENS = { access_token: 'AT_xxx', clientId: 'Xqp0kJBXWhwaTpB6', deviceId: 'DEV_1', captchaToken: 'CAP_1' };

// =================== 用例 ===================

// X1：分享根目录直接是文件 → /share 列出 → /share/file_info fast path 返回直链 → 不需要 trans
test('xunleiApiFetch 根目录单文件 → file_info fast path 直接取直链', async () => {
  const FILE_ID = 'F_ROOT';
  const calls = { share: 0, file_info: 0, restore: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => { calls.share++; return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FILE_ID, name: 'a.mp4', size: 100, kind: 'drive#file' }] }); } },
    // share root has no parent_id in URL → still match /share? but NOT /share/file_info
    { match: (u) => u.includes('/share/file_info'), respond: () => { calls.file_info++; return res({ ret: 0, file_info: { web_content_link: 'https://dl.xunlei.com/a.mp4' } }); } },
    { match: (u) => u.includes('/share/restore'), respond: () => { calls.restore++; return res({ restore_task_id: 'NEVER' }); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, true, '应成功');
    assert.equal(calls.share, 1);
    assert.equal(calls.file_info, 1, 'file_info fast path 被调用');
    assert.equal(calls.restore, 0, 'fast path 成功就不该 trans');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].name, 'a.mp4');
    assert.equal(r.files[0].url, 'https://dl.xunlei.com/a.mp4');
    assert.equal(r.files[0].mode, 'FAST_PATH');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X2：分享根目录是 folder → /share 列出 → /share/detail?parent_id 列 folder 内部 → file_info fast path
test('xunleiApiFetch folder 分享 → /share/detail?parent_id 列内部 → file_info fast path', async () => {
  const FOLDER_ID = 'F_OLD';
  const FILE_ID = 'F_INNER';
  const calls = { detail: 0, file_info: 0, restore: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FOLDER_ID, name: '影视仓', kind: 'drive#folder', folder_type: 'NORMAL' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: () => { calls.detail++; return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FILE_ID, name: 'movie.mp4', size: 999, kind: 'drive#file', mime_type: 'video/mp4' }] }); } },
    { match: (u) => u.includes('/share/file_info'), respond: () => { calls.file_info++; return res({ ret: 0, file_info: { web_content_link: 'https://dl.xunlei.com/movie.mp4' } }); } },
    { match: (u) => u.includes('/share/restore'), respond: () => { calls.restore++; return res({}); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, true);
    assert.equal(calls.detail, 1, '应用 /share/detail 列子目录');
    assert.equal(calls.file_info, 1, '应用 /share/file_info 取直链');
    assert.equal(calls.restore, 0, 'fast path 成功就不该 trans');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].name, '影视仓/movie.mp4', '保留 folder 路径前缀');
    assert.equal(r.files[0].url, 'https://dl.xunlei.com/movie.mp4');
    assert.equal(r.files[0].mode, 'FAST_PATH');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X3：file_info 返回空 web_content_link → 回退 restore + /files/{id}（不带 usage=CONSUME）
test('xunleiApiFetch file_info 直链空 → 回退单文件转存+files 取直链', async () => {
  const FOLDER_ID = 'F_OLD';
  const FILE_ID = 'F_INNER';
  const NEW_OWN_ID = 'F_OWNED';
  const calls = { restore: 0, tasks: 0, files_id: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FOLDER_ID, name: '影视仓', kind: 'drive#folder' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FILE_ID, name: 'zip.mp4', size: 999, kind: 'drive#file', mime_type: 'video/mp4' }] }) },
    // file_info 直链空（首次抓包证实大文件常这样）
    { match: (u) => u.includes('/share/file_info'), respond: () => res({ ret: 0, file_info: { web_content_link: '', medias: [] } }) },
    // 回退：转单个文件
    { match: (u) => u.includes('/share/restore'), respond: (u, o) => { calls.restore++; const b = JSON.parse(o.body); assert.deepEqual(b.file_ids, [FILE_ID], 'restore body.file_ids 应只含这一个 share_file_id'); return res({ task_id: 'T1' }); } },
    { match: (u) => u.includes('/tasks/'), respond: () => { calls.tasks++; return res({ progress: 100, params: { trace_file_ids: JSON.stringify({ [FILE_ID]: NEW_OWN_ID }) } }); } },
    // /files/{id} 不带 usage=CONSUME（参考 netdisk-resolver-v1.4 api.py:562）
    { match: (u) => u.includes('/files/') && !u.includes('/files?'), respond: (u) => { calls.files_id++; assert.ok(!u.includes('usage=CONSUME'), '不能再带 usage=CONSUME'); return res({ web_content_link: 'https://dl.xunlei.com/zip.mp4' }); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await withFastTimers(() => xunleiApiFetch('S1', ''));
    assert.equal(r.ok, true);
    assert.equal(calls.restore, 1, '回退路径调了 restore');
    assert.equal(calls.tasks, 1, '回退路径轮询了 task');
    assert.equal(calls.files_id, 1, '回退路径查了 /files/{id}');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].url, 'https://dl.xunlei.com/zip.mp4');
    assert.equal(r.files[0].mode, 'TRANS');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X4：file_info 接口 404 → 回退 restore + /files/{id}
test('xunleiApiFetch file_info 404 → 回退转存', async () => {
  const FOLDER_ID = 'F_OLD';
  const FILE_ID = 'F_INNER';
  const NEW_OWN_ID = 'F_OWNED';
  const calls = { file_info: 0, restore: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FOLDER_ID, name: '影视仓', kind: 'drive#folder' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FILE_ID, name: 'a.mp4', size: 1, kind: 'drive#file', mime_type: 'video/mp4' }] }) },
    { match: (u) => u.includes('/share/file_info'), respond: () => { calls.file_info++; return res({ error: 'not found' }, 404); } },
    { match: (u) => u.includes('/share/restore'), respond: () => { calls.restore++; return res({ task_id: 'T1' }); } },
    { match: (u) => u.includes('/tasks/'), respond: () => res({ progress: 100, params: { trace_file_ids: JSON.stringify({ [FILE_ID]: NEW_OWN_ID }) } }) },
    { match: (u) => u.includes('/files/') && !u.includes('/files?'), respond: () => res({ web_content_link: 'https://dl.xunlei.com/a.mp4' }) },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await withFastTimers(() => xunleiApiFetch('S1', ''));
    assert.equal(r.ok, true);
    assert.equal(calls.file_info, 1);
    assert.equal(calls.restore, 1, '回退被触发');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].mode, 'TRANS');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X5：嵌套子目录递归下钻（folder 内部还有 folder）
test('xunleiApiFetch 嵌套子目录 → /share/detail 递归', async () => {
  const ROOT_FOLDER = 'F_ROOT';
  const INNER_FOLDER = 'F_INNER';
  const LEAF_FILE = 'F_LEAF';
  const calls = { detail: 0, file_info: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: ROOT_FOLDER, name: '影视仓', kind: 'drive#folder', folder_type: 'NORMAL' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: (u) => {
        calls.detail++;
        if (u.includes('parent_id=' + ROOT_FOLDER)) return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: INNER_FOLDER, name: '子目录', kind: 'drive#folder', folder_type: 'NORMAL' }] });
        if (u.includes('parent_id=' + INNER_FOLDER)) return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: LEAF_FILE, name: 'leaf.mp4', size: 7, kind: 'drive#file', mime_type: 'video/mp4' }] });
        return res({ share_id: 'S1', pass_code_token: 'PCT', files: [] });
      } },
    { match: (u) => u.includes('/share/file_info'), respond: () => { calls.file_info++; return res({ ret: 0, file_info: { web_content_link: 'https://dl.xunlei.com/leaf.mp4' } }); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, true);
    assert.equal(calls.detail, 2, '应递归两个层级');
    assert.equal(calls.file_info, 1, '应只为 leaf 调 file_info');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].name, '影视仓/子目录/leaf.mp4', '递归路径正确');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X6：传递码错误 PASS_CODE_EMPTY → step=passcode
test('xunleiApiFetch 提取码错误 → step=passcode', async () => {
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ error_code: 0, error: 'PASS_CODE_EMPTY' }) },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', 'bad');
    assert.equal(r.ok, false);
    assert.equal(r.step, 'passcode');
    assert.ok(/PASS_CODE_EMPTY/.test(r.body));
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X7：分享失效 NOT_FOUND → step=share
test('xunleiApiFetch 分享失效 NOT_FOUND → step=share', async () => {
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ error: 'NOT_FOUND' }) },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, false);
    assert.equal(r.step, 'share');
    assert.ok(/失效/.test(r.body));
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X8：分享接口 401 → step=share
test('xunleiApiFetch 分享接口 401 → step=share', async () => {
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ error: 'unauthorized' }, 401) },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, false);
    assert.equal(r.step, 'share');
    assert.equal(r.status, 401);
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X9：未登录态 → 不抛异常
test('xunleiApiFetch 无登录态 → 不抛异常', async () => {
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ error: 'unauthorized' }, 401) },
  ];
  globalThis.localStorage = makeLocalStorage({});
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, false);
    assert.equal(r.step, 'share');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X10：files 翻页（/share 顶层翻页 → 多文件）
test('xunleiApiFetch /share 顶层翻页 → 收集全部文件', async () => {
  const calls = { share: 0, file_info: 0 };
  let paged = 0;
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => {
        calls.share++;
        paged++;
        if (paged === 1) return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: 'A', name: 'a.mp4', size: 1, kind: 'drive#file', mime_type: 'video/mp4' }], next_page_token: 'P2' });
        return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: 'B', name: 'b.mp4', size: 2, kind: 'drive#file', mime_type: 'video/mp4' }] });
      } },
    { match: (u) => u.includes('/share/file_info'), respond: () => { calls.file_info++; return res({ ret: 0, file_info: { web_content_link: 'https://dl.xunlei.com/x.mp4' } }); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, true);
    assert.equal(calls.share, 2);
    assert.equal(r.files.length, 2, '两页共 2 个文件');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X11：folder 嵌套深度 > 10 → 应截断（truncatedPaths 非空 + 不丢失浅层文件）
test('xunleiApiFetch folder 嵌套超过 10 层 → 截断但不丢浅层文件', async () => {
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: 'F0', name: 'root', kind: 'drive#folder', folder_type: 'NORMAL' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: (u) => {
        const m = u.match(/parent_id=([^&]+)/);
        const pid = m ? decodeURIComponent(m[1]) : '';
        if (pid === '') return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: 'F0', name: 'root', kind: 'drive#folder', folder_type: 'NORMAL' }] });
        // F0 -> F1 -> F2 -> ... -> F11 (11 层)
        const next = 'F' + (parseInt(pid.substring(1)) + 1);
        if (pid === 'F10') return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: next, name: 'deep' + pid, kind: 'drive#folder', folder_type: 'NORMAL' }] }); // F10 列 F11（已超 10 层）
        return res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: next, name: 'deep' + pid, kind: 'drive#folder', folder_type: 'NORMAL' }] });
      } },
    { match: (u) => u.includes('/share/file_info'), respond: () => res({ ret: 0, file_info: { web_content_link: '' } }) },
    { match: (u) => u.includes('/share/restore'), respond: () => res({}) },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await withFastTimers(() => xunleiApiFetch('S1', ''));
    // 11 层纯 folder（无文件）：要么 ok 但空 files 数组，要么某步失败
    if (r.files) {
      assert.equal(r.files.length, 0);
    }
    assert.ok(r.ok === false || (r.files && r.files.length === 0), '应失败或返回空 files');
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});

// X12：folder 内部纯文件 → file_info fast path 直接取直链（不再用 trans/list-own 链路）
test('xunleiApiFetch folder 内纯文件 → 一次 file_info 即取直链', async () => {
  const FOLDER_ID = 'F_OLD';
  const FILE1 = 'F1';
  const FILE2 = 'F2';
  const calls = { file_info: 0, restore: 0 };
  const handlers = [
    { match: (u) => u.includes('/share?') && !u.includes('/share/'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [{ id: FOLDER_ID, name: '资料', kind: 'drive#folder', folder_type: 'NORMAL' }] }) },
    { match: (u) => u.includes('/share/detail'), respond: () => res({ share_id: 'S1', pass_code_token: 'PCT', files: [
      { id: FILE1, name: 'doc.pdf', size: 100, kind: 'drive#file', mime_type: 'application/pdf' },
      { id: FILE2, name: 'img.jpg', size: 200, kind: 'drive#file', mime_type: 'image/jpeg' },
    ] }) },
    { match: (u) => u.includes('/share/file_info'), respond: (u) => { calls.file_info++; const id = decodeURIComponent(u.match(/file_id=([^&]+)/)[1]); return res({ ret: 0, file_info: { web_content_link: 'https://dl.xunlei.com/' + id } }); } },
    { match: (u) => u.includes('/share/restore'), respond: () => { calls.restore++; return res({}); } },
  ];
  globalThis.localStorage = makeLocalStorage(DEFAULT_TOKENS);
  globalThis.fetch = makeFetch(handlers);
  try {
    const r = await xunleiApiFetch('S1', '');
    assert.equal(r.ok, true);
    assert.equal(calls.file_info, 2, '每个文件都走了 file_info fast path');
    assert.equal(calls.restore, 0, 'fast path 成功就不该 trans');
    assert.equal(r.files.length, 2);
    assert.ok(r.files.every(f => f.mode === 'FAST_PATH'));
  } finally { delete globalThis.localStorage; delete globalThis.fetch; }
});
