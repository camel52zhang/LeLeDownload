// 回归测试：WeTransfer 网盘解析（extension/background.js 中 detectNetdiskPlatform /
// extractWeTransferIds / expandWeTransferUrl / pickWeTransferError / resolveWeTransfer）
//
// 目的：把 `we.tl/...` 分享链接接进网盘直链解析链路——
//   短链展开 -> prepare-download 取 items -> 每个 item 取 direct_link，
// 并保证各种失败形态（密码保护 / 已过期 / 接口报 Missing parameter / 直链全失败）
// 都抛出人话错误，而不是静默返回空数组让用户以为「解析成功但没文件」。
//
// 纯函数逻辑在本文件内照搬 background.js 实现，mock globalThis.fetch，便于 node --test 直接运行。
//
// 运行： node --test extension/test-wetransfer-parse.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中对应函数保持一致
// ---------------------------------------------------------------------------

// 平台识别（与 background.js detectNetdiskPlatform 一致）
function detectNetdiskPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('baidu')) return 'baidu';
    if (h.includes('aliyun') || h.includes('alipan')) return 'aliyun';
    if (h.includes('quark')) return 'quark';
    if (h.includes('xunlei')) return 'xunlei';
    if (h.includes('123pan') || h.includes('123912') || h.includes('123685') || h.includes('123959')) return 'pan123';
    if (h.includes('cloud.189') || h.includes('189.cn')) return 'tianyi';
    // WeTransfer：短链域 we.tl + 官方主域（含子域），精确匹配避免误伤 weather.com
    if (h === 'we.tl') return 'wetransfer';
    if (h === 'wetransfer.com' || h.endsWith('.wetransfer.com')) return 'wetransfer';
  } catch (_) { /* ignore */ }
  return null;
}

// 统一的 JSON 请求封装（与 background.js fetchJson 一致：不检查状态码，只管能不能 parse）
async function fetchJson(url, opts, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      url,
      Object.assign({ signal: controller.signal, cache: 'no-store', credentials: 'include' }, opts)
    );
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      // 与 background.js 同步：暴露 HTTP 状态码（不可枚举）。
      if (parsed && typeof parsed === 'object') {
        try { Object.defineProperty(parsed, '_status', { value: res.status, enumerable: false, configurable: true, writable: true }); }
        catch (_) { /* ignore */ }
      }
      return parsed;
    }
    catch (_) {
      const st = (res.statusText || '').trim();
      const tag = st ? ' [' + st + ']' : '';
      const body = (text || '').slice(0, 300);
      throw new Error('[HTTP ' + res.status + tag + '] ' + url + ' 非 JSON 响应: ' + body);
    }
  } finally {
    clearTimeout(timer);
  }
}

const WETRANSFER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 单位化展示（与 background.js bytesToSize 一致）
function bytesToSize(n) {
  if (n === undefined || n === null || n === '') return '';
  n = Number(n);
  if (isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + u[i];
}

// 从落地页 URL 提取 transfer_id / security_hash（与 background.js 实现一致）
function extractWeTransferIds(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const seg = u.pathname.split('/').filter((s) => s.length > 0);
    const i = seg.indexOf('downloads');
    if (i < 0 || seg.length < i + 3) return null;
    const transferId = seg[i + 1];
    const securityHash = seg[i + 2];
    if (!transferId || !securityHash) return null;
    return { transferId: transferId, securityHash: securityHash };
  } catch (_) {
    return null;
  }
}

// we.tl 短链展开（与 background.js 实现一致）
async function expandWeTransferUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { throw new Error('WeTransfer 链接格式非法：' + rawUrl); }
  const host = u.hostname.toLowerCase();
  if (host !== 'we.tl' && !host.endsWith('.we.tl')) return u.href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res = null;
  try {
    res = await fetch(u.href, { redirect: 'follow', cache: 'no-store', signal: controller.signal });
  } catch (e) {
    throw new Error('WeTransfer 短链展开失败：' + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
  const finalUrl = (res && res.url) || '';
  if (finalUrl && extractWeTransferIds(finalUrl)) return finalUrl;
  // 兜底：response.url 不可靠时手工跟随 Location
  const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
  if (loc) {
    try { return new URL(loc, u.href).href; } catch (_) { /* ignore */ }
  }
  // 重定向没生效时 response.url 就是短链本身，此时继续下去只会拿到一堆无法解析的地址
  if (finalUrl && finalUrl !== u.href) return finalUrl;
  throw new Error('WeTransfer 短链展开失败：未拿到 wetransfer.com/downloads/ 落地页地址（最终地址：' + (finalUrl || '空') + '）');
}

// 接口错误识别（与 background.js 实现一致：兼容 message/error(对象)/errors[]）
function pickWeTransferError(j) {
  if (!j || typeof j !== 'object') return '接口未返回有效 JSON';
  if (j.message) return String(j.message);
  if (j.error) {
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error === 'object' && j.error.message) return String(j.error.message);
    try { return JSON.stringify(j.error); } catch (_) { return 'error 字段无法序列化'; }
  }
  if (Array.isArray(j.errors) && j.errors.length) {
    const flat = j.errors.map((e) => (e && e.message) ? e.message : (typeof e === 'string' ? e : JSON.stringify(e)));
    return flat.join('；');
  }
  return '';
}

// 主解析器（与 background.js resolveWeTransfer 一致）
async function resolveWeTransfer(url, pwd) {
  const pageUrl = await expandWeTransferUrl(url);
  const ids = extractWeTransferIds(pageUrl);
  if (!ids) {
    throw new Error('无法从 WeTransfer 链接提取 transfer_id / security_hash（应为 wetransfer.com/downloads/<id>/<hash>）：' + pageUrl);
  }
  const transferId = ids.transferId;
  const securityHash = ids.securityHash;
  const api = 'https://wetransfer.com/api/v4/transfers/' + encodeURIComponent(transferId);
  const HDR = {
    'Content-Type': 'application/json',
    'User-Agent': WETRANSFER_UA,
    'Referer': 'https://wetransfer.com/downloads/' + transferId + '/' + securityHash,
    'Origin': 'https://wetransfer.com',
  };

  const prepared = await fetchJson(api + '/prepare-download', {
    method: 'POST',
    headers: HDR,
    body: JSON.stringify({ security_hash: securityHash }),
  }, 15000);
  const prepErr = pickWeTransferError(prepared);
  if (prepErr) throw new Error('WeTransfer 取文件列表失败：' + prepErr);

  // F2 修复：服务端 500 + 空响应不再误导成「items 为空」。
  if (prepared && typeof prepared._status === 'number' && prepared._status >= 400) {
    throw new Error('WeTransfer 取文件列表失败：HTTP ' + prepared._status + '（接口未返回错误说明）');
  }

  if (prepared && prepared.password_protected === true) {
    throw new Error('该分享受密码保护，请在提取码框填入分享密码（当前版本尚未实现 WeTransfer 密码校验，无法解析）');
  }
  const state = prepared && prepared.state;
  if (state && state !== 'downloadable') {
    throw new Error('该分享不可下载（state=' + state + '，可能已过期或已删除）');
  }
  const items = Array.isArray(prepared && prepared.items) ? prepared.items : [];
  if (!items.length) throw new Error('WeTransfer 分享内没有可下载的文件（items 为空）');

  const files = [];
  const failures = [];
  // F9 修复：逐文件取直链并行发起（Promise.all），最坏耗时由 20N 降为单次 20s。
  const tasks = items.map(async (it) => {
    const name = String((it && (it.name || it.display_name)) || 'file');
    // F5 修复：使用 bytesToSize 单位化展示
    const size = it && it.size != null && it.size !== '' ? bytesToSize(Number(it.size)) : '';
    let direct = '';
    let failMsg = '';
    try {
      const d = await fetchJson(api + '/download', {
        method: 'POST',
        headers: HDR,
        body: JSON.stringify({
          intent: 'single_file',
          security_hash: securityHash,
          file_ids: [String(it && it.id)],
        }),
      }, 15000);
      const e2 = pickWeTransferError(d);
      if (e2) throw new Error(e2);
      direct = String((d && (d.direct_link || d.url)) || '');
      if (!direct) throw new Error('接口未返回 direct_link');
    } catch (e) {
      failMsg = String((e && e.message) || e);
      failures.push(name + ': ' + failMsg);
    }
    return { name: name, size: size, url: direct, _fail: failMsg };
  });
  const settled = await Promise.all(tasks);
  for (const r of settled) {
    if (r._fail) continue;
    files.push({ name: r.name, size: r.size, url: r.url });
  }

  if (files.length === 0 && failures.length > 0) {
    throw new Error('WeTransfer 全部文件取直链失败：' + failures.join(' | '));
  }
  // F6 修复：部分失败时返回 {files, warning}，warning 由 Rust 透传、前端琥珀横幅展示。
  let warning;
  if (failures.length > 0) {
    warning = '有 ' + failures.length + ' 个文件取直链失败（其余 ' + files.length + ' 个可用）：' + failures.join('；');
  }
  return { files: files, warning: warning };
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

// 造一个够用的 Response 替身：fetchJson 只用 text()，短链展开用 url / headers.get
function jsonRes(obj, init) {
  const init2 = init || {};
  const status = init2.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status: status,
    statusText: init2.statusText || '',
    url: init2.url || '',
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? (init2.location || null) : null) },
    text: async () => JSON.stringify(obj),
  };
}

// 安装 mock fetch；router(u, opts) 返回 Response 替身或 null（null 视为未预期请求）
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

const TID = 'd841a4a6a30760cc66aa575be501ac0220260831141039';
const SH = '9ba367';
const SHORT = 'https://we.tl/t-BKu1vLhn5uhZxnwn';
const LONG = 'https://wetransfer.com/downloads/' + TID + '/' + SH +
  '?t_exp=1793369439&t_lsid=eab8e17b&t_network=link&t_rid=ZW1haWx8';

function preparedPayload(overrides) {
  return Object.assign({
    id: TID,
    state: 'downloadable',
    password_protected: false,
    size: 13886301,
    items: [
      { id: 'item-aaa', name: 'a.xlsx', size: 13886301, item_type: 'file' },
      { id: 'item-bbb', name: 'b.pdf', size: 2048, item_type: 'file' },
    ],
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// 1) 平台识别：短链 we.tl 与下载落地页都应识别为 wetransfer
test('detectNetdiskPlatform 应识别 we.tl 短链与 wetransfer.com 落地页', () => {
  assert.equal(detectNetdiskPlatform(SHORT), 'wetransfer');
  assert.equal(detectNetdiskPlatform('https://wetransfer.com/downloads/' + TID + '/' + SH), 'wetransfer');
  assert.equal(detectNetdiskPlatform(LONG), 'wetransfer');
});

// 2) 平台识别：无关域名返回 null
test('detectNetdiskPlatform 对无关域名应返回 null', () => {
  assert.equal(detectNetdiskPlatform('https://example.com/a/b'), null);
  assert.equal(detectNetdiskPlatform('not a url'), null);
});

// 3) 防误伤：含 "we" 但与 WeTransfer 无关的域名绝不能判成 wetransfer
test('detectNetdiskPlatform 不应把 weather.com / weibo.com 等误判为 wetransfer', () => {
  assert.equal(detectNetdiskPlatform('https://weather.com/'), null);
  assert.equal(detectNetdiskPlatform('https://www.weibo.com/'), null);
  assert.equal(detectNetdiskPlatform('https://we.tl.evil.com/t-abc'), null, 'we.tl 只能是精确主域，不能是子域后缀');
  assert.equal(detectNetdiskPlatform('https://notwetransfer.com/downloads/a/b'), null);
  assert.equal(detectNetdiskPlatform('https://mywetransfer.com/downloads/a/b'), null);
});

// 4) 既有平台识别不被新增分支破坏
test('detectNetdiskPlatform 对既有平台识别应保持不变', () => {
  assert.equal(detectNetdiskPlatform('https://pan.baidu.com/s/1abc'), 'baidu');
  assert.equal(detectNetdiskPlatform('https://www.alipan.com/s/x'), 'aliyun');
  assert.equal(detectNetdiskPlatform('https://pan.quark.cn/s/x'), 'quark');
  assert.equal(detectNetdiskPlatform('https://pan.xunlei.com/s/x'), 'xunlei');
  assert.equal(detectNetdiskPlatform('https://www.123pan.com/s/x'), 'pan123');
  assert.equal(detectNetdiskPlatform('https://cloud.189.cn/t/x'), 'tianyi');
});

// 5) ID 提取：从完整落地页 URL（带 t_exp 等 query）正确提取 tid / sh
test('extractWeTransferIds 应从落地页 URL 提取 transfer_id 与 security_hash', () => {
  const ids = extractWeTransferIds(LONG);
  assert.deepEqual(ids, { transferId: TID, securityHash: SH });
});

// 6) ID 提取：短链展开后的 URL 同样能提取
test('extractWeTransferIds 应能处理短链展开后的 URL', async () => {
  const calls = mockFetch((u) => (u === SHORT ? jsonRes({}, { url: LONG }) : null));
  const expanded = await expandWeTransferUrl(SHORT);
  assert.equal(calls.length, 1);
  assert.deepEqual(extractWeTransferIds(expanded), { transferId: TID, securityHash: SH });
});

// 7) ID 提取：非 /downloads/ 路径或段数不足应返回 null
test('extractWeTransferIds 对非法路径应返回 null', () => {
  assert.equal(extractWeTransferIds('https://wetransfer.com/downloads/' + TID), null, '缺 security_hash 段');
  assert.equal(extractWeTransferIds('https://wetransfer.com/transfers/' + TID + '/' + SH), null);
  assert.equal(extractWeTransferIds('https://wetransfer.com/'), null);
  assert.equal(extractWeTransferIds('not a url'), null);
});

// 8) 短链展开：已是落地页时不应再发请求
test('expandWeTransferUrl 对落地页地址应原样返回且不发请求', async () => {
  const calls = mockFetch(() => { throw new Error('不应发起请求'); });
  assert.equal(await expandWeTransferUrl(LONG), LONG);
  assert.equal(calls.length, 0);
});

// 9) 短链展开兜底：response.url 不可靠时手工跟随 Location
test('expandWeTransferUrl 在 response.url 不可用时应按 Location 头兜底', async () => {
  mockFetch((u) => (u === SHORT ? jsonRes({}, { url: SHORT, location: LONG }) : null));
  assert.equal(await expandWeTransferUrl(SHORT), LONG);
});

// 10) 短链展开失败要有明确报错
test('expandWeTransferUrl 拿不到落地页时应抛明确错误', async () => {
  mockFetch(() => jsonRes({}, { url: SHORT, location: '' }));
  await assert.rejects(
    () => expandWeTransferUrl(SHORT),
    /短链展开失败/
  );
});

// 11) happy path：短链 -> 文件列表 -> 每个文件各取一次 direct_link
test('resolveWeTransfer happy path 应为每个 item 取到各自的 direct_link', async () => {
  const links = {
    'item-aaa': 'https://download.wetransfer.com/usgv/' + TID + '/hash1/a.xlsx?cf=y&token=t1',
    'item-bbb': 'https://download.wetransfer.com/usgv/' + TID + '/hash2/b.pdf?cf=y&token=t2',
  };
  const calls = mockFetch((u, o) => {
    if (u === SHORT) return jsonRes({}, { url: LONG });
    if (u.endsWith('/prepare-download')) {
      return jsonRes(preparedPayload());
    }
    if (u.endsWith('/download')) {
      const body = JSON.parse(o.body);
      assert.equal(body.intent, 'single_file');
      assert.equal(body.security_hash, SH);
      assert.ok(Array.isArray(body.file_ids) && body.file_ids.length === 1, 'file_ids 必须是数组');
      return jsonRes({ direct_link: links[body.file_ids[0]] });
    }
    return null;
  });

  const { files } = await resolveWeTransfer(SHORT, '');
  assert.equal(files.length, 2);
  // F5 修复后 size 走单位化展示
  assert.deepEqual(files[0], { name: 'a.xlsx', size: '13.24 MB', url: links['item-aaa'] });
  assert.deepEqual(files[1], { name: 'b.pdf', size: '2.00 KB', url: links['item-bbb'] });

  // 请求序列：1 次展开 + 1 次 prepare-download + 2 次 download
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, SHORT);
  assert.ok(calls[1].url.endsWith('/api/v4/transfers/' + TID + '/prepare-download'));
  // 必带头
  assert.equal(calls[1].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].opts.headers['Origin'], 'https://wetransfer.com');
  assert.equal(calls[1].opts.headers['Referer'], 'https://wetransfer.com/downloads/' + TID + '/' + SH);
  assert.ok(calls[1].opts.headers['User-Agent'].includes('Chrome/120.0.0.0'));
});

// 12) 落地页地址（非短链）直接解析也应成功
test('resolveWeTransfer 传入落地页地址时无需展开即可解析', async () => {
  const calls = mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload({ items: [{ id: 'i1', name: 'x.zip', size: 10 }] }));
    if (u.endsWith('/download')) return jsonRes({ direct_link: 'https://download.wetransfer.com/x.zip?token=1' });
    return null;
  });
  const { files } = await resolveWeTransfer('https://wetransfer.com/downloads/' + TID + '/' + SH, null);
  assert.equal(files.length, 1);
  assert.equal(files[0].url, 'https://download.wetransfer.com/x.zip?token=1');
  assert.equal(calls.length, 2, '落地页不应触发短链展开请求');
});

// 13) 密码保护 → 抛出含「密码」的错误
test('resolveWeTransfer 遇到密码保护分享应抛出含「密码」的错误', async () => {
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload({ password_protected: true }));
    return null;
  });
  await assert.rejects(
    () => resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/密码/.test(e.message), '错误信息应含「密码」，实际：' + e.message);
      return true;
    }
  );
});

// 14) state 非 downloadable → 抛出含 state / 过期的错误
test('resolveWeTransfer 遇到非 downloadable 状态应抛出含 state 的错误', async () => {
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload({ state: 'expired' }));
    return null;
  });
  await assert.rejects(
    () => resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/过期/.test(e.message), '错误信息应含「过期」，实际：' + e.message);
      assert.ok(/expired/.test(e.message), '错误信息应带出 state 值，实际：' + e.message);
      return true;
    }
  );
});

// 15) 接口返回 {"message":"Missing parameter ..."} 时必须明确报错，不能静默返回空数组
//     （这两类响应状态码是 400/404，但 body 仍是合法 JSON，fetchJson 不会因状态码失败）
test('resolveWeTransfer 遇到接口 message 报错应明确抛出而非返回空数组', async () => {
  // prepare-download 缺 security_hash
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes({ message: 'Missing parameter :security_hash' }, { status: 400 });
    return null;
  });
  await assert.rejects(
    () => resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/Missing parameter/.test(e.message), '应透出接口原始报错，实际：' + e.message);
      return true;
    }
  );

  // 文件列表正常，但取直链时报 Missing parameter :intent
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload());
    if (u.endsWith('/download')) return jsonRes({ message: 'Missing parameter :intent' }, { status: 400 });
    return null;
  });
  await assert.rejects(
    () => resolveWeTransfer(LONG, ''),
    (e) => {
      assert.ok(/Missing parameter/.test(e.message), '全部文件失败时应抛出，实际：' + e.message);
      assert.ok(/全部文件取直链失败/.test(e.message));
      return true;
    }
  );
});

// 16) items 为空时必须报错，不能返回空数组冒充成功
test('resolveWeTransfer 遇到空 items 应抛错而非返回空数组', async () => {
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload({ items: [] }));
    return null;
  });
  await assert.rejects(() => resolveWeTransfer(LONG, ''), /没有可下载的文件/);
});

// 17) 单个文件取直链失败应降级（该文件 url 留空），不影响其它文件
test('resolveWeTransfer 单文件失败应降级为 url 留空，不拖垮整个分享', async () => {
  mockFetch((u, o) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload());
    if (u.endsWith('/download')) {
      const id = JSON.parse(o.body).file_ids[0];
      if (id === 'item-aaa') return jsonRes({ message: "Couldn't find FileObject" }, { status: 404 });
      return jsonRes({ direct_link: 'https://download.wetransfer.com/ok.pdf?token=1' });
    }
    return null;
  });
  const res = await resolveWeTransfer(LONG, '');
  // F6 修复：部分失败时失败项被丢弃（url 空，Rust 也会过滤），成功项保留，并由 warning 回传失败原因
  const files = res.files;
  assert.equal(files.length, 1, '仅成功文件进入 files，失败项不占用下载任务');
  assert.equal(files[0].name, 'b.pdf');
  assert.equal(files[0].url, 'https://download.wetransfer.com/ok.pdf?token=1');
  assert.ok(res.warning && /1 个文件取直链失败/.test(res.warning), '应带部分失败 warning：' + res.warning);
});

// 18) 非 JSON 响应（如被 WAF 拦成 HTML）也应有明确报错
test('resolveWeTransfer 遇到非 JSON 响应应抛明确错误', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => '<html>Access Denied</html>',
  });
  await assert.rejects(() => resolveWeTransfer(LONG, ''), /非 JSON 响应/);
});

// 19) size 缺失时不应塞入 "undefined" 字符串
test('resolveWeTransfer 在 item 缺 size 时应回退为空字符串', async () => {
  mockFetch((u) => {
    if (u.endsWith('/prepare-download')) return jsonRes(preparedPayload({ items: [{ id: 'i9', name: 'no-size.bin' }] }));
    if (u.endsWith('/download')) return jsonRes({ direct_link: 'https://download.wetransfer.com/n.bin?token=1' });
    return null;
  });
  const { files } = await resolveWeTransfer(LONG, '');
  assert.equal(files[0].size, '');
  assert.notEqual(files[0].size, 'undefined');
});
