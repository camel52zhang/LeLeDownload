# LeLeDownload BT 添加任务卡死修复（超时兜底）

- 日期：2026-08-20
- 构建：`LeLeDownload_v26.08.20_x64-setup.exe`（4,381,100 B，MD5 `3063cd460d4dbadec915edd19d71753f`）

## 问题

用户截图：粘贴 magnet 后按钮永远转圈"添加中"——`bt_add_torrent` invoke 永不返回，前端 Promise 永远 pending，`finally { setIsAdding(false) }` 永远不执行。

截图还显示 6 个 HTTP 任务全"应用重启/下载中断"——说明启动后 librqbit 也未就绪（之前用户没注意）。

## 根因

**librqbit v9 的网络初始化阻塞**：`Session::new` 启动 DHT 节点 + UTP/TCP listener（bind 6881 等端口）。在受限网络/防火墙环境，这步**永不返回**→ invoke 永远 pending → UI 永远卡"添加中"。

不是代码 bug，是 librqbit 在特定环境的网络初始化行为。

## 修复：三层超时兜底

| 层 | 超时 | 错误文案 |
|---|---|---|
| 后端 `ensure_session` (`Session::new`) | **15s** | "BT 会话启动超时：librqbit 启动 DHT/UTP listener 阻塞，可能被防火墙拦截或 DHT 引导失败。请检查网络/防火墙后重试" |
| 后端 `add_torrent` (`session.add_torrent`) | **30s** | "添加 BT 任务超时：磁力解析或 peer 发现阻塞。请检查网络或换一个磁力试试" |
| 前端 `invoke` (`withTimeout`) | **40s** | 同上 + alert 弹窗 + `finally` 重置按钮 |

后端用 `tokio::time::timeout(Duration, future)` 包裹；前端用 `Promise.race` 包 setTimeout。

## 改动

- `src-tauri/src/torrent.rs`：ensure_session + add_torrent 加 tokio timeout
- `src/App.tsx`：BT 分支 invoke 包 40s `withTimeout`，alert 用 `err.message`（之前 `alert('...'+err)` 会显示 `[object Object]`）

## 装机后

1. 再粘贴同样的 magnet → **30s 后会弹清晰提示**（不再卡死）
2. 如果 30s 超时：检查 Windows 防火墙是否放行 `LeLeDownload.exe` 出站（librqbit 需 6881 端口对外连接）
3. 后续可加"无 DHT/无 tracker"纯 magnet 模式（做不了，但至少能诊断是网络问题）

## 遗留

- 改动未 commit/push（沙箱无凭据）