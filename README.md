# 乐乐下载器（LeLeDownload）

> 类似 IDM 的桌面下载管理器，配合浏览器扩展自动接管网页下载。

乐乐下载器是一个基于 **Tauri 2 + React 18 + TypeScript + Vite + Rust** 的桌面应用，
提供多线程/分块下载能力，并通过浏览器扩展把网页里的下载链接自动（或手动）交给桌面端接管，
获得接近 IDM 的下载体验。

---

## 一、项目说明

### 技术栈
- **桌面端**：Tauri 2（`withGlobalTauri`）、React 18、TypeScript、Vite 6、Tailwind CSS
- **核心引擎**：Rust（GNU 工具链，非 MSVC），基于 `reqwest` 的多线程分块下载
- **自动更新**：`tauri-plugin-updater`，从 GitHub Releases 拉取 `latest.json` 增量更新
- **浏览器扩展**：Manifest V3（Chrome / Edge / Firefox 109+），Service Worker 后台

### 主要功能
- 🚀 **多线程分块下载**：单文件多连接并发，断点续传，速度接近带宽上限
- 🔗 **浏览器扩展接管**：网页点下载即自动取消浏览器默认下载，转交桌面端（类 IDM）
- 📦 **同名文件自动重命名**：下载不同文件但文件名相同时全部保留，自动编号
  （如 `ACM.jpg` → `ACM_001.jpg` → `ACM_002.jpg`）
- ⏱️ **完成时间显示**：「已完成」列表项右侧显示该任务的完成时间
- 🌐 **间接 / 会话绑定链接解析**：支持 WeTransfer、`we.tl`、Google Drive 等分享链接的
  解析接管（含 Referer / Cookie / UA 透传，修复被拒问题）
- ☁️ **国内网盘直链解析**：粘贴分享链接 + 提取码，自动解析出真实下载地址交给多线程引擎
  （支持百度网盘 / 阿里云盘 / 夸克网盘 / 123 云盘 / 天翼云盘，详见第四节）
- 📁 **可配置下载目录**：默认下载目录可设置并持久化到 `settings.json`
- 🔄 **内置自动更新**：新版本发布后 App 内提示并一键更新

---

## 二、桌面端使用方法

### 方式一：下载安装包（推荐普通用户）
1. 打开 GitHub Releases：
   https://github.com/camel52zhang/LeLeDownload/releases
2. 下载最新版 `LeLeDownload_vYY.MM.DD_x64-setup.exe`（及同目录 `.sig` 签名文件）
3. 双击安装，按向导完成即可（默认当前用户安装，无需管理员权限）
4. 启动「LeLe Download」，保持运行，**扩展才能把下载交给它接管**

### 方式二：从源码构建（开发者）
详见下方「五、从源码构建」。

### 基本使用
- **手动添加任务**：主界面粘贴链接 → 开始下载
- **扩展接管**：安装并启用浏览器扩展后，网页里点下载会自动转交（见第三节）
- **默认下载目录**：在设置中修改，修改后持久化保存，下次启动生效
- **自动更新**：检测到新版本时弹窗提示，确认后自动下载并安装

---

## 三、浏览器扩展（插件）使用方法

扩展源码位于仓库 `extension/` 目录，通过本机回环接口
`http://127.0.0.1:45678/download` 与桌面 App 通信，**无需任何外部网络、免鉴权**。

> 详细文档见 [`extension/README.md`](extension/README.md)。

### 前置条件
1. **乐乐下载器桌面端必须正在运行**（它在后台监听 `127.0.0.1:45678`）。
   若 App 未运行，自动接管不会取消浏览器下载，并提示先运行程序。
2. 浏览器需支持扩展：Chrome / Edge / Firefox 109+。

### 安装方式

#### Chrome / Edge（开发者模式加载）
1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择仓库里的 `extension/` 目录
4. 固定扩展到工具栏即可

#### Firefox（临时加载，无需签名）
1. 地址栏打开 `about:debugging` → 左侧「This Firefox」
2. 点击「临时载入附加组件」，选择 `extension/manifest.json`
3. 注意：临时加载的扩展在浏览器重启后失效；如需常驻，可在
   `about:debugging` → 「打包附加组件」中将本目录打包为 `.xpi`
4. 要求 Firefox 109 及以上（MV3 Service Worker 支持）

### 使用
- **自动接管（默认开）**：保持开关开启，正常在网页里点下载，浏览器默认下载会被取消，
  任务出现在乐乐下载器主界面（类似 IDM）
- **右键菜单**：在链接 / 图片 / 视频 / 音频 / 页面上右键 →「使用乐乐下载器下载」
- **弹窗手动添加**：点击扩展图标，粘贴链接 → 开始下载
- **开关控制**：弹窗内可实时开 / 关「自动接管」
- **状态查看**：弹窗顶部显示「服务在线 / 离线」（检测本地 45678 端口）

### 扩展目录结构
```
extension/
├── manifest.json        # MV3 清单，含 Firefox gecko 配置
├── background.js         # 后台：自动接管 + 右键菜单 + 与 App 通信
├── content-script.js     # 内容脚本：白名单站点链接识别（WeTransfer / GD 等）
├── popup.html            # 弹窗界面
├── popup.js              # 弹窗逻辑（服务检测 / 手动添加 / 接管开关）
└── icons/                # 16 / 48 / 128 图标
```

### 说明
- 自动接管会跳过 `blob:`、`data:` 及浏览器扩展商店等地址，不干扰浏览器自身行为
- 通信仅限本机回环地址；仅在显式设置 `LELE_HTTP_TOKEN` 环境变量时才启用鉴权

---

## 四、国内网盘直链解析

把网盘分享链接解析成**真实下载地址**，交给桌面端的多线程引擎下载，绕开网页端下载的诸多限制。

### 支持平台

| 平台 | 登录要求 | 说明 |
|------|---------|------|
| 百度网盘 | 需登录（Cookie 含 BDUSS） | **免费账号的直链由百度自身限速**，会员账号登录则可满速 |
| 阿里云盘 | 需登录（读取 `refresh_token`） | 支持带提取码的分享 |
| 夸克网盘 | 需登录 `pan.quark.cn` | 直链校验 Referer + 登录态 |
| 123 云盘 | 公开分享免登录 | 带密分享填提取码即可 |
| 天翼云盘 | 需配置第三方解析 API Key | 官方接口签名复杂，暂走第三方兜底 |

> 腾讯微云无公开接口、风险较高，本版本暂不支持。

### 工作原理（为什么要装扩展）

解析全过程发生在**浏览器扩展内部**，桌面端只拿到最终直链：

```
App「网盘解析」面板 → 提交待解析队列 → 扩展轮询取走
                                          ↓
                        扩展用你浏览器里的登录态调用网盘接口
                                          ↓
App 收到直链 ← 仅回传直链和文件名 ← 解析完成
```

**你的网盘 Cookie / Token 始终留在浏览器内，不会写入桌面端、不落盘、不出网。**
这也意味着：**必须安装并启用浏览器扩展，且已在浏览器登录对应网盘**，解析才能成功。

### 使用步骤

1. 确认桌面端正在运行，且浏览器扩展已启用（见第三节）
2. 在浏览器里登录目标网盘（123 云盘的公开分享可跳过）
3. 打开桌面端顶部的「**网盘解析**」标签页
4. 粘贴分享链接，填写提取码（没有可留空），点击「解析」
5. 解析出的文件列表逐个点「加入下载」，即进入下载队列

### 特殊配置

个别平台需要在扩展的存储里手动配置凭据。打开扩展的 Service Worker 控制台
（`chrome://extensions` → 找到本扩展 → 点击「Service Worker」），执行：

```js
// 阿里云盘：浏览器 Cookie 里取不到 refresh_token 时手动配置
chrome.storage.local.set({ aliyun_refresh_token: '你的refresh_token' })

// 天翼云盘：第三方解析 API 的 key
chrome.storage.local.set({ tianyi_api_key: '你的apikey' })
```

### 常见问题

- **一直卡在「解析中…」，60 秒后提示超时**
  扩展未安装 / 未启用，或其 Service Worker 被浏览器休眠。打开一次浏览器窗口后重试。
- **提示「未检测到登录态」**
  先在浏览器里登录该网盘，再回到 App 重试。
- **百度下载速度很慢**
  这是百度对免费账号的限速，非本工具问题；用会员账号登录浏览器后重新解析即可。
- **解析成功但下载 403**
  直链有时效性（通常几分钟到几小时），过期后重新解析即可。
- **某平台突然全部解析失败**
  网盘官方接口变动所致，需更新扩展的解析逻辑。

> ⚠️ 本功能仅用于下载**你自己有权访问**的文件，请遵守各网盘的服务条款。
> 各平台接口均可能随官方调整而失效，解析能力为 best-effort。

---

## 五、从源码构建

### 环境要求
- **Node.js** 18+（含 `npm`）
- **Rust** 工具链：`stable-x86_64-pc-windows-gnu`（GNU 版，**非 MSVC**）
  - 需 winlibs 的 GCC/mingw 工具链，并配置 `CC` / `CXX` / `AR` / `LINKER` 环境变量
- **Tauri 2 CLI**：通过 `npm` 脚本调用，无需全局安装

### 构建命令
```bash
# 安装前端依赖
npm install

# 构建并打包 Windows 安装包（nsis）
npm run tauri:build
```

构建产物：
- 安装包：`src-tauri/target/release/bundle/nsis/LeLeDownload_vYY.MM.DD_x64-setup.exe`
- 独立可执行文件（不打包）：`src-tauri/target/release/lele_download.exe` + 同目录 `WebView2Loader.dll`

> ⚠️ **发布签名**：`npm run tauri:build` 会生成自动更新所需的 `.sig` 工件，
> 需要设置环境变量 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容，非路径）与
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（本仓库为空）。缺少私钥时仍可构建出未签名安装包，
> 但自动更新工件无法生成。请务必本地备份私钥。

### 仅运行开发模式
```bash
npm run tauri:dev
```

---

## 六、版本说明

版本号采用 `YY.MM.DD` 方案：
- **内部语义版本**（自动更新比对用）：`26.8.11`（去前导零，合法 semver）
- **界面显示 / 安装包名**：`v26.08.11`（带前导零）

每次正式发布流程：
```bash
# 构建 → 提交 → 打 tag → 推送（推送触发 GitHub Actions 自动构建 + 签名 + 生成 latest.json）
npm run tauri:build
git commit -am "release: v26.08.11"
git tag v26.8.11
git push -u origin main
git push origin v26.8.11

# 每次修改后操作
git add -A
git commit -m "写修改内容，例如：fix(ext): 磁力超链接右键经 content-script 兜底拿 href + iframe 注入 (r24d)"
git tag v26.08.21
git push -u origin main
git push origin v26.08.21

```

---

## 七、相关链接

- 项目地址：https://github.com/camel52zhang/LeLeDownload
- 扩展文档：[`extension/README.md`](extension/README.md)
- 发布下载：https://github.com/camel52zhang/LeLeDownload/releases
