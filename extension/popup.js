// 乐乐下载器 - Popup 脚本

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('urlInput');
  const downloadBtn = document.getElementById('downloadBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const openAppLink = document.getElementById('openApp');
  const autoCapture = document.getElementById('autoCapture');
  
  // 自动接管开关：回显当前设置，变更时持久化
  try {
    chrome.storage.local.get(['autoCapture'], (res) => {
      autoCapture.checked = (typeof res.autoCapture === 'boolean') ? res.autoCapture : true;
    });
    autoCapture.addEventListener('change', () => {
      chrome.storage.local.set({ autoCapture: autoCapture.checked });
    });
  } catch (_) { /* storage 不可用时隐藏开关逻辑 */ }
  
  // 检测本地服务是否运行
  async function checkService() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch('http://127.0.0.1:45678/status', {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timer);

      if (response.ok) {
        statusDot.classList.remove('offline');
        statusText.textContent = '服务在线';
        return true;
      }
    } catch (error) {
      statusDot.classList.add('offline');
      statusText.textContent = '服务离线 - 请确保程序运行';
      return false;
    }
    return false;
  }

  // 发送下载请求
  async function sendDownload(url) {
    if (!url.trim()) {
      alert('请输入下载链接');
      return;
    }

    try {
      const response = await fetch('http://127.0.0.1:45678/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: url.trim(),
          timestamp: Date.now()
        })
      });
      
      if (response.ok) {
        urlInput.value = '';
        alert('已将下载任务发送给乐乐下载器！');
      } else {
        alert('发送失败: ' + response.statusText);
      }
    } catch (error) {
      alert('无法连接到乐乐下载器，请确保程序正在运行');
    }
  }
  
  // 事件绑定
  downloadBtn.addEventListener('click', () => {
    sendDownload(urlInput.value);
  });
  
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendDownload(urlInput.value);
    }
  });
  
  openAppLink.addEventListener('click', (e) => {
    e.preventDefault();
    // 修复(P1)：leledown:// 协议未注册 deep-link 插件，window.open 会打开无效空白页。
    // 改为探测服务状态后给出准确提示。
    fetch('http://127.0.0.1:45678/status')
      .then(r => { alert(r.ok ? '乐乐下载器已在运行中' : '请手动启动桌面端的「乐乐下载器」程序'); })
      .catch(() => { alert('请手动启动桌面端的「乐乐下载器」程序（lele_download.exe）'); });
  });
  
  // 接管此页面：把嗅探脚本注入当前标签页（手动触发，不限自动嗅探范围）
  const takeoverBtn = document.getElementById('takeoverBtn');
  const pageStatus = document.getElementById('pageStatus');

  // 是否为分享链接页面（与 manifest content_scripts.matches 保持一致）
  function isSharePage(url) {
    if (!url) return false;
    return /^https?:\/\/(we\.tl|.*\.wetransfer\.com)\//i.test(url) ||
      /^https?:\/\/.*drive\.google\.com\//i.test(url);
  }

  // 回显当前页面是否可嗅探
  function refreshPageStatus() {
    if (!pageStatus) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs && tabs[0] && tabs[0].url;
      if (isSharePage(url)) {
        pageStatus.textContent = '检测到分享链接页面，点击「接管此页面」可自动嗅探真实直链';
      } else {
        pageStatus.textContent = '当前为直链/普通页面；「接管此页面」可对任意页面手动注入嗅探';
      }
    });
  }

  if (takeoverBtn) {
    takeoverBtn.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) { alert('无法获取当前标签页'); return; }
        if (typeof chrome.scripting === 'undefined' || !chrome.scripting.executeScript) {
          alert('当前浏览器不支持 scripting API，无法手动注入');
          return;
        }
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content-script.js'] },
          () => {
            if (chrome.runtime.lastError) {
              alert('注入失败：' + chrome.runtime.lastError.message);
            } else if (pageStatus) {
              pageStatus.textContent = '已注入嗅探脚本，正在监听页面下载请求…';
            }
          }
        );
      });
    });
  }

  refreshPageStatus();

  // 初始化
  checkService();
  setInterval(checkService, 5000);
});
