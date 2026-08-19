# 阿里云盘 r19 交付：转存后 get_download_url url 空 → PDS 域兜底

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,413,315 B，MD5 `3f71d2aab7ba3d7726aa5c7e0902e601`）

## 背景

r18 转存兜底上线后，用户解析 `mAVEwU6vYBS` 报新错误：

> 阿里转存后未返回直链：{"domain_id":"bj29","drive_id":"88300341","file_id":"6a8584...","revision_id":"6a8584...","method":"GET","url":"","expiration":"2026-08-19..."

转存成功（drive_id/file_id 都有了），但 `/v2/file/get_download_url` 返回 **`url:""` 空字符串**，且响应里没有 `cdn_url`/`internal_url`。

## 根因（alist issue #6644 + 阿里 PDS API 文档实证）

- 阿里 `api.alipan.com/v2/file/get_download_url` 对**部分文件（冷门资源/刚转存未预热）返回 `url:""`**，且不返回 `cdn_url`
- alist 方案：改用 **PDS 智能域名 `https://{domain_id}.api.aliyunpds.com/v2/file/get_download_url`** → 能拿到 `url` 或 `cdn_url`（cdn 更快），业务上先试 cdn 再回退普通直链
- 用户响应里的 `domain_id:"bj29"` 正好可构造 PDS 域：`https://bj29.api.aliyunpds.com/v2/file/get_download_url`

## r19 改动

`aliyunTransferAndGetUrl` 第 4 步改造：

1. 先 `api.alipan.com/v2/file/get_download_url` → 取 `url || cdn_url || internal_url || download_url || DownloadUrl`
2. **url 空且响应含 `domain_id`** → 用 `https://{domain_id}.api.aliyunpds.com/v2/file/get_download_url` 重试 → 取同样字段集合
3. 仍空 → 抛原错误（保留响应体便于诊断）

build 标签 r18 → r19。

## 测试

- 阿里单测 **20/20 全绿**：
  - A20（r19 关键）：转存后 url 空 + domain_id=bj29 → PDS 域兜底 → 拿到 cdn_url → 成功；断言发起了 `bj29.api.aliyunpds.com` 请求
- 全量回归 **96/96 全绿**（阿里20+百度20+夸克16+迅雷12+12328）

## 打包副本（src-tauri/target/release/extension/background.js，108,805 B）

| 标记 | 命中 |
|---|---|
| `build=r19` | 4 |
| `api.aliyunpds.com`（PDS 兜底） | 2 |
| `cdn_url` 字段 | 3 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,413,315 B
- MD5：`3f71d2aab7ba3d7726aa5c7e0902e601`

## 使用说明

装 r19 后重新解析 `mAVEwU6vYBS`：410 → 转存 → `api.alipan.com` 直链 url 空 → 自动 PDS 域（bj29.api.aliyunpds.com）兜底取 cdn_url → 下载。若仍失败，错误信息会带完整响应体便于下一步定位。

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "fix(aliyun): r19 转存后 get_download_url url 空 → PDS 域（{domain_id}.api.aliyunpds.com）兜底取 cdn_url（alist #6644 方案）"
  git push -u origin main && git push -f origin v26.08.19
  ```
