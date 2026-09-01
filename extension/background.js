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
      contexts: ['link', 'image', 'video', 'audio', 'page', 'selection']
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
    if (response.ok) return { ok: true };
    // App 拒绝了：尝试从 JSON 响应体提取精确 msg
    // （magnet 路由会回 {e:'bt_failed',msg:'...'}；HTTP 路由会回 url_blocked/create_failed）
    let msg = '';
    try {
      const txt = await response.text();
      const j = JSON.parse(txt);
      if (j && typeof j.msg === 'string') msg = j.msg;
    } catch (_) { /* 不是 JSON 时忽略，落到下方通用提示 */ }
    if (msg) console.log('[乐乐] App 拒绝：', msg);
    return { ok: false, msg: msg };
  } catch (e) {
    console.log('[乐乐] 发送下载请求失败：', e);
    return { ok: false, msg: String((e && e.message) || e) };
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

  // WeTransfer 补全浏览器头：content-script 上报的 headers 来自页面 fetch，
  // 通常缺 Origin（页面 fetch 不带）且 UA 非浏览器 UA；签名 CDN 或代理地址需要
  // Referer/Origin/浏览器 UA/会话 Cookie 才不会被 WAF 拒绝。
  // 故对 wetransfer 系 URL 先用 buildWetransferHeaders 补齐，再让页面原始头覆盖同名字段
  // （页面头带真实 Referer/页面 Cookie，优先级更高）。
  let finalHeaders = headers;
  if (isWetransferDownloadUrl(url)) {
    try {
      const wtHeaders = await buildWetransferHeaders();
      finalHeaders = Object.assign({}, wtHeaders, headers || {});
    } catch (_) { /* 头组装失败时保留页面原始头，不阻塞发送 */ }
  }

  const res = await sendToLeleDownload(url, finalHeaders);
  if (res.ok) {
    notify('已发送到乐乐下载器');
  } else if (res.msg) {
    notify('解析失败：' + res.msg);
  } else {
    const online = await isAppOnline();
    notify(online ? '解析失败，请改用浏览器原生下载' : '请先运行乐乐下载器，再重试');
  }
  // 注意：此处原为 `return ok;`，ok 未声明 → ReferenceError，
  // 导致成功路径抛错、sendResponse 不执行、content-script 收不到响应。修正为 res.ok。
  return res.ok === true;
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
  const res = await sendToLeleDownload(url);
  if (res.ok) {
    notify('已发送到乐乐下载器：' + name);
    return true;
  }
  // 失败：有具体 msg 时直接展示（最常见是 BT 引擎拒绝：连接 tracker 失败、
  // 无做种者、metadata 取不到等），否则回退旧的"App 在线/离线"二选一提示。
  if (res.msg) {
    notify('发送失败：' + res.msg);
    return false;
  }
  const online = await isAppOnline();
  notify(online
    ? '发送失败，请确认乐乐下载器可正常接收任务'
    : '请先运行乐乐下载器，再重试');
  return false;
}

// content-script（magnet-context.js）在页面右键磁力/种子链接时，把真实 href 发来，
// 绕过 Chrome 对非标准协议（magnet:/thunder:/ed2k:）链接不填充 contextMenus linkUrl 的坑。
let lastRightClickedMagnet = '';
try {
  chrome.runtime.onMessage.addListener((msg, _sender) => {
    if (msg && msg.type === 'lele-magnet-href' && typeof msg.href === 'string') {
      lastRightClickedMagnet = msg.href;
    }
  });
} catch (_) {}

// 右键菜单：显式发送（不受 autoCapture 开关影响）
chrome.contextMenus.onClicked.addListener(async (info, _tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // 优先级：linkUrl（标准协议 Chrome 会给）→ 媒体源/选中文本/页面
  let url = info.linkUrl || info.srcUrl || info.selectionText || info.pageUrl;

  // 非标准协议（magnet: 等）Chrome 常不填充 linkUrl，走 content-script 兜底的 href。
  // 用重试轮询读取 storage + 内存兜底，规避 MV3 SW 唤醒/消息时序竞态。
  if (!url || (!url.startsWith('magnet:') && !/^https?:\/\//.test(url))) {
    for (let attempt = 0; attempt < 6; attempt++) {
      let candidate = null;
      try {
        const stored = await new Promise((resolve) => {
          chrome.storage.local.get(['lele_last_magnet'], (r) => resolve(r.lele_last_magnet));
        });
        if (stored) candidate = stored;
      } catch (_) {}
      if (!candidate && lastRightClickedMagnet) candidate = lastRightClickedMagnet;
      if (candidate && (candidate.startsWith('magnet:') || /^https?:\/\//.test(candidate))) {
        url = candidate;
        break;
      }
      await new Promise(r => setTimeout(r, 80));
    }
  }

  // 兜底：从选中文本提取
  if ((!url || !/^(magnet:|https?:\/\/)/.test(url)) && info.selectionText) {
    const m = info.selectionText.match(/(magnet:\?[^\s]+|https?:\/\/[^\s]+)/i);
    if (m) url = m[1];
  }

  console.log('[乐乐] 右键菜单点击, menuItemId=', info.menuItemId, 'url=', url, 'linkUrl=', info.linkUrl);
  if (!url || !/^(magnet:|https?:\/\/)/.test(url)) {
    // 临时诊断：便于定位为何没捕获到磁力（装好验证后可删）
    notify('调试：未捕获到磁力/HTTP 链接（linkUrl=' + (info.linkUrl || '空') + '，content-script 兜底也未命中）');
    return;
  }
  lastRightClickedMagnet = ''; // 消费后清空，避免误用上一次残留
  captureUrl(url.trim());
});

// ---------------------------------------------------------------------------
// WeTransfer 原生下载接管：浏览器下载管理器抓到的
// https://wetransfer.com/download/<slug>?id=<base64> 是 WeTransfer 的流式代理地址，
// 鉴权令牌嵌在 URL 中。App 端引擎默认用非浏览器 UA 且不带会话 Cookie/Referer 去 GET，
// 几乎必然被 WAF/鉴权拒绝而「接管了却下不下来正确文件」。
// 故此处组装浏览器 UA + Referer + Origin + 会话 Cookie 头，透传给 App 引擎带自定义头下载。
// ---------------------------------------------------------------------------

// 判定是否为 WeTransfer 下载地址，覆盖三类真实形态：
//   1) 流式代理：wetransfer.com/download/<slug>?id=<base64>（鉴权令牌嵌在 URL 中，含 local-bartender）
//   2) 直连下载域：download. / filedownload. / transfer.wetransfer.com
//   3) 2026 实际文件 CDN：*-files.wetransfer.net（如 eu-west-1-files.wetransfer.net，
//      带 Expires= + Signature= 的 CloudFront/S3 签名 URL）
//
// 修复背景：content-script.js 的 isLikelyFileRequest 早已把 2)/3) 识别为文件请求，
// 但本函数旧版只认 1)，导致 2)/3) 走进「普通接管」分支 —— 不带 Referer/Origin/浏览器 UA/会话 Cookie，
// App 引擎以非浏览器 UA 直连签名 URL，被 WAF/鉴权拒绝（用户反馈：点了下载没正确接管）。
//
// 注意：CDN 判定必须用 endsWith('files.wetransfer.net')，绝不能用 endsWith('.wetransfer.net')，
// 否则会把 ekstrom / bsp-proxy / preview-eu 等 API/预览域名也误判为文件，破坏页面下载初始化。
// 纯函数，便于单测。
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
  // 1) 流式代理（仅主域 wetransfer.com 的 /download/ 路径，含 local-bartender 及其它子路径）
  if (host === 'wetransfer.com' && path.indexOf('/download/') === 0) return true;
  // 2) 直连下载域
  if (host === 'download.wetransfer.com') return true;
  if (host === 'filedownload.wetransfer.com') return true;
  if (host === 'transfer.wetransfer.com') return true;
  // 3) 2026 实际文件 CDN（签名 URL）
  if (host.endsWith('files.wetransfer.net')) return true;
  return false;
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
      sendToLeleDownload(item.url, headers).then((res) => {
        if (res.ok) {
          try {
            chrome.downloads.cancel(item.id);
            chrome.downloads.erase({ id: item.id });
          } catch (_) { /* Firefox 部分版本 cancel 行为差异，忽略 */ }
          notify('乐乐下载器已接管 WeTransfer：' + filename);
        }
        // 未成功（App 离线 / 接管失败）：保持浏览器原生下载，不取消
      });
    }).catch((e) => {
      console.log('[乐乐] WeTransfer 头组装失败，回退无头接管：', e);
      sendToLeleDownload(item.url);
    });
    return;
  }

  console.log('[乐乐] 检测到下载，尝试接管：', item.url);
  // 先尝试把链接交给 App；成功才取消浏览器默认下载，避免 App 未运行时误伤。
  sendToLeleDownload(item.url).then((res) => {
    if (res.ok) {
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
    if (h.includes('xunlei')) return 'xunlei';
    if (h.includes('123pan') || h.includes('123912') || h.includes('123685') || h.includes('123959')) return 'pan123';
    if (h.includes('cloud.189') || h.includes('189.cn')) return 'tianyi';
    // WeTransfer：短链域 we.tl + 官方主域（含子域）。
    // 用精确匹配而不是 includes('wetransfer')，避免 weather.com / weibo.com
    // 这类含 "we" 的域名被误判成网盘链接。
    if (h === 'we.tl') return 'wetransfer';
    if (h === 'wetransfer.com' || h.endsWith('.wetransfer.com')) return 'wetransfer';
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
      // 暴露 HTTP 状态码（不可枚举，避免污染 for-in / JSON.stringify 输出），
      // 让 WeTransfer 解析器能区分「服务端 500 + 空响应」与「分享内真的没文件」。
      // 其他调用方无需感知。
      if (parsed && typeof parsed === 'object') {
        try { Object.defineProperty(parsed, '_status', { value: res.status, enumerable: false, configurable: true, writable: true }); }
        catch (_) { /* ignore */ }
      }
      return parsed;
    }
    catch (_) {
      // 把 endpoint + statusText 带进去，便于定位是哪个端点 / 是否 410 Gone（分享被撤回）
      const st = (res.statusText || '').trim();
      const tag = st ? ' [' + st + ']' : '';
      const body = (text || '').slice(0, 300);
      throw new Error('[HTTP ' + res.status + tag + '] ' + url + ' 非 JSON 响应: ' + body);
    }
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

// 123云盘（r12 重写，参考 netdisk-resolver-v1.4 / alist 123_share 驱动）：
// - 端点已迁移：原 www.123pan.com/api/share/get 已 404，新端点是 https://yun.123pan.cn/b/api/...
// - 所有请求必须带 signPath 签名查询参数（?timeSign=<timestamp>-<random>-<dataSign>），
//   否则服务端返 210/2100/signature invalid。签名算法：CRC32(IEEE) + 一张 26 字母映射表。
// - /share/get 是 GET（不是 POST），/share/download/info 是 POST（body 用小写字段）。
// - 响应结构：data.InfoList[]（不是 data.fileList.data），字段 FileId/FileName/Type/Size/S3KeyFlag/Etag，
//   Type=1 为文件夹、Type=0 为文件；下载 URL 在另一接口 /share/download/info 取，
//   且 DownloadURL 是 `?params=base64(真直链)` 的二次包装，默认 auto_redirect=0 会返 210 JSON 壳，
//   必须改 auto_redirect=1 才能让 CDN 直接输出文件流。
// 诊断 body 加 build=r21 标签，便于真机复测时定位。
// r14 修复：r13 硬编码 code=5112 → 分享方限制是错的（5112 也用于"未登录/付费"拦截）。
// 现按 message 关键词判断（分享方流量包/用户登录付费/链接失效/提取码/兜底），
// 删掉硬编码 code 匹配，避免误判。同时把"提取"歧义词改为更精确的"提取码"。
// r15 增强：123 已取消免登录下载 → 新增登录态注入（getPan123Token/readPan123Token，
// 注入 www.123pan.com localStorage 拿 Authorization Bearer token），download/info 返
// 5112 未登录时强制刷新登录态重试一次。
// r16 修正：实测多个公开分享后发现「分享方提取流量包不足」= 分享方未给游客开放提取流量
// （guest-share-free-download-cdn 域名实锤游客可下，但分享方可选是否开放），登录用户/会员
// 很可能可下 → 「流量包/提取次数」同样触发登录态重试 + helper 提示改为引导登录。
const PAN123_API_BASE = 'https://yun.123pan.cn/b/api';
const PAN123_SIGN_TABLE = [
  'a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i',
  'j', 'n', 'o', 'p', 'k', 'q', 'r', 's', 't', 'u',
  'b', 'c', 'v', 'w', 's', 'z',
];

// 与 netdisk-resolver-v1.4 pan123/api.py sign_path 一致：CRC32(IEEE) → 无符号 32 位。
function pan123Crc32IEEE(buf) {
  // 在 SW context 中没有 zlib，使用手工 CRC32-IEEE 表（与 Go / Python zlib.crc32 一致）。
  // 用全局缓冲的 256 项表提高速度；多线程安全（SW 单线程）。
  if (!pan123Crc32IEEE._t) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    pan123Crc32IEEE._t = t;
  }
  const t = pan123Crc32IEEE._t;
  let c = 0xFFFFFFFF;
  // 把 string 当 UTF-8 字节序列处理（与 Python bytes.encode('utf-8') 一致）
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : buf;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 生成 123云盘请求签名，返回 [timeSign, fullSign]，调用方把 timeSign 作为查询参数名、
// fullSign 作为查询参数值，附加到 URL（参见 alist / netdisk-resolver-v1.4）。
function pan123SignPath(path, os /* web */ , version /* 3 */ ) {
  const rand = String(Math.round(Math.random() * 1e7));
  // CST (+08:00) 当前时间戳
  const now = new Date();
  const cstMs = now.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const Y = cst.getUTCFullYear();
  const M = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const D = String(cst.getUTCDate()).padStart(2, '0');
  const h = String(cst.getUTCHours()).padStart(2, '0');
  const m = String(cst.getUTCMinutes()).padStart(2, '0');
  const nowStr = '' + Y + M + D + h + m;  // YYYYMMDDHHMM（12 位）
  let mapped = '';
  for (const ch of nowStr) mapped += PAN123_SIGN_TABLE[Number(ch)];
  const timeSign = String(pan123Crc32IEEE(mapped));
  const ts = String(Math.floor(cstMs / 1000));
  const data = [ts, rand, path, os || 'web', version || '3', timeSign].join('|');
  const dataSign = String(pan123Crc32IEEE(data));
  return [timeSign, ts + '-' + rand + '-' + dataSign];
}

// 构造带签名的完整 URL：base + path + ?<timeSign>=<ts-rand-dataSign>&<其它查询参数>
function pan123SignedUrl(path, params) {
  const qs = Object.assign({}, params || {});
  const keyVal = pan123SignPath(path);
  qs[keyVal[0]] = keyVal[1];
  const url = new URL(PAN123_API_BASE + path);
  for (const k of Object.keys(qs)) url.searchParams.set(k, qs[k]);
  return url.toString();
}

// 把 123 服务端业务错误翻译成用户可读提示（区分分享方限制/用户未登录/链接失效/提取码/其他）。
// 参考返回值形如 { code:5112, message:'…' }，字段名是 message。
// 关键：code 不是稳定语义（如 5112 既可能是分享方流量包耗尽，也可能是用户未登录付费），
// 必须按 message 关键词判断，不能硬编码 code→语义。
// 端点错误或网络错误（非 code 业务错）不归本函数，由 fetchJson 抛 HTTP 错误。
// 加 ⛔ 前缀让"平台业务层限制"在 UI 里一眼可见，避免用户误以为是下载器 bug。
function pan123BusinessError(ctx, code, msg) {
  const m = String(msg || '').trim();
  const low = m.toLowerCase();
  let label = '业务层限制';
  let hint = '';
  // 当前用户未登录 / 未付费（解法：登录 123 或开会员；r12 SW 匿名 fetch 触发的就是这种）
  if (m.indexOf('登录') >= 0 || m.indexOf('注册') >= 0 || m.indexOf('付费') >= 0
      || m.indexOf('会员') >= 0 || low.indexOf('vip') >= 0 || low.indexOf('login') >= 0 || low.indexOf('pay') >= 0) {
    label = '当前用户未登录或非会员';
    hint = '该分享需要登录 123 账号或开通会员后才能下载，请在浏览器登录 pan.xunlei.com / yun.123pan.cn 后重试';
  }
  // 分享未向游客开放提取流量（解法：登录 123，会员更佳；实测 5112 流量包 = 游客被拦，登录可能可下）
  else if (m.indexOf('流量包') >= 0 || m.indexOf('提取次数') >= 0) {
    label = '分享未向游客开放提取流量';
    hint = '请登录 123 账号（会员更佳）后重试；若登录后仍失败，才是分享方主动关闭了提取，需请对方重新分享';
  }
  // 链接失效
  else if (m.indexOf('不存在') >= 0 || m.indexOf('失效') >= 0 || low.indexOf('expired') >= 0 || low.indexOf('not found') >= 0) {
    label = '分享不存在或已失效';
  }
  // 提取码
  else if (m.indexOf('密码') >= 0 || m.indexOf('提取码') >= 0 || low.indexOf('pwd') >= 0 || low.indexOf('password') >= 0) {
    label = '提取码错误/需要';
  }
  const tail = hint ? '（' + hint + '）' : '';
  return '⛔ 123云盘' + label + '（' + ctx + '）：' + (m || ('code=' + code)) + tail + (code ? ' [错误码 ' + code + ']' : '');
}

// 123 下载 URL 二次包装：DownloadURL 通常是 `https://wp.imgapi.com/...?params=base64(真直链)`，
// 需要把 params base64 解码得到真 CDN 直链，并改 auto_redirect=0→1。
function pan123NormalizeDownloadUrl(u) {
  if (!u) return u;
  try {
    const m = String(u).match(/[?&]auto_redirect=0/);
    if (m) return u.replace(/([?&])auto_redirect=0/, '$1auto_redirect=1');
  } catch (_) {}
  return u;
}

function pan123DecodeParamsUrl(u) {
  if (!u) return u;
  try {
    const idx = u.indexOf('params=');
    if (idx < 0) return pan123NormalizeDownloadUrl(u);
    const tail = u.slice(idx + 'params='.length);
    // params 可能是最后一段 query（被 & 截断的 base64），取直到下一个 & 或字符串末尾
    const amp = tail.indexOf('&');
    const b64 = amp < 0 ? tail : tail.slice(0, amp);
    let decoded = '';
    try { decoded = decodeURIComponent(b64); } catch (_) { decoded = b64; }
    // base64 → utf-8（与 Python base64.b64decode().decode('utf-8', 'ignore') 一致）
    let inner = '';
    try {
      const bin = atob(decoded.replace(/-/g, '+').replace(/_/g, '/'));
      // 容错：atob 对非 utf-8 字节序列静默截断（与 'ignore' 语义相近）
      inner = bin;
    } catch (_) {
      // base64 解码失败 → 回退原 URL
      return pan123NormalizeDownloadUrl(u);
    }
    if (typeof inner === 'string' && inner.startsWith('http')) {
      return pan123NormalizeDownloadUrl(inner);
    }
  } catch (_) {}
  return pan123NormalizeDownloadUrl(u);
}

// ================= 123云盘 登录态注入（Authorization token）=================
// 123 平台政策变更（2026-08 起）：取消免登录下载，游客必须注册/登录/付费才能取直链，
// 否则 download/info 返 code=5112「您需要注册登录或付费后下载」。
// web 端登录态 = www.123pan.com localStorage 里的 JWT token，请求头带
// `Authorization: Bearer <token>` 即可。key 探测参考 dmhy123 油猴脚本：
//   直接 key：authorToken / token / accessToken；JSON key：userInfo / user_info /
//   loginInfo / login_info / user（对象内递归找 token 字段），token 长度 > 50 才可信。
// 与阿里云盘方案同构：优先注入已打开的 123 标签页，无则临时开后台标签页读后关闭。
let _pan123Token = '';
let _pan123TokenAt = 0;        // 获取成功时间
let _pan123TokenFailedAt = 0;  // 获取失败时间（短时间不重复开标签页）

// 页面上下文注入：探测 localStorage 中的 123 token（永不 throw，返回结构化结果）
// r17 增强：① 已知 key 探测（authorToken/token/accessToken/panLoginToken + JSON 递归）
// ② 兜底遍历全部 localStorage entries 找 JWT 格式值（xxx.yyy.zzz 三段 base64url），
// 抓未知 key 名的 token——123 前端改版时 key 可能变化，JWT 格式检测更稳。
function readPan123Token() {
  try {
    const isUsable = (t) => typeof t === 'string' && t.trim().length > 50;
    // JWT 格式：三段点分 base64url（123 的 Authorization Bearer token 是 JWT）
    const isJwt = (t) => typeof t === 'string'
      && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t.trim())
      && t.trim().length > 50;
    const directKeys = ['authorToken', 'token', 'accessToken', 'panLoginToken'];
    for (const k of directKeys) {
      const v = localStorage.getItem(k);
      if (isJwt(v)) return { ok: true, value: v.trim() };
      if (isUsable(v)) return { ok: true, value: v.trim() };
    }
    const jsonKeys = ['userInfo', 'user_info', 'loginInfo', 'login_info', 'user', 'userInfoV2'];
    const findTok = (obj, depth) => {
      if (!obj || depth > 4) return null;
      if (typeof obj === 'string') return isUsable(obj) ? obj : null;
      if (typeof obj !== 'object') return null;
      for (const k of ['authorToken', 'token', 'accessToken', 'jwt', 'token_info', 'loginToken']) {
        if (isUsable(obj[k])) return obj[k];
      }
      for (const k of Object.keys(obj)) {
        const r = findTok(obj[k], depth + 1);
        if (r) return r;
      }
      return null;
    };
    for (const k of jsonKeys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const tok = findTok(JSON.parse(raw), 0);
        if (tok) return { ok: true, value: String(tok).trim() };
      } catch (_) {}
    }
    // 兜底：遍历全部 localStorage entries 抓 JWT 格式值（未知 key 名的 token）
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const v = localStorage.getItem(k);
      if (isJwt(v)) return { ok: true, value: v.trim() };
      if (v && v.charAt(0) === '{') {
        try {
          const tok = findTok(JSON.parse(v), 0);
          if (tok) return { ok: true, value: String(tok).trim() };
        } catch (_) {}
      }
    }
    return { ok: false, step: 'no-token', reason: 'localStorage 无可用 token（可能未登录 123，或 token 存于 HttpOnly cookie）' };
  } catch (err) {
    return { ok: false, step: 'exception', reason: String(err) };
  }
}

// 找出所有已打开的 123 标签页（token 可能在 www.123pan.com 或 yun.123pan.cn 任一域）
async function getPan123PageTabs() {
  try {
    const all = [];
    for (const pat of ['https://www.123pan.com/*', 'https://123pan.com/*', 'https://yun.123pan.cn/*']) {
      const tabs = await chrome.tabs.query({ url: [pat] });
      if (tabs && tabs.length) all.push(...tabs);
    }
    return all;
  } catch (_) { return []; }
}

// 协调获取 123 token：
//   1) 内存缓存（10 分钟内有效）
//   2) 优先复用已打开的 123 标签页（逐个注入，直到读到 token）
//   3) 无则临时开一个后台标签页注入后立即关闭
//   4) 兜底 chrome.storage.local.pan123_token（用户手动配置）
// 永不抛错，失败返回 ''。
async function getPan123Token(forceRefresh) {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
    return _pan123Token || '';
  }
  const now = Date.now();
  if (!forceRefresh && _pan123Token && now - _pan123TokenAt < 10 * 60 * 1000) return _pan123Token;
  if (!forceRefresh && !_pan123Token && _pan123TokenFailedAt && now - _pan123TokenFailedAt < 60 * 1000) return '';
  let tempTabId = null;
  try {
    // r17：依次注入所有已打开的 123 标签页（token 可能只存在于其中一个域）
    let tabs = await getPan123PageTabs();
    if (!tabs.length) {
      const created = await chrome.tabs.create({ url: 'https://www.123pan.com/', active: false });
      tempTabId = created;
      tabs = [created];
      await waitTabComplete(created.id);
    }
    // 等 SPA 稳定，避免注入时页面仍在跳转导致执行上下文被销毁（表现为 result:null）
    await new Promise((r) => setTimeout(r, 1200));
    for (const tab of tabs) {
      if (!tab || tab.id == null) continue;
      try {
        for (let i = 0; i < 2; i++) {
          const inj = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPan123Token });
          const r = inj && inj[0] && inj[0].result;
          if (r && r.ok && r.value) {
            _pan123Token = r.value;
            _pan123TokenAt = now;
            return r.value;
          }
          console.log('[123] readPan123Token tab', tab.id, 'attempt', i, '=', JSON.stringify(r));
        }
      } catch (e) {
        console.log('[123] inject tab', tab.id, 'error:', String((e && e.message) || e));
      }
    }
  } catch (e) {
    console.log('[123] getPan123Token error:', String((e && e.message) || e));
  } finally {
    if (tempTabId != null) {
      try { await chrome.tabs.remove(tempTabId.id); } catch (_) {}
    }
  }
  // 兜底：用户手动配置的 token
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const stored = await new Promise((res) => {
        try {
          chrome.storage.local.get(['pan123_token'], (rr) => res((rr && rr.pan123_token) || ''));
        } catch (_) { res(''); }
      });
      if (stored) { _pan123Token = stored; _pan123TokenAt = now; return stored; }
    }
  } catch (_) {}
  _pan123TokenFailedAt = now;
  return '';
}

// 123云盘主解析器：列分享（含子目录递归）→ 逐文件取 download/info 解码出真直链。
// 出错统一抛 Error（含 build=r21 标记）；不返回部分结果。
async function resolvePan123(url, pwd) {
  const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const shareKey = m ? m[1] : '';
  if (!shareKey) throw new Error('无法从链接提取 123云盘分享 Key');
  // r14+：123 取消免登录下载，尝试注入 www.123pan.com 登录态（Authorization Bearer token）。
  // 拿不到也没关系：列文件匿名可读，仅 download/info 取直链时需要登录，失败时下面会重试。
  let token = await getPan123Token();
  let authRetried = false;
  const BASE_HDR = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://yun.123pan.cn',
    'Referer': 'https://yun.123pan.cn/',
    'platform': 'web',
    'app-version': '3',
  };
  if (token) BASE_HDR['Authorization'] = 'Bearer ' + token;

  // 列分享（含子目录递归）：Type=1 为文件夹，Type=0 为文件。
  const MAX_DEPTH = 10;
  const allFiles = [];  // [{fileId, fileName, size, s3keyFlag, etag, path}]
  const visited = new Set();
  async function listDir(parentFileId, dirPath, depth) {
    if (depth > MAX_DEPTH) {
      console.log('[pan123] warn listDir depth > 10, truncating at', dirPath);
      return;
    }
    if (parentFileId && visited.has(String(parentFileId))) {
      console.log('[pan123] warn listDir cycle', parentFileId); return;
    }
    if (parentFileId) visited.add(String(parentFileId));
    let page = 1;
    while (true) {
      const listUrl = pan123SignedUrl('/share/get', {
        limit: '100',
        next: '0',
        orderBy: 'file_id',
        orderDirection: 'desc',
        parentFileId: String(parentFileId || 0),
        Page: String(page),
        shareKey,
        SharePwd: pwd || '',
      });
      let j;
      try { j = await fetchJson(listUrl, { method: 'GET', headers: BASE_HDR }); }
      catch (e) { throw new Error('123云盘 listDir 失败(depth=' + depth + ' page=' + page + ')：' + (e && e.message || e)); }
      if (j && j.code !== 0) {
        const msg = (j && j.message) || ('code=' + j.code);
        throw new Error(pan123BusinessError(dirPath || '根目录', j.code, msg));
      }
      const payload = (j && j.data) || {};
      const items = Array.isArray(payload.InfoList) ? payload.InfoList : [];
      for (const f of items) {
        if (!f || typeof f !== 'object') continue;
        const fid = f.FileId != null ? String(f.FileId) : (f.fileId != null ? String(f.fileId) : '');
        if (!fid) continue;
        const name = String(f.FileName || f.fileName || '');
        const type = Number(f.Type != null ? f.Type : (f.type != null ? f.type : 0));
        const size = Number(f.Size || f.size || 0) || 0;
        const s3keyFlag = String(f.S3KeyFlag || f.s3keyFlag || '');
        const etag = String(f.Etag || f.etag || '');
        const subPath = (dirPath ? dirPath + '/' : '') + name;
        if (type === 1) {
          await listDir(fid, subPath, depth + 1);
        } else {
          allFiles.push({ fileId: fid, fileName: name, size, s3keyFlag, etag, path: subPath });
        }
      }
      const nxt = String(payload.Next || '');
      if (nxt === '-1' || !items.length) break;
      page += 1;
      if (page > 50) break;  // 防御性兜底
    }
  }
  await listDir(0, '', 0);

  if (!allFiles.length) {
    throw new Error('123云盘分享内没有可下载文件（build=r21：已迁移到 yun.123pan.cn 并签名）');
  }

  // 逐文件取直链（POST /share/download/info）
  const out = [];
  for (const f of allFiles) {
    if (!f.s3keyFlag || !f.etag) {
      throw new Error('123云盘文件缺少 Etag/S3KeyFlag（build=r21）：' + f.path);
    }
    const dlUrl = pan123SignedUrl('/share/download/info');
    const dlBody = JSON.stringify({
      shareKey,
      SharePwd: pwd || '',
      etag: f.etag,
      fileId: Number(f.fileId),
      s3keyFlag: f.s3keyFlag,
      size: f.size || 0,
    });
    let dl;
    try {
      dl = await fetchJson(dlUrl, { method: 'POST', headers: BASE_HDR, body: dlBody });
    } catch (e) { throw new Error('123云盘 download/info 失败（' + f.path + '）：' + (e && e.message || e)); }
    if (dl && dl.code !== 0) {
      // r16：5112 的「未登录/付费」与「分享方提取流量包不足」都可能是游客身份拦截
      // （分享方未给游客开放提取流量，登录用户/会员可能可下）→ 强制刷新登录态重试一次。
      const msg0 = String(dl.message || '');
      const low0 = msg0.toLowerCase();
      const needLogin = msg0.indexOf('登录') >= 0 || msg0.indexOf('注册') >= 0 || msg0.indexOf('付费') >= 0
        || msg0.indexOf('会员') >= 0 || msg0.indexOf('流量包') >= 0 || msg0.indexOf('提取次数') >= 0
        || low0.indexOf('vip') >= 0 || low0.indexOf('login') >= 0 || low0.indexOf('pay') >= 0;
      if (needLogin && !authRetried) {
        authRetried = true;
        token = await getPan123Token(true);
        if (token) {
          BASE_HDR['Authorization'] = 'Bearer ' + token;
          try {
            dl = await fetchJson(dlUrl, { method: 'POST', headers: BASE_HDR, body: dlBody });
          } catch (e) { throw new Error('123云盘 download/info 失败（' + f.path + '）：' + (e && e.message || e)); }
          if (dl && dl.code !== 0) throw new Error(pan123BusinessError(f.path, dl.code, dl.message || ''));
        } else {
          throw new Error(pan123BusinessError(f.path, dl.code, dl.message || ''));
        }
      } else {
        throw new Error(pan123BusinessError(f.path, dl.code, dl.message || ''));
      }
    }
    const wrapped = (((dl || {}).data) || {}).DownloadURL || '';
    if (!wrapped) throw new Error('123云盘未返回 DownloadURL（' + f.path + '）');
    const realUrl = pan123DecodeParamsUrl(wrapped);
    if (!realUrl) throw new Error('123云盘直链解析失败（' + f.path + '）');
    out.push({
      name: f.fileName,
      size: bytesToSize(f.size),
      url: realUrl,
      headers: { Referer: 'https://yun.123pan.cn/', 'User-Agent': navigator.userAgent },
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
// 是先把分享转存(save)到自己的网盘，等转存完成(status==2)后，从 task 响应的
// `data.save_as.save_as_select_top_fids[]`（**新 fid 字符串数组**）取**新 fid** 再下载。
// 转存会生成新 fid，原始分享 fid 在自有网盘里查不到 → "file not found"；只需 cookie。
// 该数组只含 fid 字符串（不带 file_name/size），按索引与 allFiles 配对。
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
    // 4) 轮询转存任务。**新 fid 在 data.save_as.save_as_select_top_fids[]**（实测）：
    //    - 新结构：`{save_as: {save_as_select_top_fids: ["fid1","fid2"]}}` —— 只有 fid 字符串数组
    //    - 旧结构兜底：`{save_as: {save_as: [{fid,file_name,...}]}}`
    //    - 最早结构兜底：`{task_info_list: [{fid,...}]}`
    //    新 fid 列表只含 fid 无 file_name，按 allFiles 索引配对（顺序与 save 请求的 fid_list 一致）。
    let taskJson = null;
    let savedList = [];
    for (let i = 0; i < 40; i++) {
      const taskResp = await fetch(api('/task?pr=ucpro&fr=pc&task_id=' + encodeURIComponent(saveJson.data.task_id) + '&retry_index=0'), { method: 'GET', headers, credentials: 'include' });
      taskJson = await taskResp.json();
      const st = taskJson.data && taskJson.data.status;
      if (st === 2) {
        const sa = (taskJson.data && taskJson.data.save_as) || {};
        const saf = sa.save_as_select_top_fids;                       // 新结构：字符串数组
        if (Array.isArray(saf) && saf.length) {
          savedList = saf.map((fid) => ({ fid: String(fid) }));
        } else {
          savedList = sa.save_as || [];                                // 旧结构：对象数组
          if (!savedList.length) savedList = (taskJson.data && taskJson.data.task_info_list) || []; // 最旧兜底
        }
        log('task savedList count=', savedList.length, 'first=', JSON.stringify(savedList[0]));
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
    //    新结构里 savedList 是 [{fid: "..."}] 字符串数组（无 file_name），按 allFiles 索引配对
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
      log('dl', dlResp.status, JSON.stringify(dlJson).slice(0, 200));
      const arr = Array.isArray(dlJson.data) ? dlJson.data : [];
      const durl = (arr[0] && arr[0].download_url) || '';
      if (!durl) {
        out.ok = false; // 显式置 false（防御性：未来 out 初始化若改为 true，这里仍安全）
        out.step = 'download';
        out.status = dlResp.status;
        out.body = JSON.stringify(dlJson).slice(0, 300);
        out.name = src.file_name;
        return out;
      }
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

// 读取 alipan.com 登录态中的 refresh_token（页面上下文执行，注入 content-script）。
// 必须 self-contained：只用 localStorage / JSON，不得引用 SW 作用域变量；
// 整体 try/catch 永不 throw（executeScript 注入函数 throw 会被吞成 result:null，SW 无法区分错误）。
function readAliyunToken() {
  try {
    const raw = localStorage.getItem('token');
    if (!raw) {
      return { ok: false, step: 'local-storage-empty', reason: '可能未登录 alipan.com' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, step: 'json-parse', reason: String(e) };
    }
    const refreshToken = parsed.refresh_token != null ? parsed.refresh_token : parsed.refreshToken;
    if (refreshToken == null || refreshToken === '') {
      return { ok: false, step: 'field-missing', reason: 'token 中无 refresh_token' };
    }
    return { ok: true, value: String(refreshToken) };
  } catch (err) {
    return { ok: false, step: 'exception', reason: String(err) };
  }
}

// 找一个已打开的 alipan.com / aliyundrive.com 标签页；没有则返回 null（由调用方临时开一个）
async function getAliyunPageTab() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.alipan.com/*',
        'https://alipan.com/*',
        'https://www.aliyundrive.com/*',
        'https://aliyundrive.com/*',
      ],
    });
    return tabs && tabs.length ? tabs[0].id : null;
  } catch (_) {
    return null;
  }
}

// 协调获取阿里云盘 refresh_token：
//   优先复用已打开的 alipan.com 标签页注入读取登录态；
//   若无则临时开一个后台标签页，注入读取后立刻关闭（永不泄漏已打开的用户页面）；
//   兜底读 chrome.storage.local.aliyun_refresh_token（用户手动配置）。
// 本函数永不抛错，失败返回 ''。
async function getAliyunRefreshToken() {
  if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) return '';
  let tabId = null;
  let tempTabId = null;
  try {
    tabId = await getAliyunPageTab();
    if (tabId == null) {
      const created = await chrome.tabs.create({ url: 'https://www.alipan.com/', active: false });
      tempTabId = created;
      tabId = created.id;
      await waitTabComplete(created.id);
    }
    // 等 SPA 稳定，避免注入时页面仍在跳转导致执行上下文被销毁（表现为 result:null）
    await new Promise((r) => setTimeout(r, 1200));
    for (let i = 0; i < 2; i++) {
      const inj = await chrome.scripting.executeScript({ target: { tabId }, func: readAliyunToken });
      const r = inj && inj[0] && inj[0].result;
      if (r && r.ok && r.value) {
        return r.value;
      }
      console.log('[ali] readAliyunToken attempt', i, '=', JSON.stringify(r));
    }
  } catch (e) {
    console.log('[ali] getAliyunRefreshToken error:', String((e && e.message) || e));
  } finally {
    if (tempTabId != null) {
      try { await chrome.tabs.remove(tempTabId.id); } catch (_) {}
    }
  }
  // 兜底：用户手动配置
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const stored = await new Promise((res) => {
        try {
          chrome.storage.local.get(['aliyun_refresh_token'], (rr) => res((rr && rr.aliyun_refresh_token) || ''));
        } catch (_) { res(''); }
      });
      if (stored) return stored;
    }
  } catch (_) {}
  return '';
}

async function resolveAliyun(url, pwd) {
  const refreshToken = await getAliyunRefreshToken();
  if (!refreshToken) {
    throw new Error('未检测到阿里云盘 refresh_token：请先在 alipan.com 登录（扩展会自动读取登录态）；若仍失败，可在扩展存储手动配置 chrome.storage.local.set({aliyun_refresh_token:"..."})');
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

  // 列文件（分页 marker 直到取完；单次上限 200）—— 抽成 helper，供递归复用
  async function listAliyunItems(parentFileId) {
    const items = [];
    let marker = '';
    do {
      const body = {
        share_id: shareId, parent_file_id: parentFileId, limit: 200,
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
    return items;
  }

  // 递归展开子文件夹收集 file（参考百度 expandBaiduItems：MAX_DEPTH=5 防循环）
  const files = [];
  const ALIYUN_MAX_DEPTH = 5;
  async function expandAliyunItems(parentFileId, dirPath, depth) {
    if (depth >= ALIYUN_MAX_DEPTH) return;
    const items = await listAliyunItems(parentFileId);
    for (const it of items) {
      if (it && it.type === 'folder') {
        const subPath = (dirPath ? dirPath + '/' : '') + (it.name || '');
        await expandAliyunItems(it.file_id, subPath, depth + 1);
      } else if (it && it.type === 'file') {
        files.push({
          file_id: it.file_id,
          size: it.size,
          name: (dirPath ? dirPath + '/' : '') + (it.name || ''),
        });
      }
    }
  }
  try {
    await expandAliyunItems('root', '', 0);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 阿里对「API 侧无权访问的分享」常包成 410 Gone；根因多为 token 读取时机/账号不符
    if (/\[HTTP ?410/.test(msg)) {
      throw new Error('阿里 file/list 返回 410（Gone）：分享在 API 侧不可见。常见原因：\n'
        + '① 解析时 alipan.com 标签页未登录/未打开 → 扩展读到的 access_token 无权访问该分享；\n'
        + '② 该分享被设为「仅指定用户」等访问限制。\n'
        + '建议：先打开 alipan.com 并登录、保持该标签页打开，再重新解析；若仍失败，换一个分享链接。\n'
        + '原始错误：' + msg);
    }
    throw e;
  }

  if (!files.length) throw new Error('阿里分享内没有可下载文件');

  // ---- 410 转存兜底（参考 netdisk-resolver-v1.4 aliyun/resolver.py _save_and_get_url）----
  // 阿里对「未登录申请直链」或「分享禁止直接下载（版权/限速分享）」返 HTTP 410（空 body）。
  // 已登录仍 410 → 把分享文件转存到自己云盘，再从自己云盘取直链（转存会复制到网盘根目录）。
  async function aliyunTransferAndGetUrl(fileId, timeoutMs) {
    const userHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
      // 注意：用户空间接口不带 x-share-token，否则被阿里判为「分享接口需登录」而拒绝
    };
    // 1) 用户默认 drive_id
    const me = await fetchJson('https://api.alipan.com/v2/user/get', {
      method: 'POST', headers: userHeaders, body: JSON.stringify({}),
    });
    const myDriveId = me.default_drive_id;
    if (!myDriveId) throw new Error('阿里未返回默认 drive_id，无法转存（请确认已登录 alipan.com）');
    // 2) 转存分享文件到自己云盘根目录（带 x-share-token）
    const cp = await fetchJson('https://api.alipan.com/v2/file/copy', {
      method: 'POST', headers: shareHeaders,
      body: JSON.stringify({
        share_id: shareId, file_id: fileId,
        to_drive_id: myDriveId, to_parent_file_id: 'root', auto_rename: true,
      }),
    });
    const copiedDriveId = String(cp.drive_id || myDriveId);
    const copiedFileId = String(cp.file_id || '');
    if (!copiedFileId) throw new Error('阿里转存未返回 file_id：' + JSON.stringify(cp).slice(0, 200));
    // 3) 异步转存任务轮询（文件夹才异步；单文件一般同步返回）
    const taskId = String(cp.async_task_id || '');
    if (taskId) {
      const deadline = Date.now() + (timeoutMs || 30000);
      while (Date.now() < deadline) {
        const task = await fetchJson('https://api.alipan.com/v2/async_task/get', {
          method: 'POST', headers: userHeaders, body: JSON.stringify({ async_task_id: taskId }),
        });
        const state = String(task.state || '').toLowerCase();
        if (state === 'succeed' || state === 'success') break;
        if (state === 'failed' || state === 'cancel') throw new Error('阿里转存任务失败：' + String(task.message || taskId));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // 4) 从自己云盘取直链（不带 x-share-token）
    // r19：api.alipan.com 对部分文件（冷门资源/刚转存）返回 url 空，且不带 cdn_url；
    // 改用 PDS 智能域名 {domain_id}.api.aliyunpds.com 兜底（alist #6644 方案，cdn 更快）。
    const dlBody = { drive_id: copiedDriveId, file_id: copiedFileId, expire_sec: 600 };
    const dl = await fetchJson('https://api.alipan.com/v2/file/get_download_url', {
      method: 'POST', headers: userHeaders, body: JSON.stringify(dlBody),
    });
    let durl = dl.url || dl.cdn_url || dl.internal_url || dl.download_url || dl.DownloadUrl;
    if (!durl && dl.domain_id) {
      // api.alipan.com 域拿不到 → 用响应里的 domain_id 构造 PDS 域名重试
      try {
        const dl2 = await fetchJson('https://' + dl.domain_id + '.api.aliyunpds.com/v2/file/get_download_url', {
          method: 'POST', headers: userHeaders, body: JSON.stringify(dlBody),
        });
        durl = dl2.url || dl2.cdn_url || dl2.internal_url || dl2.download_url || dl2.DownloadUrl;
      } catch (_) { /* PDS 域失败则保留原错误 */ }
    }
    if (!durl) throw new Error('阿里转存后未返回直链：' + JSON.stringify(dl).slice(0, 200));
    return durl;
  }

  const out = [];
  for (const f of files) {
    let durl = '';
    let viaTransfer = false;
    try {
      const dl = await fetchJson('https://api.alipan.com/v2/file/get_share_link_download_url', {
        method: 'POST', headers: shareHeaders,
        body: JSON.stringify({ share_id: shareId, file_id: f.file_id, expire_sec: 600 }),
      });
      durl = dl.download_url || dl.url;
      if (!durl) throw new Error('阿里未返回直链：' + JSON.stringify(dl).slice(0, 200));
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/\[HTTP ?410/.test(msg)) {
        // 分享禁止直接下载（版权/限速）→ 转存到自己云盘后取直链
        durl = await aliyunTransferAndGetUrl(f.file_id);
        viaTransfer = true;
      } else {
        throw e;
      }
    }
    out.push({
      name: f.name,
      size: bytesToSize(f.size),
      url: durl,
      // 转存后的直链是自己云盘 OSS，按 aliyundrive.com Referer 签名（参考项目实测）
      headers: { Referer: viaTransfer ? 'https://www.aliyundrive.com/' : 'https://www.alipan.com/', 'User-Agent': navigator.userAgent },
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
async function baiduWxList(apiShorturl, pwd, dirPath) {
  // dirPath：百度 wxlist 的 dir 参数（绝对路径形式，如 "/book"），用于递归进文件夹；
  // 不传或空 = 根目录（root=1）。递归深度由调用方控制。
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

// bdstoken（登录令牌）：GET /api/gettemplatevariable?fields=["bdstoken"]，需登录态（BDUSS）。
// 匿名/未登录返回 errno -6 → 返回 ''（sharedownload 不带 bdstoken，功能仍可用）。
// 已登录用户带上 bdstoken 可显著降低 errno -20 风控/验证码触发概率（参考 netdisk-resolver）。
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
  const topList = await baiduWxList(apiShorturl, pwd);
  const list = topList.list;
  const uk = topList.uk;
  const shareid = topList.shareid;
  // seckey 是 URL 编码的，解码后作为 sekey 传 sharedownload（避免双重编码触发参数错误）
  const sekey = topList.seckey ? safeDecode(topList.seckey) : '';

  // 2) 令牌（tplconfig 取 sign/timestamp）
  const { sign, timestamp } = await baiduGetSign(apiShorturl);

  // r20：登录态取 bdstoken，sharedownload 带上可显著降低 errno -20 风控（登录用户有效）
  const bdstoken = await baiduGetBdstoken();

  // 直链（sharedownload）：严格对齐可工作的参考实现 netdisk-resolver
  //   params: channel=chunlei&clienttype=0&app_id=250528&sign&timestamp&web=1[&bdstoken]
  //   body:   encrypt=0&product=share&primaryid=<id>&shareid=<id>&uk=<uk>&fid_list=[fs_id](紧凑JSON)&extra={"sekey":<seckey>}
  //   headers: Referer=share/link?shareid=<id>&uk=<uk> + X-Requested-With
  // wxlist 返回的 seckey 即带密分享的验证令牌，无需先 /share/verify；
  // 仅当返回 errno 9019 needverify 时才补 verify（取 BDCLND 桥接进 cookie jar）并用 randsk 重试。
  const out = [];
  let triedVerify = false;
  let lastRandsk = '';
  const MAX_DEPTH = 5; // 防无限嵌套（分享循环引用/极深结构）

  // 把单个 wxlist items 展开为可加入下载的文件（folder 递归展开）：
  // - 文件（type==='file' 或 isdir===0）：走 sharedownload 拿 dlink 后 push
  // - 文件夹（type==='folder' 或 isdir===1）：递归调 baiduWxList 取其 dir 子项并平铺
  async function expandBaiduItems(items, dirPath, depth) {
    if (!items || !items.length) return;
    if (depth > MAX_DEPTH) {
      throw new Error('百度分享嵌套层级超过 ' + MAX_DEPTH + '（疑似循环引用，请用浏览器打开该分享核对）');
    }
    for (const f of items) {
      const isFolder = (f.type === 'folder') || (f.isdir === 1) || (f.isdir === '1') || (f.type === 1) || (f.type === '1');
      if (isFolder) {
        // 文件夹：递归。folder path 字段形如 '/书荒来看'，作下层 dir 传给 wxlist
        const subPath = (typeof f.path === 'string' && f.path) ? f.path : (dirPath + '/' + (f.server_filename || f.filename || ''));
        const sub = await baiduWxList(apiShorturl, pwd, subPath);
        await expandBaiduItems(sub.list, subPath, depth + 1);
        continue;
      }
      // 普通文件：原 sharedownload 流程拿 dlink
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
        if (dl) {
          // 百度 sharedownload 的 dlink 字段常常只返回相对路径（如 '/rest/2.0/pcs/file?...'），
          // 必须拼上 https://d.pcs.baidu.com 才是完整直链；带 scheme 则原样保留。
          if (/^https?:\/\//i.test(dl)) {
            dlink = dl;
          } else {
            dlink = 'https://d.pcs.baidu.com' + (dl.startsWith('/') ? dl : '/' + dl);
          }
          break;
        }
        // 没拿到 dlink：构建用户友好的错误文案
        // 1) 优先把百度显式的 show_msg/errmsg 提到前面（用户第一眼能看到真实原因）
        // 2) errno -20 是百度风控（触发验证码），附上专项引导（r20：提示登录可降低风控）
        // 3) r21：errno 0 但 list 是字符串 = 百度「跳端下载」限制（web 端不给 dlink，需 PC 客户端）
        const serverMsg = sd.show_msg || sd.errmsg || '';
        const enPart = (typeof en !== 'undefined' && en !== '') ? ('errno ' + en) : '无 errno';
        const isJumpToClient = (en === 0) && (typeof sd.list === 'string' && sd.list.length > 0);
        const hint = isJumpToClient
          ? '（百度限制该文件在网页端直接下载（返回 list:string 跳端下载指令，官方要求跳转 PC 客户端）。建议：换一个分享链接；或直接在浏览器打开该分享并用百度网盘客户端下载）'
          : ((en === -20)
            ? '（百度判定触发风控/验证码。建议：若已登录百度网盘账号会显著降低风控；未登录请先在浏览器手动打开一次该分享链接并按提示完成验证，等几分钟后回 LeleDownload 再解析）'
            : '');
        throw new Error(
          '百度接口提示：' + (serverMsg || (isJumpToClient ? '该文件被限制网页端直接下载' : '未返回 dlink')) +
          '（' + enPart + '）（uk=' + uk + ', shareid=' + shareid + ', fs_id=' + f.fs_id + '）' +
          hint + '。原始响应：' + JSON.stringify(sd).slice(0, 200)
        );
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

// 迅雷云盘（pan.xunlei.com）分享解析 —— 必须在 pan.xunlei.com 页面上下文执行。
// 为什么必须注入页面（而非 SW 直发）：
//   1) 迅雷每个请求都要 x-captcha-token（无感验证码，WASM 生成，无法在 SW 里伪造）；
//      但网页版会把 captcha token 与登录态存进 localStorage（greasyfork「迅雷云盘」脚本
//      证实）：`credentials*` 前缀 key 存 {token_type, access_token}、`captcha*` 前缀 key
//      存 {token}、`deviceid` key 存设备 ID。注入已登录的 pan.xunlei.com 页面即可全部复用。
//   2) api-pan.xunlei.com 的 CORS 依赖页面同源上下文；页面 fetch 自动带登录 cookie。
// 链路（与 AList xunlei 驱动 / urldb / 52pojie 逆向一致）：
//   1) GET  /drive/v1/share?share_id=<id>&pass_code=<pwd>&limit=100
//        -> {data:{...share_info..., pass_code_token, files:[{id,name,size?,kind?}]}}（files 含根目录）
//   2) GET  /drive/v1/share?share_id=<id>&pass_code_token=&parent_id=&page_token=&limit=100
//        -> {data:{files:[{id,name,size?,kind?}], next_page_token?}}（递归子目录，folder 继续下钻）
//        关键：web 端不支持 POST /share/detail（返 error_code:12 "Method Not Allowed"），
//        仅 android client SDK 开放，extension 注入必须用 GET + parent_id 翻页。
//        详见 https://github.com/ctwj/urldb/blob/v1.5.5/common/xunlei_pan.go GetShareFolder（POST）
//        对应 web 端真实实现 = getShare（GET ?parent_id=&page_token=）。
//        ⚠️ 字段名陷阱：GET /share 的 files 元素用 **`id`**（不是 file_id）。
//        POST /share/detail 才用 file_id。代码统一 `f.id || f.file_id` 兜底兼容。
//   3) GET  /drive/v1/files/<file_id>?space=&usage=CONSUME
//        -> {data:{web_content_link? / links:{"application/octet-stream":{url}}}}（下载直链）
// 错误码：body 含 PASS_CODE_EMPTY=需提取码/码错；NOT_FOUND/EXPIRED/SENSITIVE_RESOURCE=失效。
// 永远返回结构化对象 {ok, step, status, body, files}，绝不抛出（throw 会被吞成 result:null）。
async function xunleiApiFetch(shareId, pwd) {
  const log = (...a) => console.log('[xunlei-inject]', ...a);
  const out = { ok: false };
  const API = 'https://api-pan.xunlei.com/drive/v1';
  try {
    // ---- 收集页面 localStorage 里的登录态 token（greasyfork 迅雷云盘脚本同款逻辑）----
    let accessToken = '';
    let clientId = '';
    let captchaToken = '';
    let deviceId = '';
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        if (key.indexOf('credentials') === 0) {
          try {
            const p = JSON.parse(raw);
            accessToken = (p.token_type ? p.token_type + ' ' : 'Bearer ') + (p.access_token || '');
            clientId = key.substring(key.indexOf('_') + 1) || '';
          } catch (_) {}
        } else if (key.indexOf('captcha') === 0) {
          try {
            const p = JSON.parse(raw);
            captchaToken = p.token || p.captcha_token || '';
          } catch (_) { captchaToken = raw; }
        } else if (key === 'deviceid') {
          deviceId = raw;
        }
      }
    } catch (e) { log('localStorage scan err', String(e)); }
    log('tokens: at=', !!accessToken, 'cid=', !!clientId, 'captcha=', !!captchaToken, 'dev=', !!deviceId);

    // 统一请求头：x-client-id / x-device-id 必须存在，否则 400
    const baseHeaders = {
      'Content-Type': 'application/json',
      'Origin': 'https://pan.xunlei.com',
      'Referer': 'https://pan.xunlei.com/',
      'x-client-id': clientId || 'Xqp0kJBXWhwaTpB6',
      'x-device-id': deviceId || '',
      'x-captcha-token': captchaToken || '',
    };
    if (accessToken) baseHeaders.Authorization = accessToken;
    const authHeaders = Object.assign({}, baseHeaders, { 'x-captcha-token': captchaToken || '' });

    // 1) 分享信息（仅快速验证 + 拿 pass_code_token；完整 root listing 在 listShareDir 内做，避免重复请求）
    const shareQs = '?share_id=' + encodeURIComponent(shareId)
      + (pwd ? '&pass_code=' + encodeURIComponent(pwd) : '')
      + '&limit=100';
    let shareJson, shareResp;
    try {
      shareResp = await fetch(API + '/share' + shareQs, { method: 'GET', headers: authHeaders, credentials: 'include' });
      shareJson = await shareResp.json();
      log('share', shareResp.status, JSON.stringify(shareJson).slice(0, 500));
      if (shareResp.status !== 200) {
        out.step = 'share'; out.status = shareResp.status; out.body = JSON.stringify(shareJson).slice(0, 300); return out;
      }
    } catch (e) {
      out.step = 'share'; out.status = 0; out.body = '请求异常:' + String((e && e.message) || e); return out;
    }
    const sBody = JSON.stringify(shareJson);
    if (sBody.indexOf('PASS_CODE_EMPTY') >= 0) {
      out.step = 'passcode'; out.status = 200; out.body = '分享需要提取码，或提取码不正确（PASS_CODE_EMPTY）'; return out;
    }
    if (sBody.indexOf('NOT_FOUND') >= 0 || sBody.indexOf('EXPIRED') >= 0 || sBody.indexOf('SENSITIVE_RESOURCE') >= 0) {
      out.step = 'share'; out.status = 200; out.body = '分享已失效或被删除（' + sBody.slice(0, 200) + '）'; return out;
    }
    const sd = shareJson.data || shareJson;
    let passCodeToken = sd.pass_code_token || '';  // 用 let：listShareDir 内部会更新为下一层响应里的更准确 pass_code_token
    log('pass_code_token=', passCodeToken ? '***' : '(空)');
    // 诊断日志：dump sd 的 schema（字段名 + 长度），便于排查"files 字段在哪"
    try {
      const keys = Object.keys(sd || {});
      const filesArr = sd.files || sd.file_list || sd.fileInfoList || [];
      log('sd keys=', keys.join(','), 'files.length=', filesArr.length, 'first file keys=', filesArr[0] ? Object.keys(filesArr[0]).join(',') : '(空)');
    } catch (e) { log('diag dump err', String(e)); }

    // 2) 递归列分享内部所有文件（无副作用 / 不转存全部）。
    //    用 /share/detail?parent_id=<folder.id> 列 folder 实际子文件，
    //    而非 /share?parent_id=...（那个返回 self-ref，server 无视 parent_id）。
    //    参考 netdisk-resolver-v1.4 xunlei_dl_probe.json 抓包实证：
    //    root 用 /share，子目录用 /share/detail?parent_id=...。
    //    listShareDir('', ...) 内会调 /share root，传入 useRootData=sd 避免重复请求；
//    但本轮主流程只调用 1 次 /share 用于快速验证（401/NOT_FOUND/PASS_CODE），完整列文件已在 listShareDir。
    const allFiles = [];   // 每项 { share_file_id, name, size }
    let firstResp = null;  // 诊断 dump 共用引用（首次列目录时写入）

    // 文件夹识别：优先用 kind 显式标记（share 与 /files 端点统一用 drive#folder / drive#file）。
    // 关键坑：迅雷 /files 接口给「文件」也带 folder_type（如 "DEFAULT"），
    // 旧逻辑用 folder_type.length>0 直接判文件夹，会把视频/文档误判成文件夹→递归查子目录为空→丢文件。
    // 因此 folder_type 仅作辅助，且要求该 entry 没有 mime_type（文件必有 mime_type，文件夹通常没有）。
    function detectIsFolder(f) {
      if (!f || typeof f !== 'object') return false;
      if (f.kind === 'drive#folder' || f.kind === 'folder' || f.kind === 'FOLDER') return true;
      if (f.kind === 'drive#file' || f.kind === 'file') return false;
      if (f.type === 1 || f.type === '1' || f.type === 'folder' || f.type === 'FOLDER') return true;
      if (f.type === 0 || f.type === '0' || f.type === 'file') return false;
      if (f.isdir === 1 || f.isdir === '1' || f.isdir === true) return true;
      if (f.is_dir === 1 || f.is_dir === '1' || f.is_dir === true) return true;
      if (typeof f.folder_type === 'string' && f.folder_type.length > 0 && !f.mime_type) return true;
      if (f.phase === 'folder' || f.phase === 'FOLDER') return true;
      if (typeof f.mime_type === 'string' && f.mime_type.indexOf('folder') >= 0) return true;
      return false;
    }

    const truncatedPaths = []; // MAX_DEPTH 截断的路径，用于错误提示
    const visitedShareIds = new Set();
    async function listShareDir(parentId, dirPath, depth, useExistingData) {
      if (depth > 10) {
        log('warn listShareDir depth > 10, truncating at', dirPath);
        truncatedPaths.push(dirPath);
        return;
      }
      if (parentId && visitedShareIds.has(parentId)) {
        log('warn listShareDir cycle', parentId); return;
      }
      if (parentId) visitedShareIds.add(parentId);
      const isRoot = !parentId;
      let pageToken = '';
      for (;;) {
        let j, rawText, r;
        if (useExistingData && isRoot) {
          // 主流程已调过 /share 验证 + 拿 pct，复用其 body，节省一次请求
          j = useExistingData;
          r = { status: 200 };
          rawText = JSON.stringify(j);
          useExistingData = null; // 仅首次复用
        } else {
          const qs = '?share_id=' + encodeURIComponent(shareId)
            + (pwd ? '&pass_code=' + encodeURIComponent(pwd) : '')
            + (passCodeToken ? '&pass_code_token=' + encodeURIComponent(passCodeToken) : '')
            + (parentId ? '&parent_id=' + encodeURIComponent(parentId) : '')
            + '&limit=30&keyword=&page_token=' + encodeURIComponent(pageToken)
            + '&scene=NORMAL&order=DEFAULT_ORDER&thumbnail_size=SIZE_SMALL';
          const url = API + (isRoot ? '/share' : '/share/detail') + qs;
          try {
            r = await fetch(url, { method: 'GET', headers: authHeaders, credentials: 'include' });
            rawText = await r.text();
            try { j = JSON.parse(rawText); } catch (_) { j = { _raw: rawText.slice(0, 200) }; }
            if (r.status !== 200) { out.step = isRoot ? 'listroot' : 'listdir'; out.status = r.status; out.body = JSON.stringify(j).slice(0, 300); return; }
          } catch (e) { out.step = isRoot ? 'listroot' : 'listdir'; out.status = 0; out.body = '列分享异常:' + String((e && e.message) || e); return; }
        }
        // 该层响应可能返回新的 pass_code_token（首次 root 必有），更新供下一层用
        if (j && j.pass_code_token) passCodeToken = j.pass_code_token;
        // 顶级分享 schema：files 在顶层；详细：files 也在顶层（实测抓包）
        const files = Array.isArray(j.files) ? j.files : (j.data && Array.isArray(j.data.files) ? j.data.files : []);
        let dcount = 0, fcount = 0;
        for (const f of files) {
          const fid = f.id || f.file_id || '';
          const isFolder = detectIsFolder(f);
          if (isFolder) dcount++; else fcount++;
          const subPath = (dirPath ? dirPath + '/' : '') + (f.name || f.file_name || '');
          if (isFolder && fid) {
            await listShareDir(fid, subPath, depth + 1, null);
          } else if (fid) {
            allFiles.push({ share_file_id: fid, name: subPath || f.name, size: f.size || 0 });
          } else {
            log('WARN entry 缺 fid', JSON.stringify(f).slice(0, 200));
          }
        }
        if (!firstResp) {
          firstResp = {
            url: (isRoot ? '/share' : '/share/detail') + ' (root listing reused, original URL was ' + shareQs + ')',
            status: r.status, body: rawText.slice(0, 1200), fullText: rawText,
            mode: isRoot ? 'LIST_SHARE_ROOT' : 'LIST_SHARE_DETAIL',
            folderCnt: dcount, fileCnt: fcount,
          };
        }
        pageToken = j.next_page_token || j.data?.next_page_token || '';
        if (!pageToken) break;
      }
    }
    log('listShareDir begin root');
    await listShareDir('', '', 0, sd);
    log('listShareDir done, allFiles.length=', allFiles.length);

    // 诊断：无文件时给出可定位信息（含列目录现场 + 截断深度）
    if (!allFiles.length) {
      const diagKeys = Object.keys(sd || {}).join(',') || '(sd 空)';
      const rootFiles = sd.files || [];
      const firstFileKeys = rootFiles[0] ? Object.keys(rootFiles[0]).join(',') : '无 rootFiles';
      const ldMode = firstResp ? (firstResp.mode || '-') : '-';
      const ldUrl = firstResp ? firstResp.url : '(未调用列目录)';
      const ldStatus = firstResp ? firstResp.status : '-';
      const ldBody = firstResp ? firstResp.body : '-';
      // 用完整响应文本反解 files 数量（不解析被截断的 1200B，避免误报 parse-err）
      let ldFilesLen = '-';
      const ldFull = firstResp ? firstResp.fullText : '';
      if (ldFull) {
        try { const pj = JSON.parse(ldFull); ldFilesLen = (pj.files || (pj.data && pj.data.files) || []).length; } catch (_) { ldFilesLen = 'JSON解析失败(响应非合法JSON)'; }
      }
      const ldFolderCnt = firstResp && firstResp.folderCnt !== undefined ? firstResp.folderCnt : '-';
      const ldFileCnt = firstResp && firstResp.fileCnt !== undefined ? firstResp.fileCnt : '-';
      out.step = 'detail'; out.status = 200;
      out.body = '分享内没有可下载文件。诊断(build=r11，参考 netdisk-resolver 改用 /share + /share/detail)：\n'
        + '① sd 字段=[' + diagKeys + ']\n'
        + '② rootFiles.length=' + (rootFiles.length) + '；first file keys=[' + firstFileKeys + ']\n'
        + '③ 已尝试：根目录 /share 列出 → 子目录 /share/detail 递归下钻，不做整份转存。\n'
        + '④ 列目录现场=' + ldMode + '  status=' + ldStatus + '  URL=' + ldUrl + '\n'
        + '⑤ 列目录响应 body（前 1200B）=' + ldBody + '\n'
        + '⑥ 该响应内：files.length=' + ldFilesLen + '；其中 folder 数=' + ldFolderCnt + '，file 数=' + ldFileCnt + '。\n'
        + '   folder 数≥1 但 file 数=0：可能 folder 嵌套超过 10 层，已在 truncatedPaths 标记；\n'
        + '   → 若 file 数≥1 但本错误仍出现：说明 download 链路（/share/file_info 或 restore 兜底）有 bug，截图发我。';
      return out;
    }
    log('files=', allFiles.length);

    // 3) 逐文件取下载直链：fast path 用 /share/file_info（无副作用、不污染网盘），
    //    失败回退到「单文件转 + /files/{id} 不带 usage=CONSUME」取 web_content_link。
    //    关键事实：从 netdisk-resolver-v1.4 的 xunlei_dl_probe.json 抓包看，
    //    /share/file_info 返回顶层或 file_info.web_content_link；若空就回退 restore。
    const files = [];
    const restoredIds = []; // best-effort 清理记录
    for (const f of allFiles) {
      let durl = '';
      let lastErr = '';
      let attemptMode = '';

      // 3a) Fast path: /share/file_info?file_id=...&share_id=...&pass_code_token=...
      try {
        const fiQs = '?share_id=' + encodeURIComponent(shareId)
          + (pwd ? '&pass_code=' + encodeURIComponent(pwd) : '')
          + (passCodeToken ? '&pass_code_token=' + encodeURIComponent(passCodeToken) : '')
          + '&file_id=' + encodeURIComponent(f.share_file_id)
          + '&limit=30&scene=NORMAL&thumbnail_size=SIZE_SMALL';
        const fiResp = await fetch(API + '/share/file_info' + fiQs, { method: 'GET', headers: authHeaders, credentials: 'include' });
        const fit = await fiResp.text();
        let fij;
        try { fij = JSON.parse(fit); } catch (_) { fij = { _raw: fit.slice(0, 200) }; }
        log('file_info', f.name, fiResp.status, fit.slice(0, 200));
        if (fiResp.status === 200) {
          const fileInfo = fij.file_info || fij;
          durl = fileInfo.web_content_link || '';
          const medias = fileInfo.medias || [];
          if (!durl && medias.length) {
            for (const m of medias) {
              if (m && m.link && m.link.url) { durl = m.link.url; break; }
            }
          }
          if (durl) attemptMode = 'FAST_PATH';
        }
      } catch (e) { log('file_info fast path err', String((e && e.message) || e)); }

      // 3b) Fallback: 单文件转存 + /files/{id} 取 web_content_link（不带 usage=CONSUME）
      if (!durl) {
        log('fallback to restore-single-file for', f.name);
        try {
          const restoreBody = {
            share_id: shareId,
            pass_code_token: passCodeToken || '',
            file_ids: [f.share_file_id],
            folder_type: 'NORMAL',
            specify_parent_id: true,
            parent_id: '',
          };
          const rr = await fetch(API + '/share/restore', {
            method: 'POST', headers: authHeaders, credentials: 'include',
            body: JSON.stringify(restoreBody),
          });
          const rt = await rr.text();
          let jTask;
          try { jTask = JSON.parse(rt); } catch (_) { jTask = { _raw: rt.slice(0, 200) }; }
          const restoreTaskId = (jTask && (jTask.task_id || jTask.restore_task_id || (jTask.data && (jTask.data.task_id || jTask.data.restore_task_id)))) || '';
          if (!restoreTaskId) {
            lastErr = 'restore 未返回 task_id：' + rt.slice(0, 200);
          } else {
            let newFileId = '';
            for (let i = 0; i < 30; i++) {
              await new Promise((res) => setTimeout(res, 800));
              try {
                const tresp = await fetch(API + '/tasks/' + encodeURIComponent(restoreTaskId), { method: 'GET', headers: authHeaders, credentials: 'include' });
                const tt = await tresp.text();
                let tj;
                try { tj = JSON.parse(tt); } catch (_) { tj = { _raw: tt.slice(0, 200) }; }
                if (tj && tj.progress === 100) {
                  const params = tj.params || {};
                  const traceStr = params.trace_file_ids || '';
                  if (traceStr && typeof traceStr === 'string') {
                    try {
                      const m = JSON.parse(traceStr);
                      newFileId = m[f.share_file_id] || (Object.values(m)[0]) || '';
                    } catch (_) {}
                  }
                  if (!newFileId && Array.isArray(params.new_file_ids)) newFileId = params.new_file_ids[0];
                  if (!newFileId && Array.isArray(params.file_ids)) newFileId = params.file_ids[0];
                  break;
                }
              } catch (e) { log('task poll err', String((e && e.message) || e)); }
            }
            if (!newFileId) {
              lastErr = 'restore task 完成但未取到 new_file_id';
            } else {
              restoredIds.push(newFileId);
              // /files/{id} 不带 usage=CONSUME，否则 web_content_link 不返回
              const dlResp = await fetch(API + '/files/' + encodeURIComponent(newFileId) + '?space=', {
                method: 'GET', headers: authHeaders, credentials: 'include',
              });
              const dlText = await dlResp.text();
              let dlJson;
              try { dlJson = JSON.parse(dlText); } catch (_) { dlJson = { _raw: dlText.slice(0, 200) }; }
              log('dl', f.name, dlResp.status, dlText.slice(0, 300));
              if (dlResp.status === 200) {
                const dd = dlJson.data || dlJson;
                durl = dd.web_content_link || (dd.links && dd.links['application/octet-stream'] && dd.links['application/octet-stream'].url) || dd.url || '';
                if (durl) attemptMode = 'TRANS';
              } else {
                lastErr = 'HTTP ' + dlResp.status + ' ' + dlText.slice(0, 200);
              }
            }
          }
        } catch (e) { lastErr = String((e && e.message) || e); }
      }

      if (!durl) {
        out.ok = false;
        out.step = 'download';
        out.status = 0;
        out.body = '文件[' + f.name + ']取直链失败（fast_path + trans 两条都未返回 web_content_link）：' + lastErr + '\n注：迅雷分享文件实际可下载；可能该文件不开放直链或受限。';
        out.name = f.name;
        return out;
      }
      files.push({ name: f.name, size: f.size || 0, url: durl, mode: attemptMode });
    }
    out.ok = true; out.files = files;
    return out;
  } catch (e) {
    out.step = 'exception'; out.error = String((e && e.message) || e);
    log('exception', out.error);
    return out;
  }
}

// 找一个已打开的 pan.xunlei.com 标签页（任意路径均可，分享页 /s/ 优先）；没有则返回 null
async function getXunleiPageTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://pan.xunlei.com/*' });
    if (tabs && tabs.length) return tabs[0].id;
  } catch (_) {}
  return null;
}

// 迅雷云盘：在 pan.xunlei.com 页面上下文解析（见 xunleiApiFetch 说明）
async function resolveXunlei(url, pwd) {
  const m = url.match(/\/s\/([A-Za-z0-9_-]+)/);
  const shareId = m ? m[1] : '';
  if (!shareId) throw new Error('无法从链接提取迅雷 share_id（请使用 pan.xunlei.com/s/ 开头的分享链接）');
  // 下载阶段需要 pan.xunlei.com 登录态 cookie（含 httpOnly），由 SW 侧读取后回传给 App 下载引擎
  const cookie = await getCookieString('https://pan.xunlei.com');
  const existing = await getXunleiPageTab();
  let tabId = existing;
  let tempTabId = null;
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: 'https://pan.xunlei.com/s/' + shareId, active: false });
    tempTabId = tab.id;
    await waitTabComplete(tempTabId);
    tabId = tempTabId;
  }
  try {
    // 等 SPA 稳定，避免注入时页面仍在跳转导致执行上下文被销毁（表现为 result:null）
    await new Promise((rs) => setTimeout(rs, 1500));
    let r = null;
    let lastRes = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lastRes = await chrome.scripting.executeScript({
          target: { tabId },
          func: xunleiApiFetch,
          args: [shareId, pwd || ''],
        });
        r = lastRes && lastRes[0] && lastRes[0].result;
      } catch (e2) {
        r = null;
        lastRes = { injectError: String((e2 && e2.message) || e2) };
        console.log('[xunlei] inject threw:', lastRes.injectError);
      }
      console.log('[xunlei] inject result(', attempt, ')=', JSON.stringify(r).slice(0, 500));
      if (r && r.ok) break;
      if (tempTabId == null) {
        const tab = await chrome.tabs.create({ url: 'https://pan.xunlei.com/s/' + shareId, active: false });
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
      const hint = /登录|未登录|请先登录/i.test(detail) ? '；请确认已在当前浏览器登录 pan.xunlei.com 迅雷网盘（扩展借用你的登录态）' : '';
      throw new Error('迅雷解析失败(' + (r ? r.step : 'null-result') + ')：' + detail + hint);
    }
    const files = r.files || [];
    if (!files.length) throw new Error('迅雷解析为空(分享内无文件)');
    return files.map((f) => ({
      name: f.name,
      size: bytesToSize(f.size),
      url: f.url,
      headers: { Referer: 'https://pan.xunlei.com/', 'User-Agent': navigator.userAgent, Cookie: cookie },
    }));
  } finally {
    if (tempTabId != null) { try { await chrome.tabs.remove(tempTabId); } catch (_) {} }
  }
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

// ---------- WeTransfer 公开分享解析 ----------
// WeTransfer 是公开分享、不需要登录态，因此不需要 executeScript 注入页面
// （那是对夸克等需登录网盘的做法），直接在 Service Worker 里 fetch 官方 v4 API 即可。
//
// 链路（2026-08 实网验证）：
//   1) 短链 we.tl/t-xxx --302--> wetransfer.com/downloads/<transfer_id>/<security_hash>?t_exp=…
//   2) POST /api/v4/transfers/<tid>/prepare-download  {"security_hash":"<sh>"} -> items[]
//   3) 每个 item POST /api/v4/transfers/<tid>/download
//      {"intent":"single_file","security_hash":"<sh>","file_ids":["<item.id>"]} -> {"direct_link":…}
// 注意第 3 步参数名必须是 file_ids（数组），file_id / item_id / item_ids 都会被拒。
// 实测（2026-08-31）这两个端点不校验 UA/Referer/Origin：裸 curl 也能正常返回。
// 这里仍然带上，是因为 MV3 SW 的 fetch 会静默丢弃 Referer/Origin/UA 这类禁用头——
// 带上是 best-effort（接口若日后收紧可省一次排查），丢了也不影响解析。
const WETRANSFER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 从落地页 URL 提取 transfer_id / security_hash：pathname 形如 /downloads/<tid>/<sh>
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

// 把 we.tl 短链展开成 wetransfer.com/downloads/... 落地页地址；已是落地页则原样返回。
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
  // 兜底：MV3 下 response.url 偶发不可靠，此时手工跟随 Location
  const loc = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
  if (loc) {
    try { return new URL(loc, u.href).href; } catch (_) { /* ignore */ }
  }
  // 重定向没生效时 response.url 就是短链本身，此时继续下去只会拿到一堆无法解析的地址
  if (finalUrl && finalUrl !== u.href) return finalUrl;
  throw new Error('WeTransfer 短链展开失败：未拿到 wetransfer.com/downloads/ 落地页地址（最终地址：' + (finalUrl || '空') + '）');
}

// WeTransfer 接口出错时返回形如 {"message":"Missing parameter :security_hash"}，
// 且状态码是 400/404 —— fetchJson 只看能不能 parse 成 JSON，不检查状态码，
// 因此必须在这里显式识别，否则会静默当成空列表返回，用户只看到「解析成功但没文件」。
// 兼容：message / error(字符串或 {message:..}) / errors[](数组) 三种常见形态，
// 避免「服务端 500 + {}」被误导成「分享内没有可下载的文件」。
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

  // F2 修复：服务端 500 + 空响应时，prepared 是 {} 且没有 message/error，
  // 旧逻辑会落到下面的「items 为空」分支，把服务端错误误导成「分享没文件」。
  // 现在 fetchJson 暴露了 _status，非 2xx 且无错误字段时直接报 HTTP 状态码。
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
  // F9 修复：逐文件取直链原本是串行 for 循环（20s × N），N=3 且网络慢时最坏 100s，
  // 会撞上前端 60s 超时。改为 Promise.all 并行发起（WeTransfer 单次分享文件数通常个位数），
  // 整轮耗时由 20N 降为单次 20s；配合 fetchJson/expand 超时收到 15s，最坏 15+15+15=45s < 60s。
  const tasks = items.map(async (it) => {
    const name = String((it && (it.name || it.display_name)) || 'file');
    // F5 修复：与百度/阿里/迅雷对齐，使用 bytesToSize 单位化展示（13.24 MB 而非裸字节）。
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
      // 单个文件取直链失败不拖垮整个分享：URL 留空并记日志，Rust 侧会过滤掉空 url 条目，
      // 由下方 warning 把失败原因回传给前端，用户仍能看到成功文件并知悉哪些失败（F6）。
      failMsg = String((e && e.message) || e);
      failures.push(name + ': ' + failMsg);
      console.log('[wetransfer] 文件取直链失败', String(it && it.id), failMsg);
    }
    return { name: name, size: size, url: direct, _fail: failMsg };
  });
  const settled = await Promise.all(tasks);
  for (const r of settled) {
    if (r._fail) continue; // 失败项交给 failures 汇总，不进 files（Rust 侧也会因 url 空被过滤）
    files.push({ name: r.name, size: r.size, url: r.url });
  }

  // 全部失败说明是接口/参数层面的问题（而非个别文件异常），必须报错而不是返回一堆空链接。
  // 注意：files 只装成功项，故「全部失败」= files 为空且确有失败（items≥1 已前置保证）。
  if (files.length === 0 && failures.length > 0) {
    throw new Error('WeTransfer 全部文件取直链失败：' + failures.join(' | '));
  }
  // 部分失败：保留成功文件，并用 warning 把失败原因回传前端（F6）——Rust 透传、前端琥珀横幅展示。
  let warning;
  if (failures.length > 0) {
    warning = '有 ' + failures.length + ' 个文件取直链失败（其余 ' + files.length + ' 个可用）：' + failures.join('；');
  }
  return { files: files, warning: warning };
}

// 分发
async function resolveNetdisk(req) {
  const platform = detectNetdiskPlatform(req.url) || req.platform;
  switch (platform) {
    case 'baidu': return await resolveBaidu(req.url, req.pwd);
    case 'aliyun': return await resolveAliyun(req.url, req.pwd);
    case 'quark': return await resolveQuark(req.url, req.pwd);
    case 'xunlei': return await resolveXunlei(req.url, req.pwd);
    case 'pan123': return await resolvePan123(req.url, req.pwd);
    case 'tianyi': return await resolveTianyi(req.url, req.pwd);
    case 'wetransfer': return await resolveWeTransfer(req.url, req.pwd);
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
        const resolved = await resolveNetdisk(req);
        // resolveNetdisk 多数平台返回 files 数组；WeTransfer 部分失败时返回 {files, warning}（F6）。
        const files = Array.isArray(resolved) ? resolved : (resolved && resolved.files || []);
        const warning = (!Array.isArray(resolved) && resolved && resolved.warning) || undefined;
        await reportNetdiskResult({ id: req.id, ok: true, files: files, url: req.url, warning: warning });
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

