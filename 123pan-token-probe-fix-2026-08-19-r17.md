# 123云盘 r17 交付：token 探测增强（JWT 兜底 + 多标签页注入）

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,410,882 B，MD5 `6eb8ed45a6371da5917a2bf872ee5562`）

## 背景

用户装 r16 后解析 `6gDSjv-phQ7d` 仍报「分享未向游客开放提取流量」——说明 r16 的**登录态重试失败了**：`getPan123Token(true)` 没拿到有效 token。三种可能：① 用户没在浏览器登录 123；② 登录了但 token 在未知 localStorage key（r15 探测的 key 列表不全）；③ 登录了但注入到了错误域的标签页（token 可能在 www.123pan.com 或 yun.123pan.cn 任一）。

## r17 改动（针对 ②③ 增强探测）

1. **`readPan123Token` 加 JWT 兜底遍历**：
   - 已知 key 扩充：`authorToken`/`token`/`accessToken`/`panLoginToken`
   - JSON key 扩充：+`userInfoV2`，递归字段 +`jwt`/`token_info`/`loginToken`
   - **兜底**：遍历全部 localStorage entries，抓 JWT 格式值（`xxx.yyy.zzz` 三段 base64url + 长度>50）——123 前端改版 key 名变了也能抓到
   - 123 的 Authorization Bearer token 是 JWT（开放平台文档示例 `eyJhbGciOiJIUzI1NiIs...` 实锤）
2. **`getPan123PageTabs` 返回所有已打开 123 标签页**（不再只取第一个）——token 可能只在 www.123pan.com 或 yun.123pan.cn 其中一个域
3. **`getPan123Token` 依次注入每个标签页**直到读到 token，全部失败才兜底/返回空

build 标签 r16 → r17。

## 测试

- 123 单测 **28/28 全绿**：
  - X24 JWT 兜底遍历抓未知 key / 短字符串不误判
  - X25 多标签页注入（tab1 无 token → tab2 有 token → 成功）
- 全量回归 **93/93 全绿**（阿里17+百度20+夸克16+迅雷12+12328）

## 打包副本（src-tauri/target/release/extension/background.js，104,635 B）

| 标记 | 命中 |
|---|---|
| `build=r17` | 4 |
| `getPan123PageTabs` | 2 |
| `isJwt` | 3 |
| 硬编码 `code === 5112` | 0 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,410,882 B
- MD5：`6eb8ed45a6371da5917a2bf872ee5562`

## ⚠️ 关键前置条件（r17 依然依赖）

**必须在浏览器先登录 123**，否则任何探测都拿不到 token：

1. 浏览器打开 `https://www.123pan.com`（或 yun.123pan.cn）→ 扫码/账号登录 → **登录后保持该页面开着**
2. 回到 LeLeDownload 重新解析 `6gDSjv-phQ7d`
3. r17 会：匿名失败 → 注入已打开 123 标签页读 token（JWT 兜底 + 多标签页）→ 带 `Authorization` 重试
4. 若仍报「分享未向游客开放提取流量」→ 说明分享方真的关闭了提取（trafficSwitch=1），需找「独乐乐」重新分享

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "fix(123pan): r17 token 探测增强（JWT 兜底遍历抓未知 key + 多标签页依次注入）"
  git push -u origin main && git push -f origin v26.08.19
  ```
