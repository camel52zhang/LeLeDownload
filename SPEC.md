# DownloadMaster - 类似IDM的下载管理器

## 技术栈
- Frontend: React 18 + TypeScript + TailwindCSS
- Backend: Tauri 2.x (Rust)
- HTTP: reqwest (多线程分片下载)
- Database: SQLite

## 项目结构
```
lele_download/
├── src/                  # React前端
│   ├── components/       # UI组件
│   ├── hooks/           # 自定义Hooks
│   ├── types/           # TypeScript类型
│   └── App.tsx          # 主应用
├── src-tauri/           # Rust后端
│   ├── src/
│   │   ├── main.rs      # 入口
│   │   ├── download.rs  # 下载引擎
│   │   ├── db.rs        # SQLite操作
│   │   └── commands.rs   # Tauri命令
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

## 核心特性 (v1.0)
- ✅ 多线程分片下载 (最多16线程)
- ✅ 断点续传
- ✅ 下载队列管理
- ✅ 下载速度/进度实时显示
- ✅ 新建下载任务 (URL输入)
- ✅ 暂停/恢复/取消/删除
- ✅ 下载历史记录