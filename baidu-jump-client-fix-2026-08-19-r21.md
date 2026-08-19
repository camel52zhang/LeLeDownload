# 百度网盘 r21 交付：errno 0 + list:string（跳端下载限制）识别

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,415,913 B，MD5 `39025f90f324467d584ef9f6f8839ea1`）

## 背景

用户装 r20 后复测两个百度分享：
- `_66tp91_qXnll95nXUtbEg`（pwd=bxde）→ **解析正常** ✅（证明 bdstoken 生效、链路没问题）
- `HN2hr-1igGA30V7ypF2vhg`（pwd=q7g4）→ 报**新错误**：`未返回 dlink（errno 0）`，原始响应 `{"errno":0,...,"list":"lcLSYqsqWZI7U5baWnZpVcfhTS5b/..."}`

## 根因（百度官方 union 文档实证）

**errno 从 -20 → 0（bdstoken 生效，风控已过！）**，但 `list` 字段变成了**加密字符串**（92 字节密文）而非数组。

百度官方开放平台文档「获取分享下载地址」响应说明明确：

> **web 端下载：返回 `dlink` 参数时直接用；返回 `list:string` 参数 = 跳端下载（需跳 PC 客户端）**

即：**百度限制该分享/文件在网页端直接下载**（要求跳转 PC 客户端）。这是分享方/平台侧限制：
- 参考项目 netdisk-resolver 同样失败（它也假设 list 是数组）
- 无法用 web 链路绕过（PC 客户端需要 access_token + 加密 spwd + 独立签名）

## r21 改动

`resolveBaidu` 错误处理增强：识别 `errno === 0 && typeof list === 'string'` → 提示「该文件被限制网页端直接下载（list:string 跳端下载指令，官方要求跳转 PC 客户端）。建议：换一个分享链接；或直接用百度网盘客户端下载」——不再误导性地报「未返回 dlink」。

build 标签 r20 → r21。

## 测试

- 百度单测 **23/23 全绿**：
  - T23（r21 关键）：errno 0 + list 字符串 → 识别「限制网页端直接下载」+ 跳端下载/PC 客户端提示 + **不出现**「未返回 dlink」
- 全量回归 **99/99 全绿**（阿里20+百度23+夸克16+迅雷12+12328）

## 打包副本（src-tauri/target/release/extension/background.js，110,515 B）

| 标记 | 命中 |
|---|---|
| `build=r21` | 4 |
| `跳端下载` | 2 |
| `isJumpToClient` | 3 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,415,913 B
- MD5：`39025f90f324467d584ef9f6f8839ea1`

## 结论（对你很重要）

1. **代码没问题**：`_66tp91` 正常解析 = wxlist/tplconfig/sharedownload/bdstoken 全链路 OK
2. **`HN2hr` 是分享自身限制**：百度要求该分享跳 PC 客户端下载（list:string），web 端拿不到 dlink，**任何 web 工具（含参考项目）都下不了**
3. 建议：换一个分享链接，或用百度网盘客户端下载该分享

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "fix(baidu): r21 识别 errno 0 + list:string 跳端下载限制（官方文档实证），提示不再误导"
  git push -u origin main && git push -f origin v26.08.19
  ```
