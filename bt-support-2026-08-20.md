# LeLeDownload 磁力/BT 下载支持（librqbit 嵌入式）

- 日期：2026-08-20
- 构建：`LeLeDownload_v26.08.20_x64-setup.exe`（4,379,970 B，MD5 `07118b567db396ff6618b19264d98cc7`）

## 功能

支持**磁力链接（magnet:?xt=urn:btih:...）**与 **.torrent 文件**下载，嵌入式 BT 客户端（无外部二进制）：

- 粘贴 magnet 链接或 .torrent 文件路径到下载框 → 自动识别为 BT 任务
- BT 任务独立区块展示：进度条、下载/上传速度、已下载/总大小、状态
- 支持暂停 / 恢复 / 删除（不删已下载文件）
- 下载到默认下载目录（或添加时指定目录）

## 技术方案：librqbit v9.0.0（纯 Rust）

选择理由：与项目 tokio/Rust 技术栈一致、无需捆绑 aria2c 外部 exe、活跃维护（2026-08-15 发布 v9）。

## 改动清单

### Rust 后端
- `src-tauri/Cargo.toml`：+`librqbit = "9"` +`hex = "0.4"`
- **`src-tauri/src/torrent.rs`（新增）**：
  - 全局懒初始化 `Session`（OnceLock + Mutex<Option<Arc<Session>>>）
  - `BT_TASKS`：info_hash(hex) → `Arc<ManagedTorrent>` 映射，任务 id 即 info_hash
  - `add_torrent`：magnet: / http(s) torrent URL / 本地 .torrent 路径三种来源
  - `task_stats` / `list_tasks` / `pause_task` / `resume_task` / `remove_task`（async）
  - `Session::delete` 删除（不删文件）
- `src-tauri/src/commands.rs`：+6 个命令（bt_add_torrent / bt_list_tasks / bt_task_stats / bt_pause / bt_resume / bt_remove）
- `src-tauri/src/main.rs`：mod torrent + 注册命令

### 前端
- `src/types/index.ts`：+`BtTask` 接口
- `src/App.tsx`：magnet/.torrent 识别 → `bt_add_torrent`；BT 任务轮询（2s）；BT 任务区块 UI（进度/速度/暂停/恢复/删除）
- `src/components/DownloadForm.tsx`：粘贴/拖拽过滤支持 magnet/.torrent

## librqbit v9 API 踩坑记录（沉淀）

1. `Session::new(dir)` 返回 **`Arc<Session>`**（不是 Session）
2. `add_torrent(self: &Arc<Self>, ...)` —— 必须用 Arc 调用
3. `AddTorrentOptions.output_folder` 是 **`Option<String>`**；`overwrite=true` 才可续传
4. `ManagedTorrentHandle` 未 re-export 到根 → 用 **`Arc<librqbit::ManagedTorrent>`**；`TorrentIdOrHash` 在 **`librqbit::api::TorrentIdOrHash`**
5. `info_hash().as_string()` = hex 任务 id；`TorrentStats`：progress_bytes/total_bytes/finished/state/live(下载速度 `Speed.as_bytes()`)
6. pause/resume/delete 在 **Session** 上（async）；**MutexGuard 不能跨 await**（future 非 Send）

## 验证

- `cargo check` 通过（librqbit v9 编译成功）
- 前端 `tsc --noEmit` 0 错误 + `vite build` 成功
- 完整 tauri build 成功，安装包 4.38MB（比上版 +1MB = BT 客户端代码）

## 待用户验证（装包后）

1. 复制一个 magnet 链接 → 粘贴到下载框 → 自动识别为 BT 任务并开始下载
2. 观察进度条/速度刷新（2s 轮询）
3. 暂停 → 恢复 → 删除 操作
4. 保存目录 = 默认下载目录（可在添加时指定）

## 已知限制 / 后续

- BT 任务不落 SQLite db（会话内有效，重启后丢失）——如需持久化可后续加
- 种子内多文件默认全部下载（可按需后续加 only_files 选择）
- DHT/tracker 依赖网络可达（国内网络一般可用）

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "feat(bt): 磁力/BT 下载支持（librqbit v9 嵌入式会话 + BT 任务 UI）"
  git push -u origin main && git push -f origin v26.08.20
  ```
