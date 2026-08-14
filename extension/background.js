// 乐乐下载器 - 浏览器扩展后台脚本
// 兼容 Chrome / Edge（Chromium）与 Firefox（MV3）。
// Firefox 同时支持 chrome.* 别名（callback 风格），因此统一用 chrome.* 命名空间即可。

// 守卫：吞掉未捕获的异常/ Promise 拒绝，避免 Service Worker 被标记 invalid 而整条接管链路瘫痪。
self.addEventListener('unhandledrejection', function (e) {
  console.error('[乐乐] SW unhandledrejection (已吞掉以防 invalid):', e && e.reason);
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
});
self.addEventListener('error', function (e) {
  console.error('[乐乐] SW error (已吞掉以防 invalid):', e && e.message);
});

const APP_BASE = 'http://127.0.0.1:45678';
const MENU_ID = 'lele_download';

// 自动接管开关（由 popup 设置，存于 chrome.storage.local.autoCapture）
let autoCapture = true;

function loadSettings() {
  try {
    chrome.storage.local.get(['autoCapture'], (res) => {
      if (typeof res.autoCapture === 'boolean') {
        autoCapture = res.autoCapture;
      }
    });
  } catch (_) { /* storage 不可用时保持默认 true */ }
}

// 兜底创建右键菜单：onInstalled 在某些 reload 场景下可能不触发，
// 在脚本顶层也调用一次，确保菜单始终存在。
function ensureMenu() {
  try {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '使用乐乐下载器下载',
      contexts: ['link', 'image', 'video', 'audio', 'page']
    }, () => {
      // 重复创建（id 已存在）会产生 lastError，属正常，忽略即可
      if (chrome.runtime.lastError) {
        console.log('[乐乐] 菜单已存在，跳过重建：', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.log('[乐乐] 创建菜单异常：', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu();
  chrome.storage.local.get(['autoCapture'], (res) => {
    if (typeof res.autoCapture !== 'boolean') {
      chrome.storage.local.set({ autoCapture: true });
      autoCapture = true;
    }
  });
});

// 设置变更时实时生效（popup 里开关切换无需重启扩展）
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoCapture) {
      autoCapture = !!changes.autoCapture.newValue;
      console.log('[乐乐] 自动接管开关 =>', autoCapture);
    }
  });
} catch (_) { /* 旧版浏览器忽略 */ }

// 探测 App 是否在线（先 ping /status，避免离线时误发或静默失败）
async function isAppOnline() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(APP_BASE + '/status', {
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);
    return response.ok;
  } catch (e) {
    console.log('[乐乐] App 在线探测失败：', e);
    return false;
  }
}

// 发送下载链接到桌面应用（返回是否成功）。
// headers 为可选：分享链接场景由 content-script 上报真实文件请求头（含 Cookie/Referer），
// 经此透传给 App 引擎带自定义头下载；旧路径（右键/onCreated/popup）不传 headers，行为完全不变。
async function sendToLeleDownload(url, headers) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const body = { url: url, timestamp: Date.now() };
    if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
      body.headers = headers;
    }
    const response = await fetch(APP_BASE + '/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);
    return response.ok;
  } catch (e) {
    console.log('[乐乐] 发送下载请求失败：', e);
    return false;
  }
}

// 处理 content-script 上报的「分享链接真实文件请求」：
// 汇聚 headers（Cookie 已在 content-script 并入）→ 下发 App；成功/失败给明确提示。
// 注意：此分支与原有 3 条触发路径（右键菜单 / downloads.onCreated / popup）完全独立，互不干扰。
const shareLinkSentCache = Object.create(null);
async function handleShareLink(message) {
  const url = message && message.url;
  const headers = message && message.headers;
  if (!url) {
    notify('解析失败，无法获取真实文件地址');
    return false;
  }
  // 后台兜底去重（content-script 已做一层），避免 App 端重复创建任务
  const now = Date.now();
  if (now - (shareLinkSentCache[url] || 0) < 1500) {
    return true;
  }
  shareLinkSentCache[url] = now;

  const ok = await sendToLeleDownload(url, headers);
  if (ok) {
    notify('已发送到乐乐下载器');
  } else {
    const online = await isAppOnline();
    notify(online ? '解析失败，请改用浏览器原生下载' : '请先运行乐乐下载器，再重试');
  }
  return ok;
}

// 统一的"接管/发送"流程：直接发送到 App，再按结果给明确反馈。
// 与自动接管(onCreated)共用同一发送通道，去掉多余的 /status 前置探测，
// 避免探测异常导致菜单点击静默失败（自动接管路径已验证可用）。
// 返回 true 表示成功下发到 App
async function captureUrl(url) {
  if (!url) {
    notify('无法获取该项的下载链接');
    return false;
  }
  const name = (url || '').split('/').pop() || url;
  console.log('[乐乐] 准备发送：', url);
  const ok = await sendToLeleDownload(url);
  if (ok) {
    notify('已发送到乐乐下载器：' + name);
  } else {
    // 发送失败：可能是 App 未运行，做一次在线探测以给出精确提示
    const online = await isAppOnline();
    notify(online
      ? '发送失败，请确认乐乐下载器可正常接收任务'
      : '请先运行乐乐下载器，再重试');
  }
  return ok;
}

// 右键菜单：显式发送（不受 autoCapture 开关影响）
chrome.contextMenus.onClicked.addListener((info, _tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  console.log('[乐乐] 右键菜单点击, menuItemId=', info.menuItemId, 'url=', url);
  captureUrl(url);
});

// ---------------------------------------------------------------------------
// WeTransfer 原生下载接管：浏览器下载管理器抓到的
// https://wetransfer.com/download/<slug>?id=<base64> 是 WeTransfer 的流式代理地址，
// 鉴权令牌嵌在 URL 中。App 端引擎默认用非浏览器 UA 且不带会话 Cookie/Referer 去 GET，
// 几乎必然被 WAF/鉴权拒绝而「接管了却下不下来正确文件」。
// 故此处组装浏览器 UA + Referer + Origin + 会话 Cookie 头，透传给 App 引擎带自定义头下载。
// ---------------------------------------------------------------------------

// 判定是否为 WeTransfer 原生下载代理地址（host 精确为 wetransfer.com，且路径以 /download/ 开头）。
// 既覆盖 local-bartender，也统一覆盖其它 /download/ 子路径。纯函数，便于单测。
function isWetransferDownloadUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  return host === 'wetransfer.com' && path.indexOf('/download/') === 0;
}

// 由会话 Cookie 串组装下载请求头（纯函数，便于单测）。
// m_wetransfer_api、_wt_session 等会话 Cookie 经此透传，模拟浏览器请求规避 WAF 拦截。
function assembleWetransferHeaders(cookieString) {
  const headers = {
    'Referer': 'https://wetransfer.com/',
    'Origin': 'https://wetransfer.com',
    // 模仿 Chrome 浏览器的 User-Agent，规避 WeTransfer WAF 对非浏览器 UA 的拦截
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (cookieString) {
    headers['Cookie'] = cookieString;
  }
  return headers;
}

// 用 chrome.cookies.getAll 取 wetransfer.com 的会话 Cookie，拼成 Cookie 头后组装完整下载头。
// background service worker 无 document，故仅用 chrome.cookies.getAll（含 HttpOnly）。
async function buildWetransferHeaders() {
  let cookieString = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies && typeof chrome.cookies.getAll === 'function') {
      const cks = await new Promise((resolve) => {
        chrome.cookies.getAll({ url: 'https://wetransfer.com/' }, (cks) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(cks || []);
        });
      });
      const list = cks || [];
      const map = Object.create(null);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const pair = c.name + '=' + c.value;
        const idx = pair.indexOf('=');
        if (idx > 0) {
          const name = pair.slice(0, idx).trim();
          if (name) map[name] = pair.trim(); // 按名去重，后者覆盖前者
        }
      }
      cookieString = Object.keys(map).map((k) => map[k]).join('; ');
    }
  } catch (_) { /* cookie 不可用时 Cookie 头为空，仍带 UA/Referer/Origin */ }
  return assembleWetransferHeaders(cookieString);
}

// 轻量去重冷却：对 WeTransfer 下载 URL 记录最近接管时间戳，1.5s 内重复触发则跳过，
// 防止极端情况下 content-script 的 share-link 路径与 onCreated 路径同时触发造成重复任务。
// 返回 true 表示处于冷却期（应跳过本次接管）；返回 false 表示可接管并记录时间戳。
const wetransferCooldownMap = new Map();
const WETRANSFER_COOLDOWN_MS = 1500;
function isWetransferCaptureCooling(url) {
  const now = Date.now();
  const last = wetransferCooldownMap.get(url) || 0;
  if (now - last < WETRANSFER_COOLDOWN_MS) {
    return true;
  }
  wetransferCooldownMap.set(url, now);
  return false;
}

// 自动接管：浏览器开始任何 http(s) 下载时，交由乐乐下载器接管（类似 IDM 体验）。
// WeTransfer 原生下载（/download/ 代理）额外带浏览器头，确保 App 端能真正下到正确文件。
chrome.downloads.onCreated.addListener((item) => {
  if (!autoCapture) return;
  if (!/^https?:\/\//i.test(item.url || '')) return;
  if (/addons\.mozilla\.org|chromewebstore\.google\.com|edgedaddons\.microsoft\.com/i.test(item.url || '')) return;

  const filename = item.filename || (item.url || '').split('/').pop() || item.url;

  // WeTransfer 原生下载：带浏览器头接管（含去重冷却）
  if (isWetransferDownloadUrl(item.url)) {
    console.log('[乐乐] 检测到 WeTransfer 下载，尝试带浏览器头接管：', item.url);
    // 去重冷却：1.5s 内同一 URL 不重复接管，避免与 content-script 的 share-link 路径叠加
    if (isWetransferCaptureCooling(item.url)) {
      console.log('[乐乐] WeTransfer 接管冷却中，跳过重复触发：', item.url);
      return;
    }
    // 组装浏览器头（UA/Referer/Origin/Cookie）后下发；组装失败则回退无头接管
    buildWetransferHeaders().then((headers) => {
      sendToLeleDownload(item.url, headers).then((ok) => {
        if (ok) {
          try {
            chrome.downloads.cancel(item.id);
            chrome.downloads.erase({ id: item.id });
          } catch (_) { /* Firefox 部分版本 cancel 行为差异，忽略 */ }
          notify('乐乐下载器已接管 WeTransfer：' + filename);
        }
        // 未成功（App 离线）：保持浏览器原生下载，不取消
      });
    }).catch((e) => {
      console.log('[乐乐] WeTransfer 头组装失败，回退无头接管：', e);
      sendToLeleDownload(item.url);
    });
    return;
  }

  console.log('[乐乐] 检测到下载，尝试接管：', item.url);
  // 先尝试把链接交给 App；成功才取消浏览器默认下载，避免 App 未运行时误伤。
  sendToLeleDownload(item.url).then((ok) => {
    if (ok) {
      try {
        chrome.downloads.cancel(item.id);
        chrome.downloads.erase({ id: item.id });
      } catch (_) { /* Firefox 部分版本 cancel 行为差异，忽略 */ }
      notify('乐乐下载器已接管：' + filename);
    }
    // 未成功（App 离线）：保持浏览器原生下载，不取消
  });
});

function notify(message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '乐乐下载器',
      message: message
    });
  } catch (_) { /* 通知不可用时忽略 */ }
}

// 监听来自 popup 的请求
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'download') {
    captureUrl(message.url).then((ok) => sendResponse({ success: ok }));
    return true; // 保持消息通道异步响应
  }
  // 分享链接真实文件请求（content-script 注入页面捕获后上报）：独立分支，零改动原有路径
  if (message && message.type === 'share-link') {
    handleShareLink(message).then((ok) => {
      try { sendResponse({ ok: ok }); } catch (_) { /* content-script 用回调忽略响应 */ }
    });
    return true; // 保持消息通道异步响应
  }
});

// 脚本启动即兜底初始化（不依赖 onInstalled 一定触发）
ensureMenu();
loadSettings();
console.log('[乐乐] 扩展已加载');

// ===================== 网盘真实下载地址解析 =====================
// 架构：App 把"分享链接+提取码"放入待办队列；本后台轮询取走，在扩展内用已登录 cookie
// 调用各网盘接口解析出直链，仅把直链回传 App（cookie 不离开浏览器、不落盘）。
// 说明：各网盘接口可能随官方调整变动，解析逻辑需随平台更新；本实现为 best-effort。

const NETDISK_POLL_MS = 2500;

function detectNetdiskPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('baidu')) return 'baidu';
    if (h.includes('aliyun') || h.includes('alipan')) return 'aliyun';
    if (h.includes('quark')) return 'quark';
    if (h.includes('123pan') || h.includes('123912') || h.includes('123685') || h.includes('123959')) return 'pan123';
    if (h.includes('cloud.189') || h.includes('189.cn')) return 'tianyi';
  } catch (_) { /* ignore */ }
  return null;
}

async function getCookieString(url) {
  try {
    if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.getAll) {
      const cks = await new Promise((resolve) => {
        chrome.cookies.getAll({ url }, (cks) => {
          if (chrome.runtime.lastError) resolve([]);
          else resolve(cks || []);
        });
      });
      const map = Object.create(null);
      (cks || []).forEach((c) => { map[c.name] = c.name + '=' + c.value; });
      return Object.keys(map).map((k) => map[k]).join('; ');
    }
  } catch (_) { /* ignore */ }
  return '';
}

// MV3 限制：SW 的跨域 fetch 带不上 SameSite=Lax 的登录 cookie（BDUSS 等），
// 百度因此把扩展当匿名用户 → api/share/list & verify 直接返 404 HTML。
// 用 declarativeNetRequest 会话规则给 pan.baidu.com 的子资源请求显式注入
// Cookie / Referer 头（fetch 无法手动设置这两个头）。Firefox 不支持时静默降级。
let BAIDU_AUTH_RULE_ID = 5001;
async function ensureBaiduAuthHeaders() {
  try {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest ||
        typeof chrome.declarativeNetRequest.updateSessionRules !== 'function') return;
    const cookie = await getCookieString('https://pan.baidu.com');
    if (!cookie) return;
    const rules = [{
      id: BAIDU_AUTH_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Cookie', operation: 'set', value: cookie },
          { header: 'Referer', operation: 'set', value: 'https://pan.baidu.com/' },
        ],
      },
      condition: {
        urlFilter: '||pan.baidu.com/',
        resourceTypes: ['xmlhttprequest'],
      },
    }];
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules, removeRuleIds: [BAIDU_AUTH_RULE_ID] });
  } catch (_) { /* DNR 不可用/被拒时静默降级为匿名请求 */ }
}

// 统一的 JSON 请求封装。
// 【关键】MV3 Service Worker 的 fetch 受 Forbidden header 限制：
// Cookie / User-Agent / Referer 这类头即使写进 headers 也会被浏览器静默丢弃。
// 因此这里一律用 credentials:'include' 让浏览器自动携带目标站点的登录态 cookie
// （manifest 已声明 <all_urls> host_permissions，扩展发起的跨域请求不受 CORS 限制）。
// 真正需要手工带 Cookie/UA/Referer 的是「回传给 App 下载引擎的 headers」——
// 那条链路走 Rust reqwest，不受浏览器禁止头限制，见各解析器返回值的 headers 字段。
async function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      url,
      Object.assign({ signal: controller.signal, cache: 'no-store', credentials: 'include' }, opts)
    );
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { throw new Error('[HTTP ' + res.status + '] 非 JSON 响应: ' + text.slice(0, 300)); }
  } finally {
    clearTimeout(timer);
  }
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

// ---- 各平台解析器 ----

// 123云盘：官方分享 API（公开分享可匿名；带密分享传 pwd）
async function resolvePan123(url, pwd) {
  const origin = new URL(url).origin;
  const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const shareKey = m ? m[1] : '';
  if (!shareKey) throw new Error('无法从链接提取分享Key');
  const get = await fetchJson(origin + '/api/share/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareKey: shareKey, sharePwd: pwd || '', page: 1, limit: 100 }),
  });
  const files = (get.data && get.data.fileList && get.data.fileList.data) || [];
  if (!files.length) throw new Error('123云盘分享内没有可下载文件，或需要密码');
  const out = [];
  for (const f of files) {
    const dl = await fetchJson(origin + '/api/share/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareKey: shareKey, sharePwd: pwd || '', fileId: f.fileId }),
    });
    const durl = dl.data && dl.data.DownloadURL;
    if (!durl) throw new Error('123云盘未返回直链（可能需要登录或密码）');
    out.push({
      name: f.filename,
      size: bytesToSize(f.fileSize),
      url: durl,
      headers: { Referer: origin + '/', 'User-Agent': navigator.userAgent },
    });
  }
  return out;
}

// 夸克网盘：必须在 pan.quark.cn 页面上下文发请求。
// drive-pc.quark.cn 的 CORS 仅放行 Origin=https://pan.quark.cn 的同源页面请求；
// SW 里的跨域 fetch 其 Origin 固定为 chrome-extension://<id>，会被服务器
// 返回 [HTTP 403] Invalid CORS request。因此走 chrome.scripting.executeScript，
// 把请求注入到 pan.quark.cn 标签页内执行：Origin 自动为 pan.quark.cn 且自动携带
// 登录态 cookie，CORS 通过。（注意 fetchJson 是 SW 全局函数，content script 内不可用，
// 故注入函数内一律用原生 fetch。）
// cookie 由 SW 侧读取 pan.quark.cn 登录态后传入（含 httpOnly），页面 fetch 显式带 Cookie，
// 确保 drive-pc.quark.cn 的 download 接口能拿到登录态（匿名 401 require login）。
// 在 pan.quark.cn 页面上下文运行（见 resolveQuark 说明）。
// 关键：页面跨域 fetch drive-pc.quark.cn 必须带 credentials:'include' 才会发送夸克登录态
// cookie（默认 same-origin 不跨域发 cookie，导致 download 401）。页面 fetch 无法手动设置
// Cookie 头（forbidden），故依赖浏览器自动携带 + credentials:'include'。
// 重要：夸克分享文件**不能直连 file/download**（会报 require login [share missing]），标准做法
// 是先把分享转存(save)到自己的网盘，等转存完成(status==2)后，从 task 响应的 data.save_as.save_as[]
// 取**新 fid**，再用新 fid 走自有网盘的 {"fids":[新fid]}下载（转存会生成新 fid，原始分享 fid 在
// 自有网盘里查不到 → "file not found"；只需 cookie 无需 X-User-Token）。
// 永远返回结构化对象 {ok, step, status, body, files}，绝不抛出（throw 会被吞成 result:null）。
async function quarkApiFetch(pwdId, pwd) {
  const log = (...a) => console.log('[quark-inject]', ...a);
  const headers = { 'Content-Type': 'application/json', 'Referer': 'https://pan.quark.cn/' };
  const out = { ok: false };
  const api = (path) => 'https://drive-pc.quark.cn/1/clouddrive' + path;
  try {
    log('token req pwdId=', pwdId, 'pwd=', pwd ? '***' : '(空)');
    const tokenResp = await fetch(api('/share/sharepage/token?pr=ucpro&fr=pc'), {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '', app_ver: '2.5.0' }),
    });
    const tokenJson = await tokenResp.json();
    const stoken = tokenJson.data && tokenJson.data.stoken;
    if (!stoken) { out.step = 'token'; out.status = tokenResp.status; out.body = JSON.stringify(tokenJson).slice(0, 200); return out; }
    // 2) 递归列文件（含子目录）：detail 为 GET，pwd_id + stoken 放 query（POST 会 405）
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
    log('detail files=', allFiles.length);
    // 3) 转存到自己的网盘（必须；直连 download 会 [share missing]）
    const saveResp = await fetch(api('/share/sharepage/save?pr=ucpro&fr=pc'), {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({
        fid_list: allFiles.map((f) => f.fid),
        fid_token_list: allFiles.map((f) => f.share_fid_token || f.fid_token || ''),
        pwd_id: pwdId, stoken: stoken, pdir_fid: '0', scene: 'link',
      }),
    });
    const saveJson = await saveResp.json();
    log('save', saveResp.status, JSON.stringify(saveJson).slice(0, 200));
    if (saveJson.status !== 200 || !saveJson.data || !saveJson.data.task_id) {
      out.step = 'save'; out.status = saveResp.status; out.body = JSON.stringify(saveJson).slice(0, 300); return out;
    }
    // 4) 轮询转存任务，转存完成后从 data.save_as.save_as 取「新 fid」
    //    （夸克转存会生成新 fid，藏在 task 响应的 save_as.save_as[] 里，不是 task_info_list）
    let taskJson = null;
    let savedList = [];
    for (let i = 0; i < 40; i++) {
      const taskResp = await fetch(api('/task?pr=ucpro&fr=pc&task_id=' + encodeURIComponent(saveJson.data.task_id) + '&retry_index=0'), { method: 'GET', headers, credentials: 'include' });
      taskJson = await taskResp.json();
      const st = taskJson.data && taskJson.data.status;
      if (st === 2) {
        const sa = (taskJson.data && taskJson.data.save_as) || {};
        savedList = sa.save_as || [];                                   // 新 fid 列表
        if (!savedList.length) savedList = (taskJson.data && taskJson.data.task_info_list) || []; // 兜底旧结构
        break;
      }
      if (st === 3) {                 // 3 = 转存失败
        out.step = 'task'; out.status = (taskJson && taskJson.status) || 0;
        out.body = '转存任务失败：' + JSON.stringify(taskJson && taskJson.data).slice(0, 300);
        return out;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // 5) 用新 fid 走自有网盘下载（新 fid 已属自己网盘，原始分享 fid 不存在于自有网盘）
    const files = [];
    for (let i = 0; i < allFiles.length; i++) {
      const src = allFiles[i];
      // 优先按 file_name 配对（防顺序错位），否则按索引
      let saved = savedList.find((s) => s.file_name === src.file_name) || savedList[i] || {};
      const nf = saved.fid || saved.file_id || (saved.save_as && saved.save_as.fid);
      if (!nf) { out.step = 'task'; out.status = (taskJson && taskJson.status) || 0; out.body = '转存任务未返回新fid：' + JSON.stringify(taskJson && taskJson.data).slice(0, 300); return out; }
      const dlResp = await fetch(api('/file/download?pr=ucpro&fr=pc'), {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify({ fids: [nf] }),
      });
      const dlJson = await dlResp.json();
      log('dl', dlResp.status, JSON.stringify(dlJson).slice(0, 200));
      const arr = Array.isArray(dlJson.data) ? dlJson.data : [];
      const durl = (arr[0] && arr[0].download_url) || '';
      if (!durl) { out.step = 'download'; out.status = dlResp.status; out.body = JSON.stringify(dlJson).slice(0, 300); out.name = src.file_name; return out; }
      files.push({ name: saved.file_name || src.file_name, size: saved.size || src.size, url: durl });
    }
    out.ok = true; out.files = files;
    return out;
  } catch (e) {
    out.step = 'exception'; out.error = String((e && e.message) || e);
    log('exception', out.error);
    return out;
  }
}

// 找一个已打开的 pan.quark.cn/s/* 标签页；没有则返回 null（由调用方临时开一个）
async function getQuarkPageTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://pan.quark.cn/s/*' });
    if (tabs && tabs.length) return tabs[0].id;
  } catch (_) {}
  return null;
}

// 等待标签页加载完成（最多 ~10s）
async function waitTabComplete(tabId) {
  for (let i = 0; i < 40; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return;
    } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// 夸克网盘：在 pan.quark.cn 页面上下文解析（见 quarkApiFetch 说明）
async function resolveQuark(url, pwd) {
  const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const pwdId = m ? m[1] : '';
  if (!pwdId) throw new Error('无法从链接提取分享ID');
  // 下载阶段需要 pan.quark.cn 登录态 cookie（含 httpOnly），由 SW 侧读取后回传给 App 下载引擎
  const cookie = await getCookieString('https://pan.quark.cn');
  if (!cookie) throw new Error('未检测到夸克网盘登录态，请先在浏览器登录 pan.quark.cn');
  // 优先复用已打开的夸克分享页；没有则临时开一个后台标签页，解析完即关
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
    // 等 SPA 稳定，避免注入时页面仍在跳转导致执行上下文被销毁（表现为 result:null）
    await new Promise((rs) => setTimeout(rs, 1500));
    let r = null;
    let lastRes = null;
    // result 为 null 通常是注入时文档被替换（未登录触发登录跳转 / SPA 路由变更），重试一次；
    // 若 executeScript 直接 reject（上下文被销毁）也按失败处理并重试
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
        console.log('[quark] inject threw:', lastRes.injectError);
      }
      console.log('[quark] inject result(', attempt, ')=', JSON.stringify(r).slice(0, 500));
      if (r && r.ok) break;
      if (tempTabId == null) {
        const tab = await chrome.tabs.create({ url: 'https://pan.quark.cn/s/' + pwdId, active: false });
        tempTabId = tab.id;
        await waitTabComplete(tempTabId);
        tabId = tempTabId;
      } else {
        await waitTabComplete(tabId);
      }
      await new Promise((rs) => setTimeout(rs, 800));
    }
    if (!r || !r.ok) {
      const detail = r ? (r.error || r.body || '无详情') : (lastRes && lastRes.injectError ? ('inject失败:' + lastRes.injectError) : JSON.stringify(lastRes));
      const loginHint = /login|未登录|请先登录/i.test(detail) ? '；请确认已在当前浏览器登录 pan.quark.cn 夸克网盘（扩展借用你的登录态转存并下载）' : '';
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

// 阿里云盘（alipan.com，原 aliyundrive.com）
// 官方分享流程（与 AList aliyundrive_share 驱动一致）：
//   1) refresh_token -> access_token          POST auth.alipan.com/v2/account/token
//   2) share_id + 提取码 -> share_token       POST api.alipan.com/v2/share_link/get_share_token
//   3) 列文件（须带 x-share-token 头）         POST api.alipan.com/adrive/v3/file/list
//   4) 换直链（Authorization + x-share-token） POST api.alipan.com/v2/file/get_share_link_download_url
// 注意：share_token 是独立换取的，不会由 get_share_by_url 返回；提取码只在第 2 步生效。
const ALI_CANARY = 'client=web,app=share,version=v2.3.1';

async function resolveAliyun(url, pwd) {
  // refresh_token 优先从站点 cookie 读，其次读扩展本地存储（用户手动配置）
  let refreshToken = '';
  for (const site of ['https://www.alipan.com', 'https://www.aliyundrive.com']) {
    const ck = await getCookieString(site);
    const m = (ck.match(/refresh_token=([^;]+)/) || [])[1];
    if (m) { refreshToken = decodeURIComponent(m); break; }
  }
  if (!refreshToken) {
    refreshToken = await new Promise((res) => {
      try { chrome.storage.local.get(['aliyun_refresh_token'], (r) => res((r && r.aliyun_refresh_token) || '')); }
      catch (_) { res(''); }
    });
  }
  if (!refreshToken) {
    throw new Error('未检测到阿里云盘 refresh_token：请先在 alipan.com 登录；若仍失败，可在扩展存储手动配置 chrome.storage.local.set({aliyun_refresh_token:"..."})');
  }

  const tokenResp = await fetchJson('https://auth.alipan.com/v2/account/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const accessToken = tokenResp.access_token;
  if (!accessToken) throw new Error('阿里获取 access_token 失败（refresh_token 可能已过期，请重新登录）');

  // share_id 直接从分享链接提取：https://www.alipan.com/s/<shareId>
  const sm = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const shareId = sm ? sm[1] : '';
  if (!shareId) throw new Error('无法从链接提取阿里云盘 share_id');

  const stBody = { share_id: shareId };
  if (pwd) stBody.share_pwd = pwd;
  const st = await fetchJson('https://api.alipan.com/v2/share_link/get_share_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stBody),
  });
  const shareToken = st.share_token;
  if (!shareToken) {
    const code = st.code || '';
    if (String(code).indexOf('SharePwd') >= 0) throw new Error('阿里云盘分享需要提取码，或提取码不正确');
    throw new Error('阿里获取 share_token 失败：' + JSON.stringify(st).slice(0, 200));
  }

  const shareHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + accessToken,
    'x-share-token': shareToken,
    'X-Canary': ALI_CANARY,
  };

  // 列文件（分页 marker 直到取完；单次上限 200）
  const items = [];
  let marker = '';
  do {
    const body = {
      share_id: shareId, parent_file_id: 'root', limit: 200,
      order_by: 'name', order_direction: 'ASC',
      image_thumbnail_process: '', image_url_process: '', video_thumbnail_process: '',
    };
    if (marker) body.marker = marker;
    const flist = await fetchJson('https://api.alipan.com/adrive/v3/file/list', {
      method: 'POST', headers: shareHeaders, body: JSON.stringify(body),
    });
    (flist.items || []).forEach((x) => items.push(x));
    marker = flist.next_marker || '';
  } while (marker && items.length < 1000);

  const files = items.filter((x) => x.type === 'file');
  if (!files.length) throw new Error('阿里分享内没有可下载文件（仅含文件夹时暂不支持递归）');

  const out = [];
  for (const f of files) {
    const dl = await fetchJson('https://api.alipan.com/v2/file/get_share_link_download_url', {
      method: 'POST', headers: shareHeaders,
      body: JSON.stringify({ share_id: shareId, file_id: f.file_id, expire_sec: 600 }),
    });
    const durl = dl.download_url || dl.url;
    if (!durl) throw new Error('阿里未返回直链：' + JSON.stringify(dl).slice(0, 200));
    out.push({
      name: f.name,
      size: bytesToSize(f.size),
      url: durl,
      headers: { Referer: 'https://www.alipan.com/', 'User-Agent': navigator.userAgent },
    });
  }
  return out;
}

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
// 从 yunData 文本里按 key 取数字值（兼容 "uk":123 与 uk:123 两种写法）
function pickNum(blob, key) {
  // 兼容 key 带引号（"uk":123）与不带引号（uk:123）两种写法：key 与分隔符之间允许一个可选引号
  const m = blob.match(new RegExp('(?:^|[^A-Za-z0-9_])' + key + '\\s*["\']?\\s*[:=]\\s*["\']?\\s*(\\d+)'));
  return m ? m[1] : '';
}
// 从 yunData 文本里按 key 取字符串值（兼容 "sign":"abc" 与 sign:'abc' 两种写法）
function pickStr(blob, key) {
  const m = blob.match(new RegExp('(?:^|[^A-Za-z0-9_])' + key + "\\s*[:=]\\s*[\"']([^\"']*)[\"']"));
  return m ? m[1] : '';
}
// 获取百度分享的 uk / shareid：优先页面 window.yunData，兜底 api/shareinfo
// 形参：
//   pageUrl     —— 应抓取的分享页。/s/ 短链抓 https://pan.baidu.com/s/<surl>（新版页，yunData 含 share_uk/shareid，
//                 但不含 sign/timestamp）；?surl= 旧链抓 https://pan.baidu.com/share/init?surl=（旧版页，yunData 含 sign/timestamp）。
//   apiShorturl —— api/shareinfo 用的规范化 shorturl（/s/ 链即 surl 本身；?surl= 旧链需 1 前缀）。由调用方按链接类型算好传入。
// 列表：wxlist。返回 { list, uk, shareid, seckey }
// 参考 baiduwp-php / 94list / tychxn / LinkSwift / kdown.moiu.cn：
// 2024 年后的 /s/、/e/ 新短链不再走 /share/list + /share/verify + window.yunData，
// 而是 wxlist（列表）+ tplconfig（sign/timestamp 令牌）+ sharedownload（直链）。
// POST https://pan.baidu.com/share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1
// body: shorturl=<surl>&dir=&root=1&pwd=<pwd>&page=1&num=1000&order=time
//   -> { errno:0, data:{ uk, shareid, seckey, list:[...] } }
//   /s/、/e/ 用 bare shorturl（不加前缀）；?surl= 旧链用 '1'+CODE。
// errno 语义：2 = 链接失效/不存在；-9/-10/-12 = 提取码错误。
async function baiduWxList(apiShorturl, pwd) {
  const body = 'shorturl=' + encodeURIComponent(apiShorturl) +
    '&dir=&root=1&pwd=' + encodeURIComponent(pwd || '') +
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
  // seckey 由百度返回（URL 编码形态），稍后 sharedownload 前 decodeURIComponent 再传
  const seckey = (d.seckey != null) ? String(d.seckey) : '';
  if (!uk || !shareid) {
    throw new Error('百度 wxlist 未返回 uk/shareid（链接可能已失效或提取码不正确）：' + apiShorturl);
  }
  if (!list.length) {
    throw new Error('百度分享内没有文件（errno ' + en + (res.errmsg ? ': ' + res.errmsg : '') + '）（shorturl=' + apiShorturl + '）');
  }
  return { list, uk, shareid, seckey };
}

// 令牌：tplconfig 取 sign/timestamp（sharedownload 反爬令牌）。
// GET https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&surl=<surl>
//   -> data.sign / data.timestamp（页面 JS 也是从这里取，非本地盐值算法）。
// 失败不致命，返回空让 sharedownload 阶段再报错。
async function baiduGetSign(apiShorturl) {
  let res;
  try {
    res = await fetchJson('https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&surl=' + encodeURIComponent(apiShorturl), {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
  } catch (_) {
    return { sign: '', timestamp: '' };
  }
  const d = (res && res.data) || {};
  return {
    sign: d.sign != null ? String(d.sign) : '',
    timestamp: d.timestamp != null ? String(d.timestamp) : '',
  };
}

// 百度网盘：需 BDUSS（免费账号直链由平台限速，会员账号登录则满速）
// 提取码验证：先 /share/verify 拿到 randsk（即 BDCLND 令牌）并写入 cookie，
// 否则 api/sharedownload 会返回 errno 9019 needverify。
// 关键 MV3 坑：SW fetch 响应里的 Set-Cookie(BDCLND) 不会回写到 chrome.cookies 可见的 jar，
// 导致后续靠 credentials:'include' 自然携带、或重新 getCookieString 都拿不到 BDCLND → 9019 死循环。
// 因此 verify 后显式 chrome.cookies.set 把 BDCLND 桥接进 jar，再刷新 DNR 注入头一起带上。
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
    if (ven !== '' && ven !== 0) {
      // verify 失败（如提取码错误）不在此抛错，交给 sharedownload 阶段给更清晰诊断
      return '';
    }
    let randsk = (v && v.randsk) ? String(v.randsk) : '';
    if (randsk) {
      try { randsk = decodeURIComponent(randsk); } catch (_) { /* 已解码则原样使用 */ }
      // 显式桥接进 cookie jar（MV3 SW 的 Set-Cookie 不回写 jar 的坑）
      try {
        if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.set) {
          await new Promise((res) => {
            chrome.cookies.set({ url: 'https://pan.baidu.com', name: 'BDCLND', value: randsk, path: '/', secure: true }, () => res());
          });
        }
      } catch (_) { /* 写入失败则依赖 credentials:'include' 自然携带 */ }
      // 刷新 DNR 注入头，使后续请求带上 BDCLND（与 BDUSS 一起）
      await ensureBaiduAuthHeaders();
    }
    return randsk;
  } catch (_) {
    return '';
  }
}

async function resolveBaidu(url, pwd) {
  // MV3 SW 跨域 fetch 带不上 SameSite=Lax 登录 cookie → 用 DNR 会话规则显式注入 Cookie/Referer
  await ensureBaiduAuthHeaders();
  let cookie = await getCookieString('https://pan.baidu.com');
  const u = new URL(url);
  let surl = (u.searchParams.get('surl') || '').trim();
  let apiShorturl = '';
  if (surl) {
    // ?surl=xxx 旧版短链：api 用 1 前缀（kdown.moiu.cn parser.js 规则）
    apiShorturl = '1' + surl;
  } else {
    const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
    if (m) { surl = m[1]; apiShorturl = surl; }
    else {
      // /e/ 企业分享：同 /s/ 处理（kdown 将 /e/ 规范化为 /s/）
      const m2 = url.match(/\/e\/([A-Za-z0-9_-]+)/);
      if (m2) { surl = m2[1]; apiShorturl = surl; }
    }
  }
  if (!surl) throw new Error('无法从链接提取 surl（请使用 pan.baidu.com 的分享链接）');
  // 链接里可能直接带 &pwd= 提取码；优先用调用方传入的，其次从 URL 取
  pwd = (pwd || '').trim() || (u.searchParams.get('pwd') || '').trim() || '';
  const BAIDU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

  // 1) 列表（wxlist）。/s/、/e/ 用 bare shorturl；?surl= 用 1 前缀
  const { list, uk, shareid, seckey } = await baiduWxList(apiShorturl, pwd);
  // seckey 是 URL 编码的，解码后作为 sekey 传 sharedownload（避免双重编码触发参数错误）
  const sekey = seckey ? safeDecode(seckey) : '';

  // 2) 令牌（tplconfig 取 sign/timestamp）
  const { sign, timestamp } = await baiduGetSign(apiShorturl);

  // 直链（sharedownload）：严格对齐可工作的参考实现 netdisk-resolver
  //   params: channel=chunlei&clienttype=0&app_id=250528&sign&timestamp&web=1
  //   body:   encrypt=0&product=share&primaryid=<id>&shareid=<id>&uk=<uk>&fid_list=[fs_id](紧凑JSON)&extra={"sekey":<seckey>}
  //   headers: Referer=share/link?shareid=<id>&uk=<uk> + X-Requested-With
  // wxlist 返回的 seckey 即带密分享的验证令牌，无需先 /share/verify；
  // 仅当返回 errno 9019 needverify 时才补 verify（取 BDCLND 桥接进 cookie jar）并用 randsk 重试。
  const out = [];
  let triedVerify = false;
  let lastRandsk = '';
  for (const f of list) {
    let dlink = '';
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
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
      if (en === 9019 && !triedVerify) {
        // 补验证：/share/verify 取 randsk（即 BDCLND 令牌）桥接进 cookie jar 后重试
        triedVerify = true;
        const randsk = await baiduVerifySetCookie(shareid, uk, pwd, sign, timestamp);
        if (randsk) {
          lastRandsk = randsk;
          // 验证后刷新 cookie（含 BDCLND），供本文件及下载引擎使用
          const newCookie = await getCookieString('https://pan.baidu.com');
          if (newCookie) cookie = newCookie;
        }
        continue; // 用 randsk 作 sekey 重试一次
      }
      const dl = sd.list && sd.list[0] && sd.list[0].dlink;
      if (dl) { dlink = dl; break; }
      lastErr = (typeof en !== 'undefined' && en !== '') ? ('errno ' + en + (sd.errmsg ? ': ' + sd.errmsg : '')) : '无 dlink';
      if (en !== 9019) {
        throw new Error('百度未返回 dlink（' + lastErr + '）（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）：' + JSON.stringify(sd).slice(0, 200));
      }
    }
    if (!dlink) {
      throw new Error('百度未返回 dlink（' + (lastErr || '未知错误') + '）（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）');
    }
    out.push({
      name: f.server_filename,
      size: bytesToSize(f.size),
      url: dlink,
      headers: { 'User-Agent': BAIDU_UA, Referer: 'https://pan.baidu.com/', Cookie: cookie },
    });
  }
  return out;
}

// 天翼云盘：使用第三方解析 API（52api.cn），需用户在扩展存储配置 tianyi_api_key
async function resolveTianyi(url, pwd) {
  const key = await new Promise((resolve) => {
    try { chrome.storage.local.get(['tianyi_api_key'], (r) => resolve((r && r.tianyi_api_key) || '')); }
    catch (_) { resolve(''); }
  });
  if (!key) throw new Error('天翼解析需要 52api.cn 的 apikey：请在扩展存储中设置（chrome.storage.local.set({tianyi_api_key:"你的key"})）');
  const api = 'https://www.52api.cn/api/189_cloud?apikey=' + encodeURIComponent(key) + '&url=' + encodeURIComponent(url) + '&pwd=' + encodeURIComponent(pwd || '');
  const r = await fetchJson(api);
  if (r.code !== 200 || !r.data) throw new Error('天翼解析失败：' + (r.msg || JSON.stringify(r).slice(0, 200)));
  const arr = Array.isArray(r.data) ? r.data : [r.data];
  return arr.map((x) => ({ name: x.name || x.fileName || 'file', size: x.size ? String(x.size) : '', url: x.downloadUrl || x.url }));
}

// 分发
async function resolveNetdisk(req) {
  const platform = detectNetdiskPlatform(req.url) || req.platform;
  switch (platform) {
    case 'baidu': return await resolveBaidu(req.url, req.pwd);
    case 'aliyun': return await resolveAliyun(req.url, req.pwd);
    case 'quark': return await resolveQuark(req.url, req.pwd);
    case 'pan123': return await resolvePan123(req.url, req.pwd);
    case 'tianyi': return await resolveTianyi(req.url, req.pwd);
    default: throw new Error('不支持的网盘平台：' + (req.url || ''));
  }
}

// ---- 轮询 App 待解析队列并回传结果 ----

let netdiskPolling = false;
// 已在解析中的请求 id：SW 重启或轮询重入时，避免同一请求被并发解析两次
// （App 侧要收到 result 才会把它从 pending 移除，慢解析期间会被重复捞到）。
const netdiskInflight = new Set();

async function pollNetdiskPending() {
  if (netdiskPolling) return;
  netdiskPolling = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(APP_BASE + '/api/netdisk/resolve/pending', { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!resp.ok) return;
    const list = await resp.json();
    if (!Array.isArray(list)) return;
    for (const req of list) {
      if (!req || !req.id || netdiskInflight.has(req.id)) continue;
      netdiskInflight.add(req.id);
      try {
        const files = await resolveNetdisk(req);
        await reportNetdiskResult({ id: req.id, ok: true, files: files, url: req.url });
      } catch (e) {
        await reportNetdiskResult({ id: req.id, ok: false, error: String((e && e.message) || e), url: req.url });
      } finally {
        netdiskInflight.delete(req.id);
      }
    }
  } catch (e) {
    // App 离线或网络异常，静默跳过本轮
  } finally {
    netdiskPolling = false;
  }
}

async function reportNetdiskResult(payload) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(APP_BASE + '/api/netdisk/resolve/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal, cache: 'no-store',
    });
    clearTimeout(timer);
  } catch (_) { /* ignore */ }
}

// MV3 Service Worker 生命周期限制：SW 空闲约 30s 就会被回收，setInterval 随之失效。
// 双保险：
//   1) setInterval —— SW 存活期间做 2.5s 快速轮询，保证用户点「解析」后能秒级响应；
//   2) chrome.alarms —— SW 被回收后仍能按最小周期（Chrome 限制 >=30s）唤醒 SW 兜底，
//      唤醒后 setInterval 会随 SW 重新初始化而恢复快速轮询。
setInterval(pollNetdiskPending, NETDISK_POLL_MS);
pollNetdiskPending();

const NETDISK_ALARM = 'lele-netdisk-poll';
try {
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    chrome.alarms.create(NETDISK_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a && a.name === NETDISK_ALARM) pollNetdiskPending();
    });
  }
} catch (_) { /* alarms 权限缺失时忽略，退化为仅 setInterval */ }

