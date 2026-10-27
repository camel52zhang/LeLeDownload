// 回归测试：百度网盘解析（对齐 wxlist + tplconfig + sharedownload 新流程）
//
// 背景：百度已停用旧的 window.yunData / api/shareinfo / api/share/list 流程
//   （/s/、/e/ 新短链用旧流程一律返回 errno 2 / -7，根本拿不到列表）。
//   当前权威接口（参考 baiduwp-php / 94list / kdown.moiu.cn / netdisk-resolver）：
//     1) 列表  POST /share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1
//        body shorturl=<surl>&dir=&root=1&pwd=<pwd>&page=1&num=1000&order=time
//        -> { errno:0, data:{ uk, shareid, seckey, list:[...] } }
//        /s/、/e/ 用 bare shorturl；?surl= 旧链用 '1'+CODE。
//        errno 2=链接失效；-9/-10/-12=提取码错误。
//     2) 令牌  GET /share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&surl=<surl>
//        -> data.sign / data.timestamp（失败不致命，返回空）
//     3) 直链  POST /api/sharedownload?channel=chunlei&clienttype=0&app_id=250528&sign&timestamp&web=1
//        body encrypt=0&product=share&primaryid=<id>&shareid=<id>&uk=<uk>
//             &fid_list=[fs_id]&extra={"sekey":<seckey>}
//        headers Referer=https://pan.baidu.com/share/link?shareid=<id>&uk=<uk> + X-Requested-With
//        wxlist 返回的 seckey 即带密分享验证令牌，无需先 /share/verify；
//        仅当返回 errno 9019 needverify 时才补 /share/verify 取 BDCLND 桥接进 cookie 后用 randsk 重试。
//
// 本测试把上述实现原样内联（MV3 background.js 非 ES module，无法 import），
// 用 mock 的 globalThis.fetch + chrome 做隔离测试，锁定新流程不被再次改坏。
//
// 运行： node --test extension/test-baidu.mjs
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ===== 以下实现镜像 extension/background.js（与 wxlist 新流程一致） =====

// 统一的 JSON 请求封装（与 background.js fetchJson 一致：非 JSON 响应报错带 [HTTP 状态码] + statusText + URL）
async function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, Object.assign({ signal: controller.signal, cache: 'no-store', credentials: 'include' }, opts));
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (_) {
      const st = (res.statusText || '').trim();
      const tag = st ? ' [' + st + ']' : '';
      throw new Error('[HTTP ' + res.status + tag + '] ' + url + ' 非 JSON 响应: ' + (text || '').slice(0, 300));
    }
  } finally {
    clearTimeout(timer);
  }
}

// getCookieString 的可控 mock：真实实现读 chrome.cookies，此处用变量模拟登录态
let mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
async function getCookieString(_url) {
  return mockCookie;
}

async function ensureBaiduAuthHeaders(cookieOverride) {
  try {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest ||
        typeof chrome.declarativeNetRequest.updateSessionRules !== 'function') return;
    const cookie = cookieOverride || await getCookieString('https://pan.baidu.com');
    if (!cookie) return;
    const rules = [{
      id: 5001, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Cookie', operation: 'set', value: cookie },
        { header: 'Referer', operation: 'set', value: 'https://pan.baidu.com/' },
      ]},
      condition: { urlFilter: '||pan.baidu.com/', resourceTypes: ['xmlhttprequest'] },
    }];
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules, removeRuleIds: [5001] });
  } catch (_) { /* DNR 不可用/被拒时静默降级 */ }
}

function bytesToSize(n) {
  if (n === undefined || n === null || n === '') return '';
  n = Number(n);
  if (isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + u[i];
}

// 列表：wxlist
async function baiduWxList(apiShorturl, pwd, dirPath) {
  // dirPath：百度 wxlist 的 dir 参数（绝对路径形式，如 "/book"），用于递归进文件夹；
  // 不传或空 = 根目录（root=1）。镜像与 background.js 保持一致。
  const body = 'shorturl=' + encodeURIComponent(apiShorturl) +
    (dirPath ? '&dir=' + encodeURIComponent(dirPath) : '&dir=') +
    (dirPath ? '&root=0' : '&root=1') +
    '&pwd=' + encodeURIComponent(pwd || '') +
    '&page=1&num=1000&order=time';
  let res;
  try {
    res = await fetchJson('https://pan.baidu.com/share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 7.1.1; MI 6 Build/NMF26X; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/6.2 TBS/043807 Mobile Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/4G Language/zh_CN',
        'Referer': 'https://pan.baidu.com/disk/home',
      },
      body,
    });
  } catch (e) {
    throw new Error('百度 wxlist 请求失败（shorturl=' + apiShorturl + '）：' + e.message);
  }
  const en = (typeof res.errno !== 'undefined') ? Number(res.errno) : '';
  const d = res.data || {};
  if (en !== '' && en !== 0) {
    if (en === 2) throw new Error('百度分享链接无效或已失效（errno 2）：' + apiShorturl);
    if (en === -9 || en === -10 || en === -12) {
      throw new Error('百度提取码错误（errno ' + en + (res.errmsg ? ': ' + res.errmsg : '') + '）（pwd=' + (pwd || '(空)') + ', shorturl=' + apiShorturl + '）');
    }
    throw new Error('百度 wxlist 失败（errno ' + en + (res.errmsg ? ': ' + res.errmsg : '') + '）（shorturl=' + apiShorturl + '）');
  }
  const list = (d.list || []);
  const uk = String(d.uk || '');
  const shareid = String(d.shareid || '');
  const seckey = (d.seckey != null) ? String(d.seckey) : '';
  if (!uk || !shareid) throw new Error('百度 wxlist 未返回 uk/shareid（链接可能已失效或提取码不正确）：' + apiShorturl);
  if (!list.length) throw new Error('百度分享内没有文件（errno ' + en + (res.errmsg ? ': ' + res.errmsg : '') + '）（shorturl=' + apiShorturl + '）');
  return { list, uk, shareid, seckey };
}

// 令牌：tplconfig 取 sign/timestamp（失败不致命）。r27 镜像：带 diag 诊断标签
async function baiduGetSign(apiShorturl) {
  let res;
  try {
    res = await fetchJson('https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&surl=' + encodeURIComponent(apiShorturl), {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
  } catch (e) {
    return { sign: '', timestamp: '', diag: 'network: ' + String((e && e.message) || e).slice(0, 140) };
  }
  const d = (res && res.data) || {};
  const sign = d.sign != null ? String(d.sign) : '';
  const timestamp = d.timestamp != null ? String(d.timestamp) : '';
  let diag = 'ok';
  if (!sign || !timestamp) {
    const en = (typeof res.errno !== 'undefined') ? Number(res.errno) : '?';
    diag = 'no_sign_in_data(errno:' + en + ')';
  }
  return { sign, timestamp, diag };
}

// r20 镜像：登录态取 bdstoken（GET /api/gettemplatevariable），匿名返回 ''
async function baiduGetBdstoken() {
  try {
    const bd = await fetchJson('https://pan.baidu.com/api/gettemplatevariable?fields=' + encodeURIComponent('["bdstoken"]'), {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://pan.baidu.com/disk/home' },
    });
    if (bd && bd.errno === 0 && bd.result && bd.result.bdstoken) return String(bd.result.bdstoken);
    return '';
  } catch (_) { return ''; }
}

// 提取码验证：先 /share/verify 拿 randsk（BDCLND）并桥接进 cookie jar，否则 sharedownload 报 errno 9019
async function baiduVerifySetCookie(shareid, uk, pwd, sign, timestamp) {
  const signTs = (sign && timestamp)
    ? '&sign=' + encodeURIComponent(sign) + '&timestamp=' + encodeURIComponent(timestamp)
    : '';
  try {
    const v = await fetchJson('https://pan.baidu.com/share/verify?shareid=' + shareid + '&uk=' + uk + signTs + '&web=1', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: 'pwd=' + encodeURIComponent(pwd || ''),
    });
    const ven = (v && typeof v.errno !== 'undefined') ? Number(v.errno) : '';
    if (ven !== '' && ven !== 0) return '';
    let randsk = (v && v.randsk) ? String(v.randsk) : '';
    if (randsk) {
      try { randsk = decodeURIComponent(randsk); } catch (_) { /* 已解码则原样 */ }
      try {
        if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.set) {
          await new Promise((res) => {
            chrome.cookies.set({ url: 'https://pan.baidu.com', name: 'BDCLND', value: randsk, path: '/', secure: true }, () => res());
          });
        }
      } catch (_) {}
      await ensureBaiduAuthHeaders();
    }
    return randsk;
  } catch (_) {
    return '';
  }
}

// 提取 surl 与 apiShorturl 形态（与 background.js resolveBaidu 一致）
function parseBaiduSurl(url) {
  const u = new URL(url);
  let surl = (u.searchParams.get('surl') || '').trim();
  let apiShorturl = '';
  if (surl) {
    apiShorturl = '1' + surl;          // ?surl= 旧链：1 前缀
  } else {
    const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m) { surl = m[1]; apiShorturl = surl; }
    else {
      const m2 = url.match(/\/e\/([A-Za-z0-9_-]+)/);
      if (m2) { surl = m2[1]; apiShorturl = surl; }
    }
  }
  return { surl, apiShorturl };
}

async function resolveBaidu(url, pwd) {
  await ensureBaiduAuthHeaders();
  let cookie = await getCookieString('https://pan.baidu.com');
  if (!/BDUSS=/.test(cookie)) throw new Error('未检测到百度网盘登录态(BDUSS)，请先在浏览器登录');
  const u = new URL(url);
  const { surl, apiShorturl } = parseBaiduSurl(url);
  if (!surl) throw new Error('无法从链接提取 surl（请使用 pan.baidu.com 的分享链接）');
  pwd = (pwd || '').trim() || (u.searchParams.get('pwd') || '').trim() || '';
  const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

  const topList = await baiduWxList(apiShorturl, pwd);
  const list = topList.list;
  const uk = topList.uk;
  const shareid = topList.shareid;
  const sekey = topList.seckey ? safeDecode(topList.seckey) : '';
  let { sign, timestamp, diag: signDiag } = await baiduGetSign(apiShorturl);
  // r20 镜像：登录态取 bdstoken，sharedownload 带上可降低 errno -20 风控
  const bdstoken = await baiduGetBdstoken();

  const out = [];
  let triedVerify = false;
  let retriedSign = false; // r27 镜像：errno 2（sign/timestamp 缺失）时自愈重取 tplconfig 一次
  let triedNolimit = false; // r30 镜像：跳端下载/-20 时 clienttype=12 + type=nolimit 兜底
  let nolimitDiag = ''; // r30 镜像：兜底结果诊断
  let lastRandsk = '';
  const MAX_DEPTH = 5;

  async function expandBaiduItems(items, dirPath, depth) {
    if (!items || !items.length) return;
    if (depth > MAX_DEPTH) {
      throw new Error('百度分享嵌套层级超过 ' + MAX_DEPTH + '（疑似循环引用，请用浏览器打开该分享核对）');
    }
    for (const f of items) {
      const isFolder = (f.type === 'folder') || (f.isdir === 1) || (f.isdir === '1') || (f.type === 1) || (f.type === '1');
      if (isFolder) {
        const subPath = (typeof f.path === 'string' && f.path) ? f.path : (dirPath + '/' + (f.server_filename || f.filename || ''));
        const sub = await baiduWxList(apiShorturl, pwd, subPath);
        await expandBaiduItems(sub.list, subPath, depth + 1);
        continue;
      }
      let dlink = '';
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const curSekey = attempt === 0 ? sekey : (lastRandsk || sekey);
        const extra = JSON.stringify({ sekey: curSekey });
        const body = 'encrypt=0'
          + '&product=share'
          + '&primaryid=' + shareid
          + '&shareid=' + shareid
          + '&uk=' + uk
          + '&fid_list=' + encodeURIComponent(JSON.stringify([Number(f.fs_id)]))
          + (curSekey ? '&extra=' + encodeURIComponent(extra) : '');
        const dlUrl = 'https://pan.baidu.com/api/sharedownload?channel=chunlei&clienttype=0&app_id=250528'
          + (sign ? '&sign=' + encodeURIComponent(sign) : '')
          + (timestamp ? '&timestamp=' + encodeURIComponent(timestamp) : '')
          + (bdstoken ? '&bdstoken=' + encodeURIComponent(bdstoken) : '')
          + '&web=1';
        let sd;
        try {
          sd = await fetchJson(dlUrl, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
              'Referer': 'https://pan.baidu.com/share/link?shareid=' + shareid + '&uk=' + uk,
            },
            body,
          });
        } catch (e) {
          throw new Error('百度 api/sharedownload 请求失败（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）：' + e.message);
        }
        const en = (typeof sd.errno !== 'undefined') ? Number(sd.errno) : '';
        // r27 镜像自愈：errno 2 = sign/timestamp 缺失（tplconfig 偶发失败）。重取一次令牌再试
        if (en === 2 && !retriedSign && (!sign || !timestamp)) {
          retriedSign = true;
          const again = await baiduGetSign(apiShorturl);
          sign = again.sign;
          timestamp = again.timestamp;
          signDiag = again.diag || signDiag;
          continue; // 用同样的 sekey + 新 sign/timestamp 重试
        }
        if (en === 9019 && !triedVerify) {
          triedVerify = true;
          const randsk = await baiduVerifySetCookie(shareid, uk, pwd, sign, timestamp);
          if (randsk) {
            lastRandsk = randsk;
            const newCookie = await getCookieString('https://pan.baidu.com');
            if (newCookie) cookie = newCookie;
          }
          continue;
        }
        // r33 镜像：跳端下载/-20 → clienttype=12 + type=nolimit 多令牌循环兜底（baiduwp-php 流派）
        // r32 实测 [token=jar] 仍 9019 根因：jar 里的 BDCLND 是 URL 编码形态，必须先 decodeURIComponent；
        // 跳端路径主流程 verify 从未执行 → randsk 惰性补调。候选：jar(解码) > randsk > seckey，解码后去重。
        const jumpNow = (en === 0) && (typeof sd.list === 'string' && sd.list.length > 0);
        let nolimitOk = false; // r33 镜像：候选任一成功即置位，用于退出 attempt 循环
        if ((jumpNow || en === -20) && !triedNolimit) {
          triedNolimit = true;
          const stripBdclnd = (c) => c ? c.replace(/(^|;\s*)BDCLND=[^;]*/g, '').replace(/^;+|;+$/g, '') : '';
          const mBdclnd = cookie && cookie.match(/(?:^|;\s*)BDCLND=([^;]+)/);
          const cands = [];
          if (mBdclnd) cands.push({ tok: safeDecode(mBdclnd[1]), src: 'jar' });
          if (!lastRandsk) {
            const rk = await baiduVerifySetCookie(shareid, uk, pwd, sign, timestamp); // 跳端路径 verify 未跑过，惰性补调
            if (rk) { lastRandsk = rk; cands.push({ tok: rk, src: 'verify-randsk' }); }
          } else {
            cands.push({ tok: lastRandsk, src: 'verify-randsk' });
          }
          if (sekey) cands.push({ tok: sekey, src: 'wxlist-seckey' }); // sekey 在提取时已 safeDecode，勿二次解码
          const seenTok = new Set();
          const uniq = cands.filter((c) => { if (!c.tok || seenTok.has(c.tok)) return false; seenTok.add(c.tok); return true; });
          if (uniq.length === 0) {
            nolimitDiag = 'no_bdclnd(无jar/randsk/seckey)';
          } else {
            const fails = [];
            for (const cand of uniq) {
              try {
                const baseCk = stripBdclnd(cookie);
                cookie = baseCk ? (baseCk + '; BDCLND=' + cand.tok) : ('BDCLND=' + cand.tok);
                await ensureBaiduAuthHeaders(cookie);
                const nl = await fetchJson('https://pan.baidu.com/api/sharedownload?app_id=250528&channel=chunlei&clienttype=12&sign=' + encodeURIComponent(sign) + '&timestamp=' + encodeURIComponent(timestamp) + '&web=1', {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // r32 镜像：去掉 X-Requested-With，对齐 baiduwp-php
                    'Referer': 'https://pan.baidu.com/disk/home',
                  },
                  body: 'encrypt=0'
                    + '&extra=' + encodeURIComponent(JSON.stringify({ sekey: cand.tok }))
                    + '&fid_list=[' + Number(f.fs_id) + ']'
                    + '&primaryid=' + shareid
                    + '&uk=' + uk
                    + '&product=share&type=nolimit',
                });
                const nl0 = Array.isArray(nl.list) ? nl.list[0] : null;
                const ndl = nl0 && nl0.dlink;
                if (ndl) {
                  dlink = /^https?:\/\//i.test(ndl) ? ndl : 'https://d.pcs.baidu.com' + (ndl.startsWith('/') ? ndl : '/' + ndl);
                  nolimitDiag = 'ok';
                  nolimitOk = true;
                  break;
                }
                const nen = (typeof nl.errno !== 'undefined') ? Number(nl.errno) : '?';
                fails.push('errno:' + nen + ((nl.show_msg || nl.errmsg) ? '(' + (nl.show_msg || nl.errmsg) + ')' : '') + '[token=' + cand.src + ']');
              } catch (e) {
                fails.push('network: ' + String((e && e.message) || e).slice(0, 120) + '[token=' + cand.src + ']');
              }
            }
            if (nolimitDiag !== 'ok') nolimitDiag = fails.join('|') || 'no_candidate_token';
          }
        }
        if (nolimitOk) break; // r33 镜像：nolimit 兜底拿到 dlink，退出 attempt 循环
        const dl = sd.list && sd.list[0] && sd.list[0].dlink;
        if (dl) {
          if (/^https?:\/\//i.test(dl)) {
            dlink = dl;
          } else {
            dlink = 'https://d.pcs.baidu.com' + (dl.startsWith('/') ? dl : '/' + dl);
          }
          break;
        }
        // 与 background.js resolveBaidu 镜像：show_msg 前置 + errno -20 风控引导 + r21 跳端下载识别
        const serverMsg = sd.show_msg || sd.errmsg || '';
        const enPart = (typeof en !== 'undefined' && en !== '') ? ('errno ' + en) : '无 errno';
        const isJumpToClient = (en === 0) && (typeof sd.list === 'string' && sd.list.length > 0);
        // r27 镜像：errno 2 = sign/timestamp 缺失，附 tplconfig 诊断标签
        const en2diag = (en === 2)
          ? '（诊断：sign=' + (sign ? '有' : '无') + ', timestamp=' + (timestamp ? '有' : '无') + ', tplconfig=' + signDiag + '）'
          : '';
        const hint = isJumpToClient
          ? '（百度限制该文件在网页端直接下载（返回 list:string 跳端下载指令，官方要求跳转 PC 客户端）。建议：换一个分享链接；或直接在浏览器打开该分享并用百度网盘客户端下载）'
            + (nolimitDiag ? '（nolimit兜底: ' + nolimitDiag + '）' : '')
          : ((en === -20)
            ? '（百度判定触发风控/验证码。建议：若已登录百度网盘账号会显著降低风控；未登录请先在浏览器手动打开一次该分享链接并按提示完成验证，等几分钟后回 LeleDownload 再解析）'
              + (nolimitDiag ? '（nolimit兜底: ' + nolimitDiag + '）' : '')
            : '');
        if (en !== 9019) {
          throw new Error(
            '百度接口提示：' + (serverMsg || (isJumpToClient ? '该文件被限制网页端直接下载' : '未返回 dlink')) +
            '（' + enPart + '）（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）' +
            hint + en2diag + '。原始响应：' + JSON.stringify(sd).slice(0, 200)
          );
        }
      }
      if (!dlink) {
        throw new Error('百度未返回 dlink（' + (lastErr || '未知错误') + '）（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）');
      }
      out.push({
        name: (depth > 0 && dirPath ? dirPath + '/' : '') + f.server_filename,
        size: bytesToSize(f.size),
        url: dlink,
        headers: { 'User-Agent': BAIDU_UA, Referer: 'https://pan.baidu.com/', Cookie: cookie },
      });
    }
  }

  await expandBaiduItems(list, '', 0);
  return out;
}

// ===========================================================================
// 测试夹具：记录型 fetch mock
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
function wxlistBody(surl, pwd) {
  return 'shorturl=' + encodeURIComponent(surl) + '&dir=&root=1&pwd=' + encodeURIComponent(pwd || '') + '&page=1&num=1000&order=time';
}

// ---------------------------------------------------------------------------
// T1: baiduWxList 正确 URL/body/credentials，返回 {list,uk,shareid,seckey}
// ---------------------------------------------------------------------------
test('baiduWxList 请求 wxlist 端点并正确拼 body，返回 list/uk/shareid/seckey', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const r = await baiduWxList('1ip_a56KjUknFNYLI22KVpA', '1234');
  assert.equal(r.uk, '110');
  assert.equal(r.shareid, '283');
  assert.equal(r.seckey, 'SEK');
  assert.equal(r.list.length, 1);
  const c = findCall(rec.calls, 'share/wxlist');
  assert.ok(c, '应请求 /share/wxlist');
  assert.ok(c.url.includes('channel=weixin') && c.url.includes('clienttype=25') && c.url.includes('version=2.2.2'), 'wxlist URL 必须含 channel=weixin&clienttype=25&version=2.2.2');
  assert.equal(c.body, wxlistBody('1ip_a56KjUknFNYLI22KVpA', '1234'), 'wxlist body 必须含 shorturl/dir/root/pwd/page/num/order');
  assert.equal(c.opts.credentials, 'include', 'wxlist 必须带 credentials:include');
});

// ---------------------------------------------------------------------------
// T2: wxlist errno 2 → 链接失效
// ---------------------------------------------------------------------------
test('baiduWxList errno 2 抛「链接无效或已失效」', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 2 }), ok: true };
    throw new Error('unexpected ' + u);
  };
  await assert.rejects(() => baiduWxList('1abc', ''), /链接无效或已失效（errno 2）/);
});

// ---------------------------------------------------------------------------
// T3: wxlist errno -9 → 提取码错误
// ---------------------------------------------------------------------------
test('baiduWxList errno -9 抛「提取码错误」', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: -9, errmsg: '密码错误' }), ok: true };
    throw new Error('unexpected ' + u);
  };
  await assert.rejects(() => baiduWxList('1abc', 'bad'), /提取码错误（errno -9/);
});

// ---------------------------------------------------------------------------
// T4: /s/ 与 /e/ 短链 → apiShorturl 为 bare（不加 1 前缀）；?surl= 旧链 → 1 前缀
// ---------------------------------------------------------------------------
test('wxlist 的 shorturl 形态：/s/、/e/ 用 bare，?surl= 用 1 前缀', async () => {
  const seen = [];
  globalThis.fetch = async (u, opts) => {
    const s = String(u);
    if (s.includes('share/wxlist')) {
      const m = (opts.body || '').match(/shorturl=([^&]+)/);
      seen.push(decodeURIComponent(m[1]));
      return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: '', list: [{ fs_id: 1, server_filename: 'a', size: 1 }] } }), ok: true };
    }
    throw new Error('unexpected ' + u);
  };
  await baiduWxList('ip_a56KjUknFNYLI22KVpA', '');   // 模拟 /s/ 已转成 bare
  assert.equal(seen[0], 'ip_a56KjUknFNYLI22KVpA', '/s/ 用 bare shorturl');
  await baiduWxList('1abcDEF', '');
  assert.equal(seen[1], '1abcDEF', 'bare 形态原样传入');
});

// ---------------------------------------------------------------------------
// T5: resolveBaidu 对 ?surl= 旧链，wxlist 用 1 前缀 surl
// ---------------------------------------------------------------------------
test('resolveBaidu ?surl= 旧链 → wxlist shorturl 为 1 前缀', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: '', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  await resolveBaidu('https://pan.baidu.com/share/init?surl=YuZkVISgaH_6xSLGxqoLfw&pwd=h7bq', '');
  const wx = findCall(rec.calls, 'share/wxlist');
  assert.ok(wx.body.includes('shorturl=' + encodeURIComponent('1YuZkVISgaH_6xSLGxqoLfw')), '?surl= 链 wxlist 必须 1 前缀，实际: ' + wx.body);
});

// ---------------------------------------------------------------------------
// T6: baiduGetSign 请求 tplconfig 正确 URL（含 surl + app_id=250528），返回 sign/timestamp
// ---------------------------------------------------------------------------
test('baiduGetSign 请求 tplconfig 返回 sign/timestamp', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const r = await baiduGetSign('1ip_a56KjUknFNYLI22KVpA');
  assert.equal(r.sign, 'SIGNVAL');
  assert.equal(r.timestamp, '1700000000');
  const c = findCall(rec.calls, 'share/tplconfig');
  assert.ok(c.url.includes('fields=sign,timestamp') && c.url.includes('app_id=250528') && c.url.includes('surl=1ip_a56KjUknFNYLI22KVpA'), 'tplconfig URL 必须含 fields/app_id/surl，实际: ' + c.url);
  assert.equal(c.opts.credentials, 'include', 'tplconfig 必须带 credentials:include');
});

// ---------------------------------------------------------------------------
// T7: baiduGetSign 失败时非致命（返回空），不影响后续 sharedownload
// ---------------------------------------------------------------------------
test('baiduGetSign 请求失败非致命，返回空 sign/timestamp（r27：另带 diag 诊断）', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('share/tplconfig')) return { text: async () => '<html>500</html>', ok: false, status: 500 };
    throw new Error('unexpected ' + u);
  };
  const r = await baiduGetSign('1abc');
  assert.equal(r.sign, '');
  assert.equal(r.timestamp, '');
  assert.ok(String(r.diag).startsWith('network: '), '失败必须带 network 诊断，实际: ' + r.diag);
});

// ---------------------------------------------------------------------------
// T8: baiduVerifySetCookie 成功 → 解码 randsk、桥接 BDCLND 进 cookie、刷新 DNR、返回解码值
// ---------------------------------------------------------------------------
test('baiduVerifySetCookie 成功：解码 randsk、chrome.cookies.set BDCLND、调用 DNR，返回解码 randsk', async () => {
  let setCookie = null;
  let dnrCalled = false;
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/verify')) return { text: async () => JSON.stringify({ errno: 0, randsk: 'RAND%2BVAL' }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  globalThis.chrome = {
    cookies: { set: (o, cb) => { setCookie = o; cb && cb(); } },
    declarativeNetRequest: { updateSessionRules: async () => { dnrCalled = true; } },
    runtime: {},
  };
  try {
    const r = await baiduVerifySetCookie('283', '110', '1234', 'SIGN', '1700000000');
    assert.equal(r, 'RAND+VAL', 'randsk 应被 decodeURIComponent 解码，实际: ' + r);
    assert.ok(setCookie, '应调用 chrome.cookies.set');
    assert.equal(setCookie.name, 'BDCLND');
    assert.equal(setCookie.value, 'RAND+VAL');
    assert.ok(dnrCalled, '应调用 ensureBaiduAuthHeaders（DNR）刷新注入头');
    const vc = findCall(rec.calls, 'share/verify');
    assert.ok(vc, '应发起 /share/verify');
    assert.ok(vc.url.includes('shareid=283') && vc.url.includes('uk=110') && vc.url.includes('sign=SIGN'), 'verify URL 应带 shareid/uk/sign，实际: ' + vc.url);
    assert.ok(vc.body.includes('pwd=1234'), 'verify body 应携带提取码，实际: ' + vc.body);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// T9: baiduVerifySetCookie 返回 errno -9 → 返回空（不抛错，交给 sharedownload 阶段诊断）
// ---------------------------------------------------------------------------
test('baiduVerifySetCookie verify 返回 errno -9 时返回空串（不抛错）', async () => {
  globalThis.fetch = async (u) => {
    if (String(u).includes('share/verify')) return { text: async () => JSON.stringify({ errno: -9, errmsg: '提取码错误' }), ok: true };
    throw new Error('unexpected ' + u);
  };
  const r = await baiduVerifySetCookie('283', '110', 'bad', 'SIGN', '170');
  assert.equal(r, '', 'verify 失败应返回空串');
});

// ---------------------------------------------------------------------------
// T10: resolveBaidu 公开 /s/ 分享全链路：wxlist → sharedownload（正确 params/body/Referer）
// ---------------------------------------------------------------------------
test('resolveBaidu /s/ 公开分享：sharedownload 参数对齐可工作参考实现', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGN', timestamp: '1700000000' } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const out = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'a.txt');
  assert.equal(out[0].url, 'https://d.pcs.baidu.com/dl/a.txt');
  // URL 参数
  const sd = findCall(rec.calls, 'api/sharedownload');
  assert.ok(sd.url.includes('channel=chunlei') && sd.url.includes('clienttype=0') && sd.url.includes('app_id=250528') && sd.url.includes('web=1'), 'sharedownload URL 必须含 channel=chunlei&clienttype=0&app_id=250528&web=1');
  assert.ok(sd.url.includes('sign=SIGN') && sd.url.includes('timestamp=1700000000'), 'sharedownload URL 应带 tplconfig 的 sign/timestamp');
  // body 参数
  const b = sd.body;
  assert.ok(b.includes('encrypt=0') && b.includes('product=share'), 'body 必须含 encrypt=0&product=share');
  assert.ok(b.includes('primaryid=283') && b.includes('shareid=283') && b.includes('uk=110'), 'body 必须含 primaryid/shareid/uk');
  assert.ok(b.includes('fid_list=' + encodeURIComponent(JSON.stringify([42]))), 'body fid_list 应为 [fs_id] 紧凑 JSON');
  assert.ok(b.includes('extra='), 'body 应带 extra（sekey 来自 wxlist seckey）');
  assert.ok(decodeURIComponent(b).includes('"sekey":"SEK"'), 'extra 内 sekey 应为 wxlist 返回的 seckey（已解码形态）');
  // Referer 头
  assert.equal(sd.opts.headers['Referer'], 'https://pan.baidu.com/share/link?shareid=283&uk=110', 'sharedownload Referer 必须为 share/link?shareid=&uk=');
  assert.equal(sd.opts.credentials, 'include', 'sharedownload 必须带 credentials:include');
  // 回传 headers 含 BDUSS/Referer/UA
  assert.ok(/BDUSS=/.test(out[0].headers.Cookie), '回传 headers 必须含 BDUSS');
  assert.equal(out[0].headers.Referer, 'https://pan.baidu.com/');
  assert.ok(out[0].headers['User-Agent'].includes('Chrome/'), '回传 UA 必须含 Chrome/');
});

// ---------------------------------------------------------------------------
// T11: resolveBaidu 未登录（cookie 无 BDUSS）→ 明确错误且不发任何请求
// ---------------------------------------------------------------------------
test('resolveBaidu 未检测到 BDUSS 时抛登录态错误且不发请求', async () => {
  mockCookie = 'STOKEN=xyz789';
  const rec = makeRecorder();
  rec._handler = () => { throw new Error('不应被调用'); };
  globalThis.fetch = rec;
  await assert.rejects(() => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''), /未检测到百度网盘登录态\(BDUSS\)/);
  assert.equal(rec.calls.length, 0, '未登录时不应发起任何网络请求');
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
});

// ---------------------------------------------------------------------------
// T12: resolveBaidu errno 9019 → 补 /share/verify 取 randsk 桥接后用 randsk 作 sekey 重试成功
// ---------------------------------------------------------------------------
test('resolveBaidu errno 9019：补 verify 取 randsk 桥接后用 randsk 作 sekey 重试拿到 dlink', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  let dnrCalled = false;
  let setCookie = null;
  globalThis.chrome = {
    cookies: { set: (o, cb) => { setCookie = o; cb && cb(); } },
    declarativeNetRequest: { updateSessionRules: async () => { dnrCalled = true; } },
    runtime: {},
  };
  let sdCount = 0;
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGN', timestamp: '1700000000' } }), ok: true };
    if (u.includes('share/verify')) return { text: async () => JSON.stringify({ errno: 0, randsk: 'RANDVAL' }), ok: true };
    if (u.includes('api/sharedownload')) {
      sdCount++;
      if (sdCount === 1) return { text: async () => JSON.stringify({ errno: 9019, errmsg: 'needverify' }), ok: true };
      return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    }
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  try {
    const out = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '');
    assert.equal(out.length, 1, '9019 重试后应解析出 1 个文件');
    const verifyCall = findCall(rec.calls, 'share/verify');
    assert.ok(verifyCall, '9019 后应调用 /share/verify');
    assert.ok(setCookie && setCookie.name === 'BDCLND' && setCookie.value === 'RANDVAL', 'verify 后应桥接 BDCLND=RANDVAL 进 cookie');
    assert.ok(dnrCalled, 'verify 后应刷新 DNR 注入头');
    // 第二次 sharedownload（重试）的 sekey 应为 randsk RANDVAL
    const sdCalls = rec.calls.filter((c) => c.url.includes('api/sharedownload'));
    assert.equal(sdCalls.length, 2, '应发起两次 sharedownload（首失败 + 重试）');
    assert.ok(decodeURIComponent(sdCalls[1].body).includes('"sekey":"RANDVAL"'), '重试的 sekey 应为 randsk RANDVAL，实际: ' + sdCalls[1].body);
  } finally {
    delete globalThis.chrome;
    mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  }
});

// ---------------------------------------------------------------------------
// T13: resolveBaidu sharedownload 返回非 9019 错误 errno → 抛出「未返回 dlink」带 errno
// ---------------------------------------------------------------------------
test('resolveBaidu sharedownload 返回 errno -20 时抛「百度接口提示」+ show_msg/errmsg 突出 + 风控引导', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: '', list: [{ fs_id: 42, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: {} }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: -20, errmsg: 'file unavailable', show_msg: '验证码输入错误，请重试' }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  await assert.rejects(
    () => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''),
    /百度接口提示：验证码输入错误，请重试（errno -20）（uk=110, shareid=283, fs_id=42）.*风控.*原始响应/
  );
});

// ---------------------------------------------------------------------------
// T14: resolveBaidu 链接里带 &pwd= 时，调用方 pwd 为空也能从 URL 兜底（复现真实粘贴场景）
// ---------------------------------------------------------------------------
test('resolveBaidu 调用方 pwd 为空时从 URL &pwd= 兜底传给 wxlist', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: '', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10 }] } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA?pwd=1234', '');
  const wx = findCall(rec.calls, 'share/wxlist');
  assert.ok(wx.body.includes('pwd=1234'), 'wxlist body 应从 URL 兜底携带 pwd，实际: ' + wx.body);
});

test('resolveBaidu sharedownload 返回的 dlink 是相对路径时自动拼 https://d.pcs.baidu.com 前缀', async () => {
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'sk', list: [{ fs_id: 1, server_filename: 'book.pdf', size: 1024 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: '/rest/2.0/pcs/file?access_token=xxx&path=%2Fbook.pdf' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '1234');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'book.pdf');
  assert.equal(files[0].url, 'https://d.pcs.baidu.com/rest/2.0/pcs/file?access_token=xxx&path=%2Fbook.pdf', '相对路径 dlink 应被拼上完整主机名');
});

test('resolveBaidu sharedownload 返回的 dlink 是不带前导 / 的相对路径时也正确拼接', async () => {
  mockCookie = 'BDUSS=abc; STOKEN=xyz';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [{ fs_id: 1, server_filename: 'a', size: 1 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'rest/2.0/pcs/file?x=1' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/abc', 'p');
  assert.equal(files[0].url, 'https://d.pcs.baidu.com/rest/2.0/pcs/file?x=1', '无前导 / 的相对路径也应被正确拼接');
});

test('resolveBaidu sharedownload 返回的 dlink 是绝对 URL 时原样保留（不重复拼接主机）', async () => {
  mockCookie = 'BDUSS=abc; STOKEN=xyz';
  const rec = makeRecorder();
  rec._handler = (u) => {
    if (u.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [{ fs_id: 1, server_filename: 'a', size: 1 }] } }), ok: true };
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/rest/2.0/pcs/file?x=1' }] }), ok: true };
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/abc', 'p');
  assert.equal(files[0].url, 'https://d.pcs.baidu.com/rest/2.0/pcs/file?x=1', '绝对 URL dlink 应原样保留');
});

// ---------------------------------------------------------------------------
// T15: 顶层 wxlist 返回 folder（type='folder'）→ 递归展开子项为多个文件
//      复现用户截图：分享是「书荒来看 (1)」单层文件夹，里面有 N 个文件
// ---------------------------------------------------------------------------
test('resolveBaidu 顶层含 folder 时自动递归展开子文件（type="folder" 形态）', async () => {
  mockCookie = 'BDUSS=abc; STOKEN=xyz';
  const rec = makeRecorder();
  rec._handler = (u, opts) => {
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('share/wxlist')) {
      const body = String((opts && opts.body) || '');
      // 必须用 '&' 做边界：dir=%2FA 也匹配 dir=%2FA%2FB 会导致误命中无限递归
      if (body.includes('dir=' + encodeURIComponent('/书荒来看') + '&')) {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
          { fs_id: 100, server_filename: 'chapter1.txt', size: 1024 },
          { fs_id: 101, server_filename: 'chapter2.txt', size: 2048 },
        ] } }), ok: true };
      }
      return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
        { fs_id: 99, type: 'folder', server_filename: '书荒来看', path: '/书荒来看', size: 0 },
      ] } }), ok: true };
    }
    if (u.includes('api/sharedownload')) {
      // 解析请求体中的 fs_id 给出对应 dlink
      const m = String((opts && opts.body) || '').match(/fid_list=\[(\d+)\]/);
      const fid = m ? Number(m[1]) : 0;
      return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/' + fid + '.bin' }] }), ok: true };
    }
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '1234');
  assert.equal(files.length, 2, 'folder 应被递归展开为 2 个子文件，原 folder 项本身不再出现');
  // 顶层文件不被 0B 误导：folder 项消失，子文件正确出现
  assert.ok(!files.some(f => f.name === '书荒来看'), 'folder 自身不应出现在结果中');
  // 文件名应含父目录前缀，方便用户在 UI 区分来源
  assert.equal(files[0].name, '/书荒来看/chapter1.txt');
  assert.equal(files[1].name, '/书荒来看/chapter2.txt');
  assert.equal(files[0].size, '1.00 KB');
  assert.equal(files[1].size, '2.00 KB');
  // 验证 wxlist 被调用了 2 次（根 + folder 子层）
  const wxlistCalls = rec.calls.filter(c => c.url.includes('share/wxlist'));
  assert.equal(wxlistCalls.length, 2, '应触发根 wxlist + folder 子层 wxlist 共 2 次');
  // 第二次 wxlist 请求体的 dir 参数应带 folder 路径
  const subWx = wxlistCalls.find(c => c.body.includes('dir=' + encodeURIComponent('/书荒来看')));
  assert.ok(subWx, '第二次 wxlist body 应带 dir=/书荒来看，实际: ' + subWx.body);
});

// ---------------------------------------------------------------------------
// T16: 顶层 wxlist 返回 folder（isdir=1 形态）→ 也应被识别为 folder 并递归
// ---------------------------------------------------------------------------
test('resolveBaidu 顶层含 folder（isdir=1 形态）也递归展开', async () => {
  mockCookie = 'BDUSS=abc; STOKEN=xyz';
  const rec = makeRecorder();
  rec._handler = (u, opts) => {
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('share/wxlist')) {
      const body = String((opts && opts.body) || '');
      if (body.includes('dir=' + encodeURIComponent('/F') + '&')) {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
          { fs_id: 200, server_filename: 'only.txt', size: 512 },
        ] } }), ok: true };
      }
      return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
        { fs_id: 1, isdir: 1, server_filename: 'F', path: '/F', size: 0 },
      ] } }), ok: true };
    }
    if (u.includes('api/sharedownload')) {
      return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/200' }] }), ok: true };
    }
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/abc', 'p');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '/F/only.txt', 'isdir=1 的 folder 也应被识别并展开');
});

// ---------------------------------------------------------------------------
// T17: 嵌套 folder（A/B/）→ 多层递归，每层 wxlist 一次，最内层 file 平铺
// ---------------------------------------------------------------------------
test('resolveBaidu 嵌套 folder（A→B→file）多层递归展开', async () => {
  mockCookie = 'BDUSS=abc; STOKEN=xyz';
  const rec = makeRecorder();
  rec._handler = (u, opts) => {
    if (u.includes('share/tplconfig')) return { text: async () => JSON.stringify({ errno: 0, data: { sign: 's', timestamp: 't' } }), ok: true };
    if (u.includes('share/wxlist')) {
      const body = String((opts && opts.body) || '');
      // 边界匹配：dir=%2FA 不能再匹配 dir=%2FA%2FB，否则会无限递归
      if (body.includes('dir=' + encodeURIComponent('/A') + '&') && !body.includes(encodeURIComponent('/A/B'))) {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
          { fs_id: 11, type: 'folder', server_filename: 'B', path: '/A/B', size: 0 },
        ] } }), ok: true };
      }
      if (body.includes('dir=' + encodeURIComponent('/A/B') + '&')) {
        return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
          { fs_id: 21, server_filename: 'leaf.txt', size: 100 },
        ] } }), ok: true };
      }
      // 根
      return { text: async () => JSON.stringify({ errno: 0, data: { uk: '1', shareid: '2', seckey: 'sk', list: [
        { fs_id: 10, type: 'folder', server_filename: 'A', path: '/A', size: 0 },
      ] } }), ok: true };
    }
    if (u.includes('api/sharedownload')) {
      return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/leaf' }] }), ok: true };
    }
    throw new Error('unexpected ' + u);
  };
  globalThis.fetch = rec;
  const files = await resolveBaidu('https://pan.baidu.com/s/abc', 'p');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '/A/B/leaf.txt', '多层 folder 应累积路径前缀');
  // 根 + /A + /A/B 共 3 次 wxlist
  const wxlistCalls = rec.calls.filter(c => c.url.includes('share/wxlist'));
  assert.equal(wxlistCalls.length, 3, '应触发根 + /A + /A/B 共 3 次 wxlist');
});

// T21: r20 bdstoken —— gettemplatevariable 返回 bdstoken 时 sharedownload URL 带 bdstoken 参数
test('resolveBaidu 登录态 bdstoken → sharedownload URL 带 bdstoken（r20）', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    const s = String(u);
    if (s.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10, isdir: 0 }] } }), ok: true };
    if (s.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGN', timestamp: '1700000000' } }), ok: true };
    if (s.includes('gettemplatevariable')) return { text: async () => JSON.stringify({ errno: 0, result: { bdstoken: 'BDTOKEN123' } }), ok: true };
    if (s.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    const out = await resolveBaidu('https://pan.baidu.com/share/init?surl=abc123&pwd=q7g4', '');
    assert.equal(out.length, 1);
    const sd = findCall(rec.calls, 'api/sharedownload');
    assert.ok(sd, '应发起 sharedownload');
    assert.ok(sd.url.includes('bdstoken=BDTOKEN123'), 'sharedownload URL 应带 bdstoken=BDTOKEN123，实际: ' + sd.url);
    // 未登录场景（gettemplatevariable errno -6）→ 不带 bdstoken
  } finally {
    delete globalThis.fetch;
  }
});

// T22: r20 未登录（gettemplatevariable errno -6）→ sharedownload URL 不带 bdstoken
test('resolveBaidu 未登录 → sharedownload 不带 bdstoken（r20）', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    const s = String(u);
    if (s.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10, isdir: 0 }] } }), ok: true };
    if (s.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGN', timestamp: '1700000000' } }), ok: true };
    if (s.includes('gettemplatevariable')) return { text: async () => JSON.stringify({ errno: -6, result: [] }), ok: true };
    if (s.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: [{ dlink: 'https://d.pcs.baidu.com/dl/a.txt' }] }), ok: true };
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    const out = await resolveBaidu('https://pan.baidu.com/share/init?surl=abc123&pwd=q7g4', '');
    assert.equal(out.length, 1);
    const sd = findCall(rec.calls, 'api/sharedownload');
    assert.ok(sd, '应发起 sharedownload');
    assert.ok(!sd.url.includes('bdstoken='), '未登录时 sharedownload 不应带 bdstoken，实际: ' + sd.url);
  } finally {
    delete globalThis.fetch;
  }
});

// T23: r21 errno 0 + list 字符串（跳端下载）→ 识别为「限制网页端直接下载」而非「未返回 dlink」
test('resolveBaidu errno 0 + list:string（跳端下载）→ 提示「限制网页端直接下载」（r21）', async () => {
  const rec = makeRecorder();
  rec._handler = (u) => {
    const s = String(u);
    if (s.includes('share/wxlist')) return { text: async () => JSON.stringify({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 1, server_filename: 'a.txt', size: 10, isdir: 0 }] } }), ok: true };
    if (s.includes('share/tplconfig')) return { text: async () => JSON.stringify({ data: { sign: 'SIGN', timestamp: '1700000000' } }), ok: true };
    if (s.includes('gettemplatevariable')) return { text: async () => JSON.stringify({ errno: -6, result: [] }), ok: true };
    if (s.includes('api/sharedownload')) return { text: async () => JSON.stringify({ errno: 0, list: 'lcLSYqsqWZI7U5baWnZpVcfhTS5b/XydTZ9yFNZkKrMvRKWu++' }), ok: true };
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    await assert.rejects(
      () => resolveBaidu('https://pan.baidu.com/share/init?surl=abc123&pwd=q7g4', ''),
      (err) => {
        const msg = String(err.message);
        return /该文件被限制网页端直接下载/.test(msg)
          && /跳端下载/.test(msg)
          && /PC 客户端/.test(msg)
          && !/未返回 dlink/.test(msg);
      }
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// r27: errno 2（sign/timestamp 缺失）自愈重试 + tplconfig 诊断标签
// 外部探针实测（2026-10-27）：sharedownload errno 2「请求失败」= sign 或 timestamp 缺失
// （任缺一个都报 2）；sign/timestamp 伪造 = 113；缺 extra = 118；errno 0 + list:string = 跳端下载。
// tplconfig 在 SW 偶发失败被静默吞掉 → sign 空 → sharedownload 必报 errno 2。
// ---------------------------------------------------------------------------
test('r27: tplconfig 首次失败 → sharedownload errno 2 → 重取 sign 自愈成功', async () => {
  let tplCalls = 0, sdCalls = 0;
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'a.txt', size: 10 }] } });
    if (s.includes('share/tplconfig')) {
      tplCalls++;
      if (tplCalls === 1) throw new Error('sw network hiccup');
      return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    }
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('api/sharedownload')) {
      sdCalls++;
      const hasSign = rec.calls.some((c) => c.url.includes('api/sharedownload') && c.url.includes('sign=SIGNVAL'));
      if (!hasSign) return json({ errno: 2, show_msg: '请求失败' });
      return json({ errno: 0, list: [{ dlink: '/rest/2.0/pcs/file?dlink=OK' }] });
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    const r = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '');
    assert.equal(tplCalls, 2, 'tplconfig 必须被重取一次，实际 ' + tplCalls);
    assert.equal(sdCalls, 2, 'sharedownload 必须重试一次，实际 ' + sdCalls);
    assert.ok(r[0].url.includes('d.pcs.baidu.com') && r[0].url.includes('dlink=OK'), '自愈后应拿到 dlink: ' + r[0].url);
  } finally {
    delete globalThis.fetch;
  }
});

test('r27: tplconfig 始终失败 → errno 2 错误信息携带 tplconfig 诊断标签', async () => {
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'a.txt', size: 10 }] } });
    if (s.includes('share/tplconfig')) throw new Error('[HTTP 502 Bad Gateway] tplconfig html');
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('api/sharedownload')) return json({ errno: 2, show_msg: '请求失败', request_id: 'r27' });
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    await assert.rejects(
      () => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''),
      (err) => {
        const msg = String(err.message);
        return /errno 2/.test(msg)
          && /请求失败/.test(msg)
          && /诊断：sign=无, timestamp=无, tplconfig=network: \[HTTP 502/.test(msg)
          && /原始响应/.test(msg);
      }
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// r30: 跳端下载（errno 0 + list:string）/-20（风控）→ clienttype=12 + type=nolimit 兜底
// baiduwp-php 流派（>50MB 大文件正解）。演进史：
//   r28 试 /api/download?origin=dlna —— 登录态实测 errno 113（tplconfig sign 对该端点无效），弃；
//   匿名探针：clienttype=12 报 9019（需 BDCLND/randsk）而非跳端 → 绕行 = verify 拿 randsk 再走 12 通道。
// ---------------------------------------------------------------------------
test('r30+r33: 跳端下载 → 惰性 verify 拿 randsk 作首个候选，seckey 次选，nolimit 成功拿到 dlink', async () => {
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s, opts) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'big.dmg', size: 5265524301 }] } });
    if (s.includes('share/tplconfig')) return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('share/verify')) return json({ errno: 0, randsk: 'RANDSK' });
    if (s.includes('api/sharedownload')) {
      if (s.includes('clienttype=12')) {
        const n = rec.calls.filter((x) => x.url.includes('clienttype=12')).length; // 含当前这次
        const hdrs = (opts && opts.headers) || {};
        assert.ok(!('X-Requested-With' in hdrs), 'nolimit 不应带 X-Requested-With');
        assert.ok(hdrs.Referer === 'https://pan.baidu.com/disk/home', 'nolimit Referer=disk/home');
        assert.ok(s.includes('sign=SIGNVAL') && s.includes('timestamp=1700000000'), 'nolimit URL 必须带 sign/timestamp: ' + s);
        assert.ok((opts.body || '').includes('type=nolimit'), 'nolimit body 必须带 type=nolimit');
        assert.ok((opts.body || '').includes('fid_list=[42]'), 'nolimit fid_list 必须为字面量 [42]');
        assert.ok((opts.body || '').includes('primaryid=283') && (opts.body || '').includes('uk=110'), 'nolimit body 必须带 primaryid/uk');
        if (n === 1) {
          // r33：跳端路径主流程 verify 未跑过 → 惰性补调，首个候选 = 解码后的 randsk
          assert.ok((opts.body || '').includes(encodeURIComponent('{"sekey":"RANDSK"}')), 'r33: 首个候选应为惰性 verify 的 randsk: ' + opts.body);
          return json({ errno: 9019, show_msg: 'needverify' });
        }
        assert.ok((opts.body || '').includes(encodeURIComponent('{"sekey":"SEK"}')), 'r33: 次候选应为 wxlist seckey: ' + opts.body);
        return json({ errno: 0, list: [{ dlink: '/rest/2.0/pcs/file?nolimit=OK' }] });
      }
      return json({ errno: 0, list: 'lcLSYqsqWZI7U5baWnZpVcfhTS5b/XydTZ9yFNZkKrMvRKWu++' }); // 首次：跳端下载
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    const r = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '');
    assert.ok(r[0].url.startsWith('https://d.pcs.baidu.com/') && r[0].url.includes('nolimit=OK'), 'nolimit 兜底应返回相对 dlink 并拼前缀: ' + r[0].url);
    const nlCalls = rec.calls.filter((x) => x.url.includes('clienttype=12'));
    assert.equal(nlCalls.length, 2, 'r33: 应按候选顺序尝试 2 个令牌');
    assert.ok(findCall(rec.calls, 'share/verify'), 'r33: 跳端路径应惰性补调 verify 拿 randsk');
  } finally {
    delete globalThis.fetch;
  }
});

test('r30: 跳端下载且 nolimit 兜底失败 → 错误信息带 nolimit 诊断标签', async () => {
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'big.dmg', size: 5265524301 }] } });
    if (s.includes('share/tplconfig')) return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('share/verify')) return json({ errno: 0, randsk: 'RANDSK' });
    if (s.includes('api/sharedownload')) {
      if (s.includes('clienttype=12')) return json({ errno: -6 });
      return json({ errno: 0, list: 'lcLSYqsqWZI7U5baWnZpVcfhTS5b/XydTZ9yFNZkKrMvRKWu++' });
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    await assert.rejects(
      () => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''),
      (err) => {
        const msg = String(err.message);
        return /该文件被限制网页端直接下载/.test(msg)
          && /跳端下载/.test(msg)
          && /（nolimit兜底: errno:-6[)\[]/.test(msg) // r32：diag 会追加 [token=xxx] 后缀
          && !/未返回 dlink/.test(msg);
      }
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// r30 续: errno -20（验证码/风控）同样走 clienttype=12 兜底
// （2026-10-27 用户实测 v26.10.27：登录态下 sharedownload 返回 -20）
// ---------------------------------------------------------------------------
test('r30: sharedownload -20 → clienttype=12 兜底成功拿到 dlink', async () => {
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'big.dmg', size: 5265524301 }] } });
    if (s.includes('share/tplconfig')) return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('share/verify')) return json({ errno: 0, randsk: 'RANDSK' });
    if (s.includes('api/sharedownload')) {
      if (s.includes('clienttype=12')) return json({ errno: 0, list: [{ dlink: '/rest/2.0/pcs/file?nolimit=OK' }] });
      return json({ errno: -20, show_msg: '验证码输入错误，请重试' });
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    const r = await resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', '');
    assert.ok(r[0].url.startsWith('https://d.pcs.baidu.com/') && r[0].url.includes('nolimit=OK'), '-20 应触发 nolimit 兜底并成功: ' + r[0].url);
  } finally {
    delete globalThis.fetch;
  }
});

test('r30: sharedownload -20 且 nolimit 兜底失败 → 风控提示带 nolimit 诊断标签', async () => {
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'big.dmg', size: 5265524301 }] } });
    if (s.includes('share/tplconfig')) return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('share/verify')) return json({ errno: 0, randsk: 'RANDSK' });
    if (s.includes('api/sharedownload')) {
      if (s.includes('clienttype=12')) return json({ errno: -6 });
      return json({ errno: -20, show_msg: '验证码输入错误，请重试' });
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    await assert.rejects(
      () => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''),
      (err) => {
        const msg = String(err.message);
        return /errno -20/.test(msg)
          && /风控/.test(msg)
          && /（nolimit兜底: errno:-6[)\[]/.test(msg) // r32：diag 会追加 [token=xxx] 后缀
          && /原始响应/.test(msg);
      }
    );
  } finally {
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// r33: jar BDCLND 是 URL 编码形态必须先解码；多令牌循环按序尝试（jar > randsk > seckey），
// 全部失败时 diag 按序列出各候选的失败原因。[token=src] 自证来源。
// 用户实测 r32 [token=jar] 仍 9019 → 根因 = jar 值未解码（服务器 Set-Cookie 为编码形态）。
// ---------------------------------------------------------------------------
test('r33: jar BDCLND 先解码再作 sekey，多令牌按序尝试，diag 依序列出各候选失败', async () => {
  const prevCookie = mockCookie;
  mockCookie = 'BDUSS=abc123deadbeef; STOKEN=xyz789; BDCLND=JAR%2AREALTOKEN'; // 编码形态（* → %2A）
  const rec = makeRecorder();
  const json = (o) => ({ text: async () => JSON.stringify(o), ok: true });
  rec._handler = (s, opts) => {
    if (s.includes('share/wxlist')) return json({ errno: 0, data: { uk: '110', shareid: '283', seckey: 'SEK', list: [{ fs_id: 42, server_filename: 'big.dmg', size: 5265524301 }] } });
    if (s.includes('share/tplconfig')) return json({ data: { sign: 'SIGNVAL', timestamp: '1700000000' } });
    if (s.includes('gettemplatevariable')) return json({ errno: -6, result: [] });
    if (s.includes('share/verify')) return json({ errno: 0, randsk: 'RANDSK' });
    if (s.includes('api/sharedownload')) {
      if (s.includes('clienttype=12')) {
        const n = rec.calls.filter((x) => x.url.includes('clienttype=12')).length; // 含当前这次
        const hdrs = (opts && opts.headers) || {};
        assert.ok(!('X-Requested-With' in hdrs), 'r33: nolimit 不应带 X-Requested-With');
        assert.ok(hdrs.Referer === 'https://pan.baidu.com/disk/home', 'r33: nolimit Referer=disk/home');
        if (n === 1) {
          // 首个候选 = jar BDCLND 解码后的明文（%2A → *）
          assert.ok((opts.body || '').includes(encodeURIComponent('{"sekey":"JAR*REALTOKEN"}')), 'r33: 首个候选必须是解码后的 jar BDCLND: ' + opts.body);
          assert.ok(!(opts.body || '').includes('JAR%2A'), 'r33: 不得把编码形态直接塞给 sekey: ' + opts.body);
        }
        return json({ errno: -6, show_msg: 'Invalid Bduss' });
      }
      return json({ errno: 0, list: 'lcLSYqsqWZI7U5baWnZpVcfhTS5b/XydTZ9yFNZkKrMvRKWu++' }); // 首次：跳端下载
    }
    throw new Error('unexpected ' + s);
  };
  globalThis.fetch = rec;
  try {
    await assert.rejects(
      () => resolveBaidu('https://pan.baidu.com/s/1ip_a56KjUknFNYLI22KVpA', ''),
      (err) => {
        const msg = String(err.message);
        const iJar = msg.indexOf('[token=jar]');
        const iRk = msg.indexOf('[token=verify-randsk]');
        const iSek = msg.indexOf('[token=wxlist-seckey]');
        return /（nolimit兜底: errno:-6\(Invalid Bduss\)\[token=jar\]/.test(msg) // 首个失败必须是 jar 候选
          && iJar > -1 && iRk > iJar && iSek > iRk // r33: 候选按序尝试，diag 依序记录
          && iSek === msg.lastIndexOf('[token=wxlist-seckey]');
      }
    );
    assert.ok(findCall(rec.calls, 'share/verify'), 'r33: jar 失败后应继续惰性补调 verify 取 randsk 候选');
  } finally {
    mockCookie = prevCookie;
    delete globalThis.fetch;
  }
});
