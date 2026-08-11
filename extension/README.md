# 乐乐下载器 · 浏览器扩展

让浏览器里的下载自动（或手动）交给「乐乐下载器」桌面端接管，体验类似 IDM。
扩展通过本机回环 HTTP 接口 `http://127.0.0.1:45678/download` 与桌面 App 通信，
**无需任何外部网络、免鉴权**。

## 功能

- **自动接管**（默认开）：浏览器开始任何 `http(s)` 下载时，自动取消浏览器默认下载，
  交由乐乐下载器接管（类似 IDM）。可在弹窗里关闭此开关。
- **右键菜单**：在链接 / 图片 / 视频 / 音频 / 页面上右键 →「使用乐乐下载器下载」。
- **弹窗手动添加**：点击扩展图标，粘贴链接 → 开始下载。
- **自动接管开关**：弹窗内可实时开/关。
- **国内网盘直链解析**：后台轮询 App 的待解析队列，用浏览器里的网盘登录态解析出
  真实下载地址回传给 App（见下方「网盘解析」一节）。

## 前置条件

1. **乐乐下载器桌面端必须正在运行**（它会在后台监听 `127.0.0.1:45678`）。
   - 若 App 未运行，自动接管不会取消浏览器下载（避免误伤），并提示先运行程序。
2. 浏览器需支持扩展（Chrome / Edge / Firefox 109+）。

## 安装方式

### Chrome / Edge（开发者模式加载）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录（`extension/`）。
4. 固定扩展到工具栏即可。

### Firefox（临时加载，无需签名）

1. 地址栏打开 `about:debugging` → 左侧「This Firefox」。
2. 点击「临时载入附加组件」。
3. 选择本目录下的 `manifest.json`。
4. 注意：临时加载的扩展在浏览器重启后失效；如需常驻，需自行签名打包为 `.xpi`
   （`about:debugging` → 「打包附加组件」选择本目录）。
5. 要求 Firefox 109 及以上（MV3 service worker 支持）。

## 使用

- **自动接管**：保持开关开启，正常在网页里点下载，浏览器会闪一下（默认下载被取消），
  任务出现在乐乐下载器主界面。
- **关闭自动接管**：弹窗里取消勾选，则只在你主动右键 / 手动粘贴时才发送。
- **查看状态**：弹窗顶部显示「服务在线 / 离线」（检测本地 45678 端口）。

## 网盘解析

在桌面端「网盘解析」标签页提交分享链接后，**解析工作实际由本扩展完成**：

```
App 待解析队列  ──GET /api/netdisk/resolve/pending──▶  扩展轮询取走
                                                          │
                                            用浏览器登录态调用网盘接口
                                                          ▼
App 收到直链  ◀──POST /api/netdisk/resolve/result──  仅回传直链+文件名
```

之所以这样设计：**网盘的 Cookie / Token 只能留在浏览器里**，不进桌面端进程、不落盘、不出网。

| 平台 | 前置条件 |
|------|---------|
| 百度网盘 | 浏览器已登录（Cookie 含 BDUSS）；免费账号直链被百度限速 |
| 阿里云盘 | 浏览器已登录 alipan.com（读 `refresh_token`），或手动配置见下 |
| 夸克网盘 | 浏览器已登录 pan.quark.cn |
| 123 云盘 | 公开分享免登录 |
| 天翼云盘 | 需配置第三方解析 API Key，见下 |

### 手动配置凭据

在本扩展的 Service Worker 控制台（`chrome://extensions` → 本扩展 →「Service Worker」）执行：

```js
chrome.storage.local.set({ aliyun_refresh_token: '你的refresh_token' })
chrome.storage.local.set({ tianyi_api_key: '你的52api.cn apikey' })
```

### 轮询与休眠

MV3 的 Service Worker 空闲约 30 秒会被浏览器回收，`setInterval` 随之失效。
因此采用双保险：SW 存活时用 2.5 秒快速轮询保证秒级响应；被回收后由 `chrome.alarms`
（最小周期 30 秒）唤醒兜底。若 App 侧长时间等不到回执，60 秒后会提示解析超时。

## 目录

```
extension/
├── manifest.json                 # MV3，含 Firefox gecko 配置
├── background.js                 # 后台：自动接管 + 右键菜单 + 网盘解析 + 与 App 通信
├── content-script.js             # 内容脚本：白名单站点链接识别（WeTransfer / GD 等）
├── popup.html                    # 弹窗界面
├── popup.js                      # 弹窗逻辑（服务检测 / 手动添加 / 接管开关）
├── test-netdisk-resolver.mjs     # 回归测试：平台识别 + 体积格式化
├── test-isLikelyFileRequest.mjs  # 回归测试：文件请求判定
├── test-wetransfer-oncreated.mjs # 回归测试：WeTransfer 接管
└── icons/                        # 16/48/128 图标
```

运行全部扩展测试：

```bash
node --test extension/*.mjs
```

## 说明

- 自动接管会跳过 `blob:`、`data:` 及浏览器扩展商店等地址，不干扰浏览器自身行为。
- 通信仅限本机回环地址；仅在显式设置 `LELE_HTTP_TOKEN` 环境变量时才启用鉴权。
