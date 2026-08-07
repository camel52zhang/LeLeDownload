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
