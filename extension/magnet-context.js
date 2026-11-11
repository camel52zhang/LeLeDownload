// 乐乐下载器 - 磁力/种子链接右键兜底
// Chrome 对非标准协议链接（magnet:/thunder:/ed2k:/ftp:）右键时，
// contextMenus.onClicked 的 info.linkUrl 经常为空，导致 background 拿不到链接。
// 此脚本注入所有页面（含 iframe，all_frames:true），捕获磁力超链接/文本的右键，
// 把真实 href 写入 storage（持久，SW 休眠也不丢）+ 发消息（冗余）给 background 兜底。
(function () {
  'use strict';
  var SCHEMES = ['magnet:', 'thunder:', 'ed2k:', 'ftp:', 'ftps:'];

  // 每次执行时把真实浏览器 UA 写入 storage，供 background 的自动接管组装下载请求头：
  // Anubis 等反爬站点可能把 cookie 绑定浏览器 UA，App 侧请求必须带浏览器 UA。
  // SW 自身无 navigator 拿不到真实 UA，只能靠本内容脚本（已注入所有 http(s) 页面）上报。
  try {
    if (navigator.userAgent) {
      chrome.storage.local.set({ lele_browser_ua: navigator.userAgent });
    }
  } catch (_) {}

  function findMagnetInText(text) {
    if (!text) return null;
    var m = text.match(/magnet:\?[^\s"'<>]+/i) ||
            text.match(/thunder:[^\s"'<>]+/i) ||
            text.match(/ed2k:[^\s"'<>]+/i) ||
            text.match(/https?:\/\/[^\s"'<>]+/i);
    return m ? m[0] : null;
  }

  function findLinkHref(el) {
    // 1) 优先取最近的 <a> 的 href（标准协议 Chrome 会给 linkUrl，这里兜底非标准协议）
    var a = el && el.closest ? el.closest('a') : null;
    if (a && a.href) {
      var href = a.href;
      for (var i = 0; i < SCHEMES.length; i++) {
        if (href.toLowerCase().indexOf(SCHEMES[i]) === 0) return href;
      }
    }
    // 2) 兜底：从元素文本中提取磁力/http 子串（应对"蓝色文字但不是 <a>"的情况）
    var text = el && el.textContent ? el.textContent : '';
    return findMagnetInText(text);
  }

  document.addEventListener('contextmenu', function (e) {
    var href = findLinkHref(e.target);
    if (!href) return;
    // 写入 storage（持久，跨 iframe/跨 SW 唤醒都可见）+ 发消息（冗余）。
    // background 的 onClicked 端会做重试轮询读取，规避 MV3 SW 唤醒/消息时序竞态。
    try { chrome.storage.local.set({ lele_last_magnet: href }); } catch (_) {}
    try { chrome.runtime.sendMessage({ type: 'lele-magnet-href', href: href }); } catch (_) {}
  }, true);
})();
