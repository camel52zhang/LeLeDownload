# 123云盘 r15 交付：登录态注入（Authorization token）解决「必须登录/付费」5112

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,413,300 B，MD5 `8951c0215f42c23c6da117483707a290`）

## 背景

用户复测 `https://123pan.com/s/8KriVv-ElOX?xmhd`（西游记 30 集 .mp4，每集 600MB-1GB）报 5112「您需要注册登录或付费后下载」。r14 已修正错误分类（区分分享方限制 vs 用户未登录），但**根本问题**是：123 平台 2026-08 起取消免登录下载，SW 匿名 fetch 取直链必被 5112 拦截。

## 调研结论（WebSearch 实证）

1. **123 政策变更**：取消免登录下载（<100MB 免登录权益终止），游客必须注册/登录/付费才能下载
2. **web 端登录态** = `www.123pan.com` localStorage 里的 JWT token，请求头带 `Authorization: Bearer <token>`（参考 dmhy123 油猴脚本，key：`authorToken`/`token`/`accessToken` 直接键，或 `userInfo`/`user_info`/`loginInfo`/`login_info`/`user` JSON 内递归找，token 长度 > 50 才可信）
3. **免费用户限制**：每月提取流量 10GB；超出需按 GB 付费

## r15 改动

新增 3 个函数（与阿里云盘 `getAliyunRefreshToken` 同构）：

1. **`readPan123Token()`**（页面上下文注入）：探测 localStorage token（直接 key + JSON 递归 + 长度>50 校验），永不 throw
2. **`getPan123PageTab()`**：找已打开的 123 标签页（www.123pan.com 优先，yun.123pan.cn 兜底）
3. **`getPan123Token(forceRefresh)`**：内存缓存（10min 有效）→ 复用已开标签页注入 → 无则临时开后台标签页注入后关闭 → 兜底 `chrome.storage.local.pan123_token`（手动配置）

`resolvePan123` 改造：
- 开头 `getPan123Token()`，有 token 则 `BASE_HDR` 加 `Authorization: Bearer <token>`
- `download/info` 返 5112 且 message 是「未登录/付费」语义时：**强制刷新登录态（forceRefresh）重试一次**——用户可能刚在浏览器登录 www.123pan.com，第一次拿不到 token 重试即成功
- 重试后仍失败 → 抛 r14 的准确分类错误（当前用户未登录或非会员 / 分享方限制 / 失效 / 提取码）

build 标签 r14 → r15。

## 测试

- 123 单测 **24/24 全绿**：
  - X20 注入无 token → 5112 → 抛「当前用户未登录或非会员」
  - X21 注入有 token → download/info 带 `Authorization: Bearer tok123` → 成功取直链
  - X22 readPan123Token 探测（userInfo JSON / authorToken 直接键 / 短 token 忽略）
- 全量回归 **89/89 全绿**（阿里17 + 百度20 + 夸克16 + 迅雷12 + 12324）

## 打包副本（src-tauri/target/release/extension/background.js，102,453 B）

| 标记 | 命中 |
|---|---|
| `build=r15` | 4 |
| `getPan123Token` | 5 |
| `readPan123Token` | 4 |
| `Bearer ` 拼接 | 7 |
| 硬编码 `code === 5112` | 0 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,413,300 B
- MD5：`8951c0215f42c23c6da117483707a290`

## 使用方式（重要）

装 r15 后，解析需登录的 123 分享：
1. **先在浏览器打开并登录 `https://www.123pan.com`**（普通账号即可，扩展注入自动读 token）
2. 回到 LeLeDownload 重新解析该链接 → SW 自动带 `Authorization` 取直链
3. 若仍报 5112：
   - 提示「当前用户未登录或非会员」→ 说明注入没读到 token，确认浏览器已登录 www.123pan.com 且页面保持打开
   - 或分享方对 **600MB+ 大文件要求 SVIP 会员**（免费用户每月仅 10GB 提取流量，西游记 30 集 20GB+ 需付费/会员）→ 平台商业策略，无法绕过

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "feat(123pan): r15 登录态注入（getPan123Token 读 www.123pan.com localStorage token + Authorization 头 + 5112 强制刷新重试）应对 123 取消免登录下载"
  git push -u origin main && git push -f origin v26.08.19
  ```
