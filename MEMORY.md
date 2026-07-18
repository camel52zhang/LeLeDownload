# 乐乐下载器 - 代码修复记忆

## 2026-07-01 修复"打开目录"功能

### 问题描述
点击已完成下载旁边的"打开目录"按钮（文件夹图标）无效，无任何反应。

### 根本原因
1. 前端使用 `@tauri-apps/plugin-shell` 的 `open()` 函数
2. 该函数只支持 URL（http://、https://），不支持本地文件路径
3. 错误信息：`Scoped command argument at position 0 was found, but failed regex validation`

### 修复方案
1. **前端** (`src/components/DownloadItem.tsx`)
   - 移除 `@tauri-apps/plugin-shell` 的 `open` 导入
   - 改用 `invoke('open_folder')` 调用后端 Rust 命令

2. **后端** (`src-tauri/src/commands.rs`)
   - 使用 PowerShell 执行 `explorer.exe` 打开目录
   - 命令：`Start-Process explorer.exe -ArgumentList "路径"`

### 测试结果
✅ 修复成功

---

## 2026-07-02 优化与功能增强

### 新增功能
1. **自动打开文件夹**
   - 在设置中开启"下载完成后打开文件夹"开关
   - 下载完成后自动打开文件所在目录

2. **下载完成通知**
   - 使用 `@tauri-apps/plugin-notification` 插件
   - 在设置中开启"下载完成通知"开关
   - 下载完成后发送系统通知

3. **批量删除**
   - 在"已完成"筛选状态下显示复选框
   - 支持全选和批量删除功能

4. **操作按钮始终可见**
   - 已完成和失败状态的操作按钮始终可见（不再需要悬停）

### 修改文件
- `src/App.tsx` - 添加通知、批量选择、自动打开文件夹
- `src/components/DownloadItem.tsx` - 添加按钮可见性
- `src-tauri/src/main.rs` - 注册 notification 插件
- `src-tauri/Cargo.toml` - 添加 tauri-plugin-notification
- `src-tauri/capabilities/default.json` - 添加通知权限

### 已知问题
- Rust 编译警告（未使用的代码，预留扩展用，可忽略）

---

## 2026-07-02 下载模块自适应宽度优化

### 问题描述
窗口缩小后，右侧的"已完成"状态标签、打开目录、复制链接、删除按钮被右侧边缘遮盖。

### 根本原因
1. 下载卡片外层 flex 容器没有 `flex-wrap`，空间不足时内容溢出
2. 图标、状态标签缺少 `flex-shrink-0`，可能被压缩
3. 文件名 `<h3>` 缺少 `min-w-0`，truncate 无法正确截断
4. 操作按钮容器缺少 `ml-auto`，换行后无法靠右对齐

### 修复方案
1. **`src/components/DownloadItem.tsx`**
   - 外层容器加 `flex-wrap`：空间不足时操作按钮自动换行
   - 图标容器加 `flex-shrink-0`：防止图标被压缩
   - 操作按钮容器加 `ml-auto`：始终靠右对齐
   - 文件名/状态行加 `min-w-0`：确保子元素可收缩
   - 状态标签加 `flex-shrink-0`：防止 badge 被压缩
   - 文件名 `<h3>` 加 `min-w-0`：配合 truncate 正确溢出省略

2. **`src/App.tsx`**
   - 主内容区内边距从 `p-6` 改为 `p-3 sm:p-6`：小屏幕减少留白

### 行为变化
- 窗口宽阔时：图标 | 内容 | 操作按钮（同行显示）
- 窗口缩小时：图标 | 内容（第一行），操作按钮自动换行到右侧（第二行）

### 测试结果
✅ 前端构建通过，.exe 重建成功（6.9 MB）
