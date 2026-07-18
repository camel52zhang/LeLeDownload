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
  
  // 初始化
  checkService();
  setInterval(checkService, 5000);
});
