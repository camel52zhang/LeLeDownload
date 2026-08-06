// 乐乐下载器 - 内容脚本（注入 we.tl / *.wetransfer.com / drive.google.com 等分享链接页面）
//
// 职责（见架构设计 §1.2 / §1.6）：
//   1. hook 页面的 fetch / XMLHttpRequest / <a>.click，捕获「真实文件请求」的
//      url + 请求头（init.headers）+ Cookie（含 HttpOnly）+ Referer。
//   2. 通过 chrome.runtime.sendMessage({type:'share-link', url, headers}) 上报给 background。
//   3. 短路页面自身下载（返回合成空 Response / 中和 blob anchor click），
//      确保页面不再产生真实字节下载、避免与 App 下载「双下载」。
//
// 关键约束：仅对「识别为文件下载」的请求短路；正常 API/资源请求原样放行，绝不误伤页面功能。
// 设计决策（OQ#6）：不读取 blob/object URL 的真实字节，只观察请求参数（url + 头 + cookie）。

(function () {
  'use strict';

  // 防止同一页面被重复注入（自动注入 + popup「接管此页面」重复注入）导致 hook 多层嵌套
  if (window.__lele_capture_installed) return;
  window.__lele_capture_installed = true;

  // 同一 url 的去重冷却，避免页面重试造成 App 端重复创建下载任务
  const SENT_CACHE = Object.create(null);
  const DEDUP_MS = 1500;

  function alreadySent(url) {
    const now = Date.now();
    const last = SENT_CACHE[url] || 0;
    if (now - last < DEDUP_MS) return true;
    SENT_CACHE[url] = now;
    return false;
  }

  // ---------------------------------------------------------------------------
  // 文件请求识别启发式（保守：宁可漏抓，不可误伤页面正常功能）
  // ---------------------------------------------------------------------------
  function isLikelyFileRequest(url, method) {
    const m = (method || 'GET').toUpperCase();
    if (m !== 'GET') return false; // 下载一律 GET
    let u;
    try {
      u = new URL(url, location.href);
    } catch (_) {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();

    // 常见文件扩展名（命中即视为文件请求；刻意排除静态资源/API 后缀 js/json/css/html 等）。
    // 集中定义，供「其他网盘 CDN」与「通用启发」两处复用，避免规则漂移。
    const FILE_EXT = /\.(zip|tar|tgz|gz|rar|7z|mp4|mov|avi|mkv|m4v|m2ts|webm|m4a|aac|mp3|wav|flac|ogg|opus|pdf|docx?|xlsx?|pptx?|epub|azw|psd|ai|dwg|dxf|png|jpe?g|gif|webp|bmp|heic|tif|sql|db|zst|exe|msi|dmg|iso|img|bin|dat|csv|txt|apk|deb|rpm|jar|war|torrent)$/i;

    // --- Google Drive 实际文件内容（带 confirm token 的 CDN）---
    if (host.endsWith('googleusercontent.com')) return true;
    if (host === 'drive.usercontent.google.com') return true;
    if (host.endsWith('google.com') && (query.includes('export=download') || query.includes('export=view'))) return true;
    // GD 大文件二次确认：*.drive.google.com/uc?export=download&confirm=xxx
    if (host.endsWith('drive.google.com') && (path.includes('/uc') || query.includes('export='))) return true;

    // --- WeTransfer 文件 CDN（区别于 web API 域名）---
    if (host === 'download.wetransfer.com') return true;
    if (host === 'filedownload.wetransfer.com') return true;
    if (host === 'transfer.wetransfer.com') return true;
    if (host.endsWith('.wetransfer.net')) return true;

    // --- 其他网盘 CDN（best-effort；content_scripts 仅注入上述站点，扩了不影响别站）
    //     仅在「带明确文件扩展名」时命中，避免误伤页面正常功能 ---
    if ((host === 'dl.dropboxusercontent.com' || host.endsWith('.dropboxusercontent.com') || host.endsWith('.mega.nz')) && FILE_EXT.test(path)) {
      return true;
    }

    // --- 通用安全排除：API / 静态资源（绝不当作文件下载）---
    if (path.includes('/api/')) return false;
    if (/\.(json|js|css|html?|map|woff2?|ttf|eot|svg|webmanifest|xml)$/.test(path)) return false;

    // --- 通用启发：路径含常见文件扩展名 ---
    if (FILE_EXT.test(path)) {
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Cookie 头构造：chrome.cookies.getAll（含 HttpOnly）+ document.cookie 兜底
  // 同时取页面域名与目标 CDN 域名的 Cookie，最大化会话凭证覆盖率。
  // ---------------------------------------------------------------------------
  function collectCookies(url, out) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.cookies || !chrome.cookies.getAll) {
          resolve();
          return;
        }
        chrome.cookies.getAll({ url: url }, function (cks) {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
          const list = cks || [];
          for (let i = 0; i < list.length; i++) {
            out.push(list[i].name + '=' + list[i].value);
          }
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  async function buildCookieHeader(url) {
    const cookies = [];
    // 页面域名 Cookie（we.tl / wetransfer.com / drive.google.com ...）
    await collectCookies(location.href, cookies);
    // 目标 CDN 域名 Cookie（download.wetransfer.com / *.googleusercontent.com ...）
    if (url) {
      try {
        const target = new URL(url, location.href);
        if (target.protocol === 'http:' || target.protocol === 'https:') {
          await collectCookies(target.href, cookies);
        }
      } catch (_) { /* ignore */ }
    }
    // document.cookie 兜底（非 HttpOnly 部分）
    if (typeof document !== 'undefined' && document.cookie) {
      const parts = document.cookie.split(';');
      for (let i = 0; i < parts.length; i++) {
        const c = parts[i].trim();
        if (c) cookies.push(c);
      }
    }
    // 按 cookie 名去重，后者覆盖前者
    const map = Object.create(null);
    for (let i = 0; i < cookies.length; i++) {
      const idx = cookies[i].indexOf('=');
      if (idx > 0) {
        const name = cookies[i].slice(0, idx).trim();
        if (name) map[name] = cookies[i].trim();
      }
    }
    const values = [];
    for (const k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) values.push(map[k]);
    }
    return values.join('; ');
  }

  // ---------------------------------------------------------------------------
  // 合并请求头：init.headers + Referer + Cookie
  // ---------------------------------------------------------------------------
  function copyInitHeaders(initHeaders, target) {
    if (!initHeaders) return;
    if (typeof initHeaders.forEach === 'function' && typeof initHeaders.entries === 'function') {
      // 标准 Headers 对象
      initHeaders.forEach(function (value, key) { target[key] = value; });
    } else if (Array.isArray(initHeaders)) {
      for (let i = 0; i < initHeaders.length; i++) {
        const pair = initHeaders[i];
        if (pair && pair.length >= 2) target[pair[0]] = pair[1];
      }
    } else {
      // 普通对象
      for (const k in initHeaders) {
        if (Object.prototype.hasOwnProperty.call(initHeaders, k)) target[k] = initHeaders[k];
      }
    }
  }

  async function buildHeaders(url, init) {
    const headers = {};
    const initHeaders = (init && init.headers) || null;
    copyInitHeaders(initHeaders, headers);

    // Referer：优先 fetch 自带，其次页面 referrer
    if (!headers['Referer'] && !headers['referer']) {
      const ref = (initHeaders && (initHeaders.Referer || initHeaders.referer)) || document.referrer;
      if (ref) headers['Referer'] = ref;
    }

    const cookie = await buildCookieHeader(url);
    if (cookie) headers['Cookie'] = cookie;

    return headers;
  }

  function reportShareLink(url, headers) {
    if (!url || alreadySent(url)) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'share-link', url: url, headers: headers },
        function () {
          // 忽略 background 未就绪的 lastError，避免未捕获异常
          if (chrome.runtime.lastError) { /* noop */ }
        }
      );
    } catch (_) { /* noop */ }
  }

  // ---------------------------------------------------------------------------
  // fetch hook
  // ---------------------------------------------------------------------------
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string'
        ? input
        : (input && (input.url || (input.toString && input.toString())) || '');
      const method = (init && init.method) || (input && input.method) || 'GET';

      if (url && isLikelyFileRequest(url, method)) {
        // 异步上报（不阻塞页面），并短路页面下载：返回合成空 Response
        buildHeaders(url, init)
          .then(function (headers) { reportShareLink(url, headers); })
          .catch(function () { /* noop */ });
        // 页面 .blob() 拿到空对象、不抛错；真实下载完全由 App 完成。
        return Promise.resolve(new Response(new Blob(), { status: 200, statusText: 'OK' }));
      }
      return origFetch(input, init);
    };
  }

  // ---------------------------------------------------------------------------
  // XMLHttpRequest hook
  // ---------------------------------------------------------------------------
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const origXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lele = { method: method || 'GET', url: url || '', headers: {} };
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__lele) this.__lele.headers[name] = value;
    return origXhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const meta = this.__lele;
    if (meta && meta.url && isLikelyFileRequest(meta.url, meta.method)) {
      // 捕获并上报；不调用原始 send => 页面不产生真实字节下载（避免双下载）。
      const self = this;
      const capturedUrl = meta.url;
      const capturedHeaders = meta.headers;
      buildHeaders(capturedUrl, { headers: capturedHeaders })
        .then(function (headers) { reportShareLink(capturedUrl, headers); })
        .catch(function () { /* noop */ });
      // 在监听器挂载后触发 abort 事件，让页面 onabort/超时逻辑正常收口，避免挂起。
      setTimeout(function () {
        try { self.abort(); } catch (_) { /* noop */ }
      }, 0);
      return;
    }
    return origXhrSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // <a>.click hook：中和 blob: 下载，防止 downloads.onCreated 二次接管造成死循环
  // ---------------------------------------------------------------------------
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href && this.href.indexOf('blob:') === 0) {
      // 吞掉该点击：真实下载已由 App 完成，避免浏览器下载管理器接管 blob URL。
      return;
    }
    return origAnchorClick.apply(this, arguments);
  };

  // 注入确认日志（仅调试可见，不影响功能）
  console.log('[乐乐] content-script 已注入，开始嗅探分享链接真实文件请求');
})();
