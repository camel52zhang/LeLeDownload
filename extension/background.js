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

// 自动接管：浏览器开始任何 http(s) 下载时，先确认 App 在线，
// 在线则取消浏览器默认下载并交由乐乐下载器接管（类似 IDM 体验）。
chrome.downloads.onCreated.addListener((item) => {
  if (!autoCapture) return;
  if (!/^https?:\/\//i.test(item.url || '')) return;
  if (/addons\.mozilla\.org|chromewebstore\.google\.com|edgedaddons\.microsoft\.com/i.test(item.url || '')) return;

  const filename = item.filename || (item.url || '').split('/').pop() || item.url;
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
