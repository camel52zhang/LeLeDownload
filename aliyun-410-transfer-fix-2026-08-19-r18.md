# 阿里云盘 r18 交付：get_share_link_download_url 410 转存兜底

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,413,308 B，MD5 `54d175c599582dc101cc3075de9858f1`）

## 背景

用户解析 `https://www.alipan.com/s/mAVEwU6vYBS` 报：

> [HTTP 410] https://api.alipan.com/v2/file/get_share_link_download_url 非 JSON 响应:

`get_share_link_download_url`（申请分享直链）返 HTTP 410 且 body 为空。之前代码只在 `file/list` 有 410 保护，取直链这一步 410 直接抛裸错。

## 根因（参考 netdisk-resolver-v1.4 aliyun/api.py 注释实证）

阿里对以下两种情况在**取直链接口**返 HTTP 410（空 body）：

1. **未登录申请直链** → 需要登录态（Authorization Bearer）
2. **已登录仍 410** → 该分享**禁止直接下载**（多见于版权/限速分享）

参考项目的解法（`_save_and_get_url`）：**转存到自己云盘再下载**——
`/v2/user/get` 拿默认 drive_id → `/v2/file/copy`（分享文件复制到自己网盘根目录）→ 若返回 async_task_id 则轮询 `/v2/async_task/get` → `/v2/file/get_download_url`（自己云盘直链）。

## r18 改动

`resolveAliyun` 新增 `aliyunTransferAndGetUrl(fileId)`（参考 netdisk-resolver-v1.4 aliyun/resolver.py）：

1. `POST /v2/user/get`（**不带 x-share-token**，否则被判「分享接口需登录」）→ `default_drive_id`
2. `POST /v2/file/copy`（share_id + file_id → to_drive_id=自己, to_parent_file_id=root, auto_rename）→ drive_id/file_id/async_task_id
3. 若有 async_task_id → 轮询 `POST /v2/async_task/get`（state=succeed/failed，超时 30s）
4. `POST /v2/file/get_download_url`（自己云盘，不带 x-share-token）→ 直链

取直链循环改造：`get_share_link_download_url` 抛 `[HTTP 410` 时 → 转存兜底，成功用转存直链（Referer 换 `https://www.aliyundrive.com/`）；转存失败抛清晰错误（如「无法转存（请确认已登录 alipan.com）」）。

⚠️ **副作用说明**：转存会把分享文件**复制到用户自己阿里云盘根目录**（与夸克转存相同，属阿里 410 限制下唯一的可行路径）。

build 标签 r17 → r18。

## 测试

- 阿里单测 **19/19 全绿**：
  - A18（r18 关键）：直链 410 → 转存链（user/get + file/copy + get_download_url）→ 转存直链成功 + Referer=aliyundrive.com + copy 带 share_id/to_drive_id + user/get 不带 x-share-token
  - A19：410 → 转存失败（无 default_drive_id）→ 抛「无法转存」
- 全量回归 **95/95 全绿**（阿里19+百度20+夸克16+迅雷12+12328）

## 打包副本（src-tauri/target/release/extension/background.js，108,033 B）

| 标记 | 命中 |
|---|---|
| `build=r18` | 4 |
| `aliyunTransferAndGetUrl` | 2 |
| `/v2/file/copy`（转存） | 1 |
| `/v2/file/get_download_url`（自有直链） | 1 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,413,308 B
- MD5：`54d175c599582dc101cc3075de9858f1`

## 使用说明

装 r18 后解析 `mAVEwU6vYBS`：
1. 先确保浏览器登录过 alipan.com（扩展自动读 refresh_token）
2. 解析时若分享禁止直接下载（410）→ 自动转存到你阿里云盘根目录 → 从你网盘取直链下载
3. 若提示「无法转存」→ 确认 alipan.com 登录态有效、网盘空间充足

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "fix(aliyun): r18 get_share_link_download_url 410 转存兜底（参考 netdisk-resolver：copy 到自己网盘 + get_download_url 取直链）"
  git push -u origin main && git push -f origin v26.08.19
  ```
