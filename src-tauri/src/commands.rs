// Tauri Commands

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::RwLock;

use crate::download::{DownloadManager, DownloadTask};
use crate::db::Database;

fn get_default_save_dir() -> String {
    dirs::download_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub async fn create_download(
    download_manager: State<'_, Arc<DownloadManager>>,
    db: State<'_, Arc<RwLock<Database>>>,
    url: String,
    save_dir: Option<String>,
) -> Result<DownloadTask, String> {
    let save_directory = save_dir.unwrap_or_else(get_default_save_dir);
    let task = download_manager.create_download(url, save_directory).await?;
    let _ = db.write().await.insert_task(&task);
    download_manager.start_download(task.id.clone()).await?;
    Ok(task)
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
        // Use explorer.exe directly with proper argument passing (no string interpolation)
        let output = Command::new("explorer.exe")
            .arg(&folder)
            .output()
            .map_err(|e| {
                let msg = format!("Failed to open explorer: {}", e);
                tracing::error!("{}", msg);
                msg
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let msg = format!("Explorer error: {}", stderr);
            tracing::error!("{}", msg);
            return Err(msg);
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

