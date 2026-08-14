// 回归测试：夸克网盘解析（对齐 quarkApiFetch + resolveQuark 当前实现）
//
// 背景：夸克分享文件不能直接 file/download（报 require login [share missing]）。
//   标准做法（参考 QuarkPanTool / Alist / pdpb.cn）：
//     1) token   POST /1/clouddrive/share/sharepage/token
//               body { pwd_id, passcode, app_ver } -> { data:{ stoken } }
//     2) detail  GET  /1/clouddrive/share/sharepage/detail
//               query pwd_id+stoken+pdir_fid+_page+_size+_sort+_dir -> { data:{ list } }
//               （POST 会 405；递归列出子目录）
//     3) save    POST /1/clouddrive/share/sharepage/save（转存到自己网盘）
//               body { fid_list, fid_token_list, pwd_id, stoken, pdir_fid:'0', scene:'link' }
//               -> { data:{ task_id } }
//     4) task    GET  /1/clouddrive/task?task_id=...&retry_index=0
//               轮询至 status==2（完成）。**新 fid 在 data.save_as.save_as_select_top_fids[]**
//               （纯 fid 字符串数组，按索引与 allFiles 配对；旧结构兜底 save_as.save_as[]、最旧 task_info_list[]）
//     5) download POST /1/clouddrive/file/download  body { fids:[新fid] }
//               -> { data:[ { download_url } ] }
//
//   所有请求必须 credentials:'include'（跨域 fetch 默认不带 cookie，否则 401 require login）
//   且 headers.Referer = https://pan.quark.cn/。
//   函数运行在 pan.quark.cn 页面上下文（content script 注入）；永远返回结构化
//   { ok, step, status, body, files }，绝不抛出（throw 会被吞成 result:null）。
//
// 本测试把上述实现原样内联（MV3 background.js 非 ES module，无法 import），
// 用 mock 的 globalThis.fetch + chrome 做隔离测试，锁定 6 轮踩坑经验不被改坏。
//
// 运行： node --test extension/test-quark.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node 18+/浏览器均提供全局 navigator（含 userAgent），无需手动设置。

// ===== 以下实现镜像 extension/background.js（与夸克当前实现一致） =====

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
let mockQuarkCookie = 'quark_cc=abc; quark_ud=xyz';
async function getCookieString(_url) { return mockQuarkCookie; }

// 在 pan.quark.cn 页面上下文运行
async function quarkApiFetch(pwdId, pwd) {
  const log = (...a) => console.log('[quark-inject]', ...a);
  const headers = { 'Content-Type': 'application/json', 'Referer': 'https://pan.quark.cn/' };
  const out = { ok: false };
  const api = (path) => 'https://drive-pc.quark.cn/1/clouddrive' + path;
  try {
    const tokenResp = await fetch(api('/share/sharepage/token?pr=ucpro&fr=pc'), {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '', app_ver: '2.5.0' }),
    });
    const tokenJson = await tokenResp.json();
    const stoken = tokenJson.data && tokenJson.data.stoken;
    if (!stoken) { out.step = 'token'; out.status = tokenResp.status; out.body = JSON.stringify(tokenJson).slice(0, 200); return out; }
    const allFiles = [];
    async function listDir(pdirFid) {
      const detailQs = '?pr=ucpro&fr=pc&pwd_id=' + encodeURIComponent(pwdId) + '&stoken=' + encodeURIComponent(stoken) +
        '&pdir_fid=' + encodeURIComponent(pdirFid) + '&_page=&_size=100&_sort=&_dir=asc';
      const detailResp = await fetch(api('/share/sharepage/detail' + detailQs), { method: 'GET', headers, credentials: 'include' });
      const detailJson = await detailResp.json();
      const list = (detailJson.data && detailJson.data.list) || [];
      for (const f of list) {
        if (f.dir) await listDir(f.fid);
        else allFiles.push(f);
      }
    }
    await listDir('0');
    if (!allFiles.length) { out.step = 'detail'; out.status = 200; out.body = '分享内没有文件'; return out; }
    const saveResp = await fetch(api('/share/sharepage/save?pr=ucpro&fr=pc'), {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({
        fid_list: allFiles.map((f) => f.fid),
        fid_token_list: allFiles.map((f) => f.share_fid_token || f.fid_token || ''),
        pwd_id: pwdId, stoken: stoken, pdir_fid: '0', scene: 'link',
      }),
    });
    const saveJson = await saveResp.json();
    if (saveJson.status !== 200 || !saveJson.data || !saveJson.data.task_id) {
      out.step = 'save'; out.status = saveResp.status; out.body = JSON.stringify(saveJson).slice(0, 300); return out;
    }
    let taskJson = null;
    let savedList = [];
    for (let i = 0; i < 40; i++) {
      const taskResp = await fetch(api('/task?pr=ucpro&fr=pc&task_id=' + encodeURIComponent(saveJson.data.task_id) + '&retry_index=0'), { method: 'GET', headers, credentials: 'include' });
      taskJson = await taskResp.json();
      const st = taskJson.data && taskJson.data.status;
      if (st === 2) {
        const sa = (taskJson.data && taskJson.data.save_as) || {};
        const saf = sa.save_as_select_top_fids;
        if (Array.isArray(saf) && saf.length) {
          savedList = saf.map((fid) => ({ fid: String(fid) }));
        } else {
          savedList = sa.save_as || [];
          if (!savedList.length) savedList = (taskJson.data && taskJson.data.task_info_list) || [];
        }
        break;
      }
      if (st === 3) {
        out.step = 'task'; out.status = (taskJson && taskJson.status) || 0;
        out.body = '转存任务失败：' + JSON.stringify(taskJson && taskJson.data).slice(0, 300);
        return out;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const files = [];
    for (let i = 0; i < allFiles.length; i++) {
      const src = allFiles[i];
      const saved = savedList[i] || {};
      const nf = saved.fid || saved.file_id || (saved.save_as && saved.save_as.fid) || (typeof saved === 'string' ? saved : '');
      if (!nf) { out.step = 'task'; out.status = (taskJson && taskJson.status) || 0; out.body = '转存任务未返回新fid：' + JSON.stringify(taskJson && taskJson.data).slice(0, 300); return out; }
      const dlResp = await fetch(api('/file/download?pr=ucpro&fr=pc'), {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ fids: [nf] }),
      });
      const dlJson = await dlResp.json();
      const arr = Array.isArray(dlJson.data) ? dlJson.data : [];
      const durl = (arr[0] && arr[0].download_url) || '';
      if (!durl) { out.step = 'download'; out.status = dlResp.status; out.body = JSON.stringify(dlJson).slice(0, 300); out.name = src.file_name; return out; }
      files.push({ name: saved.file_name || src.file_name, size: saved.size || src.size, url: durl });
    }
    out.ok = true; out.files = files;
    return out;
  } catch (e) {
    out.step = 'exception'; out.error = String((e && e.message) || e);
    return out;
  }
}

// ===== resolveQuark 镜像 + chrome mock 支持 =====

async function getQuarkPageTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://pan.quark.cn/s/*' });
    if (tabs && tabs.length) return tabs[0].id;
  } catch (_) {}
  return null;
}
async function waitTabComplete(tabId) {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return;
    } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function resolveQuark(url, pwd) {
  const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const pwdId = m ? m[1] : '';
  if (!pwdId) throw new Error('无法从链接提取分享ID');
  const cookie = await getCookieString('https://pan.quark.cn');
  if (!cookie) throw new Error('未检测到夸克网盘登录态，请先在浏览器登录 pan.quark.cn');
  const existing = await getQuarkPageTab();
  let tabId = existing;
  let tempTabId = null;
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: 'https://pan.quark.cn/s/' + pwdId, active: false });
    tempTabId = tab.id;
    await waitTabComplete(tempTabId);
    tabId = tempTabId;
  }
  try {
    await new Promise((rs) => setTimeout(rs, 5));
    let r = null;
    let lastRes = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lastRes = await chrome.scripting.executeScript({
          target: { tabId },
          func: quarkApiFetch,
          args: [pwdId, pwd || ''],
        });
        r = lastRes && lastRes[0] && lastRes[0].result;
      } catch (e2) {
        r = null;
        lastRes = { injectError: String((e2 && e2.message) || e2) };
      }
      if (r && r.ok) break;
      if (tempTabId == null) {
        const tab = await chrome.tabs.create({ url: 'https://pan.quark.cn/s/' + pwdId, active: false });
        tempTabId = tab.id;
        await waitTabComplete(tempTabId);
        tabId = tempTabId;
      } else {
        await waitTabComplete(tabId);
      }
      await new Promise((rs) => setTimeout(rs, 5));
    }
    if (!r || !r.ok) {
      const detail = r ? (r.error || r.body || '无详情') : (lastRes && lastRes.injectError ? ('inject失败:' + lastRes.injectError) : JSON.stringify(lastRes));
      const loginHint = /login|未登录|请先登录/i.test(detail) ? '；请确认已在当前浏览器登录 pan.quark.cn' : '';
      throw new Error('夸克解析失败(' + (r ? r.step : 'null-result') + ')：' + detail + loginHint);
    }
    const files = r.files || [];
    if (!files.length) throw new Error('夸克解析为空(分享内无文件)');
    return files.map((f) => ({
      name: f.name,
      size: bytesToSize(f.size),
      url: f.url,
      headers: { Referer: 'https://pan.quark.cn/', 'User-Agent': navigator.userAgent, Cookie: cookie },
    }));
  } finally {
    if (tempTabId != null) { try { await chrome.tabs.remove(tempTabId); } catch (_) {} }
  }
}

// ===== 测试夹具 =====
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

// ---------------------------------------------------------------------------
// Q1: 完整链路（单文件）token→detail→save→task(新结构)→download → 返回 files
// ---------------------------------------------------------------------------
test('quarkApiFetch 完整链路：token→detail→save→task→download 返回带直链的文件', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'ORIG1', file_name: 'a.txt', size: 10, share_fid_token: 'TOK1' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'TID' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['NEWFID1'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x.quark.cn/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await quarkApiFetch('08bd11b6e072', '');
  assert.equal(out.ok, true, '应解析成功');
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].name, 'a.txt');
  assert.equal(out.files[0].url, 'https://x.quark.cn/dl/a.txt');
});

// ---------------------------------------------------------------------------
// Q2: 所有请求都带 credentials:'include'（否则 401 require login）
// ---------------------------------------------------------------------------
test('quarkApiFetch 四类请求均带 credentials:include', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['N'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  await quarkApiFetch('p', '');
  for (const c of rec.calls) {
    assert.equal(c.opts.credentials, 'include', '请求 ' + c.url + ' 必须带 credentials:include');
  }
});

// ---------------------------------------------------------------------------
// Q3: 所有请求 headers.Referer = https://pan.quark.cn/
// ---------------------------------------------------------------------------
test('quarkApiFetch 所有请求 Referer = https://pan.quark.cn/', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['N'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  await quarkApiFetch('p', '');
  for (const c of rec.calls) {
    assert.equal(c.opts.headers && c.opts.headers['Referer'], 'https://pan.quark.cn/', '请求 ' + c.url + ' Referer 必须为 pan.quark.cn');
  }
});

// ---------------------------------------------------------------------------
// Q4: token 未返回 stoken → step 'token'
// ---------------------------------------------------------------------------
test('quarkApiFetch token 无 stoken → step token', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('sharepage/token')) return { json: async () => ({ status: 200, data: {} }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, false);
  assert.equal(out.step, 'token');
});

// ---------------------------------------------------------------------------
// Q5: detail 返回空列表 → step 'detail'，body '分享内没有文件'
// ---------------------------------------------------------------------------
test('quarkApiFetch detail 无文件 → step detail', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (String(u).includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [] } }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.step, 'detail');
  assert.equal(out.body, '分享内没有文件');
});

// ---------------------------------------------------------------------------
// Q6: save 失败 → step 'save'
// ---------------------------------------------------------------------------
test('quarkApiFetch save 失败 → step save', async () => {
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (s.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (s.includes('sharepage/save')) return { json: async () => ({ status: 500, data: {} }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.step, 'save');
});

// ---------------------------------------------------------------------------
// Q7: task status 3（转存失败）→ step 'task'，body 含「转存任务失败」
// ---------------------------------------------------------------------------
test('quarkApiFetch task status=3 → step task 转存失败', async () => {
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (s.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (s.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (s.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 3 } }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.step, 'task');
  assert.ok(out.body.includes('转存任务失败'), 'body 应含「转存任务失败」');
});

// ---------------------------------------------------------------------------
// Q8: 新 fid 必须从 save_as_select_top_fids 取，download 用新 fid（非原始 fid）
// ---------------------------------------------------------------------------
test('quarkApiFetch 用 save_as_select_top_fids 的新 fid 下载（非原始分享 fid）', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'ORIGFID', file_name: 'a.txt', size: 10, share_fid_token: 'TOK' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'TID' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['NEWFID'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, true);
  const dl = findCall(rec.calls, 'file/download');
  assert.ok(dl, '应发起 file/download');
  assert.ok(dl.body.includes('"fids":["NEWFID"]'), 'download 必须用新 fid NEWFID，实际: ' + dl.body);
  assert.ok(!dl.body.includes('ORIGFID'), 'download 不得用原始分享 fid');
});

// ---------------------------------------------------------------------------
// Q9: 旧结构兜底 save_as.save_as[]（对象数组含 fid）仍可取新 fid
// ---------------------------------------------------------------------------
test('quarkApiFetch 旧结构 save_as.save_as[] 兜底取新 fid', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as: [{ fid: 'OLDFID', file_name: 'a', size: 1 }] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, true);
  const dl = findCall(rec.calls, 'file/download');
  assert.ok(dl.body.includes('"fids":["OLDFID"]'), '旧结构应从 save_as[] 取 fid，实际: ' + dl.body);
});

// ---------------------------------------------------------------------------
// Q10: 最旧结构兜底 task_info_list[] 仍可取新 fid
// ---------------------------------------------------------------------------
test('quarkApiFetch 最旧结构 task_info_list[] 兜底取新 fid', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, task_info_list: [{ fid: 'LEGACYFID' }] } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, true);
  const dl = findCall(rec.calls, 'file/download');
  assert.ok(dl.body.includes('"fids":["LEGACYFID"]'), '最旧结构应从 task_info_list[] 取 fid，实际: ' + dl.body);
});

// ---------------------------------------------------------------------------
// Q11: download 无 download_url → step 'download'
// ---------------------------------------------------------------------------
test('quarkApiFetch download 无 download_url → step download', async () => {
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (s.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a', size: 1, share_fid_token: 'T' }] } }), ok: true };
    if (s.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (s.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['NEWFID'] } } }), ok: true };
    if (s.includes('file/download')) return { json: async () => ({ status: 200, data: [] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.step, 'download');
});

// ---------------------------------------------------------------------------
// Q12: fetch 抛异常 → step 'exception'，ok=false（绝不抛成 result:null 黑洞）
// ---------------------------------------------------------------------------
test('quarkApiFetch fetch 抛异常时返回结构化 exception（不抛错）', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('sharepage/token')) throw new Error('network down');
    throw new Error('unexpected ' + u);
  };
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, false);
  assert.equal(out.step, 'exception');
  assert.ok(out.error.includes('network down'), '应记录异常信息');
});

// ---------------------------------------------------------------------------
// Q13: 子目录递归 —— detail 含 dir:true 触发 listDir 递归，allFiles 收集所有叶文件
// ---------------------------------------------------------------------------
test('quarkApiFetch 递归列出子目录文件', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) {
      // 根目录（pdir_fid=0）含一个子目录；子目录（pdir_fid=DIR1）含一个文件
      if (u.includes('pdir_fid=0')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'DIR1', dir: true, file_name: 'sub', share_fid_token: 'TD' }] } }), ok: true };
      return { json: async () => ({ status: 200, data: { list: [{ fid: 'LEAF', file_name: 'leaf.txt', size: 5, share_fid_token: 'TL' }] } }), ok: true };
    }
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['NEWFID'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x/dl' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await quarkApiFetch('p', '');
  assert.equal(out.ok, true);
  assert.equal(out.files.length, 1, '应递归收集到叶子文件（子目录本身不下载）');
  assert.equal(out.files[0].name, 'leaf.txt');
});

// ---------------------------------------------------------------------------
// Q14: resolveQuark 集成（mock chrome.tabs + executeScript 实际运行 quarkApiFetch）
// ---------------------------------------------------------------------------
test('resolveQuark 集成：复用/新建夸克标签页，executeScript 运行 quarkApiFetch 返回文件', async () => {
  mockQuarkCookie = 'quark_cc=abc; quark_ud=xyz';
  globalThis.chrome = {
    tabs: {
      query: async () => [],
      create: async () => ({ id: 999 }),
      get: async () => ({ status: 'complete' }),
      remove: async () => {},
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const result = await func(...args);
        return [{ result }];
      },
    },
    runtime: {},
  };
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('sharepage/token')) return { json: async () => ({ status: 200, data: { stoken: 'STOK' } }), ok: true };
    if (u.includes('sharepage/detail')) return { json: async () => ({ status: 200, data: { list: [{ fid: 'O', file_name: 'a.txt', size: 10, share_fid_token: 'T' }] } }), ok: true };
    if (u.includes('sharepage/save')) return { json: async () => ({ status: 200, data: { task_id: 'T' } }), ok: true };
    if (u.includes('/task?')) return { json: async () => ({ status: 200, data: { status: 2, save_as: { save_as_select_top_fids: ['NEWFID'] } } }), ok: true };
    if (u.includes('file/download')) return { json: async () => ({ status: 200, data: [{ download_url: 'https://x.quark.cn/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  try {
    const out = await resolveQuark('https://pan.quark.cn/s/08bd11b6e072', '');
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'a.txt');
    assert.equal(out[0].url, 'https://x.quark.cn/dl/a.txt');
    // 回传 headers 含夸克登录态 cookie / Referer / UA
    assert.ok(/quark_cc=/.test(out[0].headers.Cookie), '回传 headers 必须含夸克 Cookie');
    assert.equal(out[0].headers.Referer, 'https://pan.quark.cn/');
    assert.ok(out[0].headers['User-Agent'].length > 0, '回传 UA 不得为空');
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// Q15: resolveQuark 未登录（cookie 为空）→ 明确错误，不调 executeScript
// ---------------------------------------------------------------------------
test('resolveQuark 未检测到夸克登录态时抛错且不发起注入', async () => {
  mockQuarkCookie = '';
  let injected = false;
  globalThis.chrome = {
    tabs: { query: async () => [], create: async () => ({ id: 1 }), get: async () => ({ status: 'complete' }), remove: async () => {} },
    scripting: { executeScript: async () => { injected = true; return [{ result: { ok: true, files: [] } }]; } },
    runtime: {},
  };
  globalThis.fetch = async () => { throw new Error('不应被调用'); };
  try {
    await assert.rejects(() => resolveQuark('https://pan.quark.cn/s/08bd11b6e072', ''), /未检测到夸克网盘登录态/);
    assert.equal(injected, false, '未登录时不应调用 executeScript');
  } finally {
    delete globalThis.chrome;
    mockQuarkCookie = 'quark_cc=abc; quark_ud=xyz';
  }
});

// ---------------------------------------------------------------------------
// Q16: resolveQuark 注入结果 ok=false → 抛出含 step 的精确错误（永不 result:null 黑洞）
// ---------------------------------------------------------------------------
test('resolveQuark 注入返回 ok=false 时抛出含 step 的精确错误', async () => {
  mockQuarkCookie = 'quark_cc=abc';
  globalThis.chrome = {
    tabs: { query: async () => [{ id: 5 }], create: async () => ({ id: 1 }), get: async () => ({ status: 'complete' }), remove: async () => {} },
    scripting: { executeScript: async () => [{ result: { ok: false, step: 'download', status: 401, body: 'require login' } }] },
    runtime: {},
  };
  globalThis.fetch = async () => { throw new Error('不应被调用'); };
  try {
    await assert.rejects(() => resolveQuark('https://pan.quark.cn/s/08bd11b6e072', ''), /夸克解析失败\(download\)/);
  } finally {
    delete globalThis.chrome;
    mockQuarkCookie = 'quark_cc=abc; quark_ud=xyz';
  }
});
