// Tauri Commands

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{Manager, State};
use tokio::sync::RwLock;

use crate::download::{DownloadManager, DownloadTask};
use crate::db::Database;
use crate::{NetdiskFilenames, NetdiskPending, PendingResolve};

// 用户首选下载目录的持久化文件（位于系统本地数据目录）。
// 设置面板保存时会写入此处；桥接(扩展)路径与 create_download 默认值都从这里读取，
// 确保「浏览器扩展触发的下载」也落到用户在设置里配置的首选目录，而非系统默认 Downloads。
fn settings_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("lele_download")
        .join("settings.json")
}

/// 读取用户配置的首选下载目录；未配置或文件不存在时返回 None，调用方应回退系统默认目录。
pub fn load_download_dir() -> Option<String> {
    let content = fs::read_to_string(settings_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("download_dir")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

/// 持久化首选下载目录到 settings.json，供桥接/默认路径读取。
pub fn save_download_dir(dir: &str) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Ok(());
    }
    let p = settings_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let obj = serde_json::json!({ "download_dir": dir });
    let s = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

fn get_default_save_dir() -> String {
    // 优先用用户配置的首选目录；未配置时回退系统默认 Downloads。
    load_download_dir().unwrap_or_else(|| {
        dirs::download_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .to_string_lossy()
            .to_string()
    })
}

#[tauri::command]
pub async fn create_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
    filenames: State<'_, NetdiskFilenames>,
    url: String,
    save_dir: Option<String>,
    headers: Option<HashMap<String, String>>,
    filename: Option<String>,
) -> Result<DownloadTask, String> {
    let save_directory = save_dir.unwrap_or_else(get_default_save_dir);
    // filename 优先链：
    //   1) 前端透传的真实文件名（网盘解析面板「加入下载」传入的 f.name）
    //   2) 兜底：网盘直链 URL 反查暂存表（若 filename 参数因故未到达 Rust 侧）
    //   3) 都拿不到 => 旧路径：extract_filename 按 URL 末段 / content-disposition 推导
    let resolved_name: Option<String> = match filename {
        Some(ref f) if !f.trim().is_empty() => Some(f.clone()),
        _ => filenames.0.lock().unwrap().get(&url).cloned(),
    };
    let name_source = if filename.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
        "arg"
    } else if resolved_name.is_some() {
        "stash"
    } else {
        "url"
    };
    tracing::info!(
        "[create_download] filename_source={} name={:?}",
        name_source,
        resolved_name
    );
    let task = download_manager
        .create_download(url, save_directory, headers, resolved_name)
        .await?;
    let _ = db.write().await.insert_task(&task);
    download_manager.start_download(task.id.clone()).await?;
    Ok(task)
}

/// 提交一个「网盘分享链接解析」请求，返回请求 id。
/// 扩展侧会轮询待办队列，在扩展内用已登录的 cookie 解析出直链后回传（cookie 不离开扩展）。
#[tauri::command]
pub fn request_netdisk_resolve(
    pending: State<'_, NetdiskPending>,
    url: String,
    pwd: Option<String>,
    platform: Option<String>,
) -> Result<String, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = crate::NETDISK_SEQ.fetch_add(1, Ordering::SeqCst);
    let id = format!("nk_{}_{}", ts, seq);
    let created_at = ts as u64;
    pending.lock().unwrap().insert(
        id.clone(),
        PendingResolve {
            url,
            pwd,
            platform,
            created_at,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn pause_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
    id: String,
) -> Result<(), String> {
    download_manager.pause_download(id.clone()).await?;
    if let Some(task) = download_manager.get_download(&id).await {
        let _ = db.write().await.update_task(&task);
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<(), String> {
    download_manager.resume_download(id).await
}

#[tauri::command]
pub async fn cancel_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
    id: String,
) -> Result<(), String> {
    download_manager.cancel_download(id.clone()).await?;
    if let Some(task) = download_manager.get_download(&id).await {
        let _ = db.write().await.update_task(&task);
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
    id: String,
) -> Result<(), String> {
    download_manager.remove_download(id.clone()).await?;
    let _ = db.write().await.delete_task(&id);
    Ok(())
}

#[tauri::command]
pub async fn get_downloads(
    download_manager: State<'_, Arc<DownloadManager>>,
) -> Result<Vec<DownloadTask>, String> {
    Ok(download_manager.get_all_downloads().await)
}

#[tauri::command]
pub async fn get_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    id: String,
) -> Result<Option<DownloadTask>, String> {
    Ok(download_manager.get_download(&id).await)
}

#[tauri::command]
pub async fn clear_completed(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
) -> Result<(), String> {
    download_manager.clear_completed().await;
    let _ = db.write().await.clear_completed();
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    pub max_threads: u32,
    pub max_concurrent: u32,
    pub download_dir: String,
    pub auto_start: bool,
    pub auto_open_file: bool,
    pub auto_open_folder: bool,
    pub notifications: bool,
    pub speed_limit_kb: u64,
}

impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            max_threads: 16,
            max_concurrent: 3,
            download_dir: get_default_save_dir(),
            auto_start: true,
            auto_open_file: false,
            auto_open_folder: true,
            notifications: true,
            speed_limit_kb: 0,
        }
    }
}

#[tauri::command]
pub fn get_download_settings() -> DownloadSettings {
    DownloadSettings::default()
}

#[tauri::command]
pub async fn update_download_settings(
    download_manager: State<'_, Arc<DownloadManager>>,
    settings: DownloadSettings,
) -> Result<(), String> {
    download_manager.update_config(
        settings.max_threads as usize,
        settings.max_concurrent as usize,
        settings.speed_limit_kb,
    ).await;
    // 修复：持久化首选下载目录，使浏览器扩展/桥接路径也使用用户配置目录
    // （此前该字段被忽略，导致扩展触发的下载落到系统默认 Downloads）。
    if let Err(e) = save_download_dir(&settings.download_dir) {
        tracing::warn!("保存下载目录失败: {}", e);
    }
    tracing::info!("Updated download settings: {:?}", settings);
    Ok(())
}

#[tauri::command]
pub fn get_default_download_dir() -> String {
    get_default_save_dir()
}

#[tauri::command]
pub async fn select_download_dir() -> Result<String, String> {
    use std::process::Command;

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select download folder"
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
} else {
    Write-Output ""
}
"#
    .to_string();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // 修复(P1)：FolderBrowserDialog 是阻塞式 WinForms 对话框，包进 spawn_blocking
        // 避免阻塞 tokio worker 线程（原实现在 async fn 内同步 .output()）。
        let path = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let output = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Execute failed: {}", e))?;
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                Err("No folder selected".to_string())
            } else {
                Ok(path)
            }
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))??;
        Ok(path)
    }

    #[cfg(not(windows))]
    {
        tracing::warn!("Folder picker not implemented for non-Windows platforms");
        Err("Folder picker is only supported on Windows in this version".to_string())
    }
}

#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
pub async fn open_folder(file_path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    tracing::info!("open_folder called with: {}", file_path);

    // 基础校验：仅拒绝明显的路径穿越，避免打开非预期目录。
    // 注意：下方使用 Command::new("explorer.exe").arg(&folder)（非 shell），
    // 不存在命令注入风险，因此无需拒绝 ( ) $ ` 等合法出现在路径中的字符
    // （例如 "Program Files (x86)"）。
    if file_path.contains("..") {
        return Err("Path contains invalid characters".to_string());
    }

    // Get parent directory from file path
    let path = Path::new(&file_path);
    let folder = path.parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());

    let folder = if folder.is_empty() { file_path.clone() } else { folder };
    tracing::info!("Opening folder: {}", folder);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // 先校验目标文件夹是否真实存在，给出比 explorer 弹窗更友好的错误。
        if !Path::new(&folder).is_dir() {
            let msg = format!("文件夹不存在或不是目录: {}", folder);
            tracing::error!("{}", msg);
            return Err(msg);
        }

        // 关键修复：explorer.exe 是 GUI 程序，退出码不可靠（成功时也可能返回非 0），
        // 且不会向 stderr/stdout 输出任何信息。旧实现用 .output() 读取退出码并判定
        // 失败，导致每次打开文件夹都误报 "Explorer error:"（日志中空 stderr 即为佐证）。
        // 改用 spawn 启动（不等待、不读退出码），仅当进程无法启动（如 explorer 不在
        // PATH）时才视为真实错误；CREATE_NO_WINDOW 避免闪现黑框。
        match Command::new("explorer.exe")
            .arg(&folder)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_child) => {
                tracing::info!("Explorer launched for folder: {}", folder);
            }
            Err(e) => {
                let msg = format!("无法启动资源管理器: {}", e);
                tracing::error!("{}", msg);
                return Err(msg);
            }
        }
    }

    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        Command::new("open").arg(&folder).spawn().ok();
        #[cfg(target_os = "linux")]
        Command::new("xdg-open").arg(&folder).spawn().ok();
    }

    Ok(())
}

#[tauri::command]
pub fn open_extension_folder(app: tauri::AppHandle) -> Result<(), String> {
    // 安装目录下的 extension/ 文件夹（nsis resources 映射），explorer 打开供用户"加载已解压扩展"
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let ext_dir = res.join("extension");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("explorer.exe")
            .arg(&ext_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        let _ = ext_dir;
    }
    Ok(())
}


// ===========================================================================
// BitTorrent / 磁力下载命令（librqbit 嵌入式会话，见 torrent.rs）
// ===========================================================================

/// 添加磁力链接或 .torrent 文件下载任务。
/// source: "magnet:?xt=..." / "http(s)://.../x.torrent" / 本地 ".torrent 文件路径"
/// save_dir 可选（缺省用用户首选下载目录）
/// only_files 可选：只下载这些文件索引（来自 bt_get_file_list 的 files[].index）；
///   None = 全量下载（旧行为，HTTP 路由 / 用户确认降级走这条）
/// metadata_cache_key 可选：bt_get_file_list 返回的 info_hash，命中进程内缓存可跳过二次 metadata 互换
#[tauri::command]
pub async fn bt_add_torrent(
    source: String,
    save_dir: Option<String>,
    only_files: Option<Vec<usize>>,
    metadata_cache_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let default_dir = std::path::PathBuf::from(get_default_save_dir());
    crate::torrent::add_torrent(source, save_dir, default_dir, only_files, metadata_cache_key).await
}

/// 取磁力 / .torrent 内的完整文件清单（走 list_only 真实换 metadata，不下载）。
/// 返回 { info_hash, name, can_download, reason?, message, total_bytes, file_count, seen_peers, files[] }，
/// files[i] = { index, name, components[], length }。index 即 bt_add_torrent.only_files 的索引契约。
/// can_download=false（reason="no_metadata"）表示当前拿不到清单，前端应弹确认让用户决定是否降级全量。
#[tauri::command]
pub async fn bt_get_file_list(source: String) -> Result<serde_json::Value, String> {
    let default_dir = std::path::PathBuf::from(get_default_save_dir());
    crate::torrent::get_file_list(source, default_dir).await
}

// Phase 2（下载中改选，接口已预留）：librqbit 支持运行时改选
// Session::update_only_files(&handle, &HashSet<usize>)，实现即下述命令，本期不做。
// #[tauri::command]
// pub async fn bt_set_only_files(id: String, only_files: Vec<usize>) -> Result<(), String> {
//     crate::torrent::set_only_files(&id, only_files).await
// }

/// 列出所有 BT 任务（含进度/速度/状态）
#[tauri::command]
pub fn bt_list_tasks() -> Vec<serde_json::Value> {
    crate::torrent::list_tasks()
}

/// 添加前快速预检磁力资源是否有活跃做种者（走 librqbit list_only 真实取 metadata，不下载）。
/// 返回 { can_download: bool, reason?, name?, file_count?, total_bytes?, seen_peers?, message }。
/// can_download=false 表示资源当前无活跃做种者，前端应弹确认让用户决定是否仍添加。
#[tauri::command]
pub async fn bt_precheck(source: String) -> Result<serde_json::Value, String> {
    let default_dir = std::path::PathBuf::from(get_default_save_dir());
    crate::torrent::precheck_torrent(source, default_dir).await
}

/// 查询单个 BT 任务状态
#[tauri::command]
pub fn bt_task_stats(id: String) -> Option<serde_json::Value> {
    crate::torrent::task_stats(&id)
}

/// 暂停 BT 任务
#[tauri::command]
pub async fn bt_pause(id: String) -> Result<(), String> {
    crate::torrent::pause_task(&id).await
}

/// 恢复 BT 任务
#[tauri::command]
pub async fn bt_resume(id: String) -> Result<(), String> {
    crate::torrent::resume_task(&id).await
}

/// 删除 BT 任务（停止下载，不删已下载文件）
#[tauri::command]
pub async fn bt_remove(id: String) -> Result<(), String> {
    crate::torrent::remove_task(&id).await
}
