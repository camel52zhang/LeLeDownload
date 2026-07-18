// Download Engine - Multi-threaded chunked download
use futures_util::stream::TryStreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Seek, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock as TokioRwLock;
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub total_size: u64,
    pub downloaded_size: u64,
    pub speed: f64,
    pub status: DownloadStatus,
    pub progress: f64,
    pub thread_count: usize,
    pub retry_count: u32,
    pub max_retries: u32,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub save_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Pending,
    Downloading,
    Paused,
    Completed,
    Failed,
}

impl Default for DownloadStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct ChunkInfo {
    start: u64,
    end: u64,
    downloaded: u64,
}

fn get_available_space(path: &str) -> Result<u64, String> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        
        let wide_path: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        
        let mut free_bytes_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free_bytes: u64 = 0;
        
        unsafe {
            let result = windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide_path.as_ptr(),
                &mut free_bytes_available,
                &mut total_bytes,
                &mut total_free_bytes,
            );
            
            if result == 0 {
                return Err("Get disk space failed".to_string());
            }
        }
        
        Ok(free_bytes_available)
    }
    
    #[cfg(not(windows))]
    {
        Ok(1024 * 1024 * 1024 * 100)
    }
}

fn check_disk_space(path: &str, estimated_size: u64) -> Result<(), String> {
    let available = get_available_space(path)?;
    let required = std::cmp::max(estimated_size + 1024 * 1024 * 100, (estimated_size as f64 * 1.1) as u64);
    
    if available < required {
        return Err(format!(
            "Disk space insufficient: available {} / required {}",
            format_bytes_simple(available),
            format_bytes_simple(required)
        ));
    }
    Ok(())
}

fn format_bytes_simple(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    
    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// 清洗文件名：去除路径分隔符、Windows/macOS 非法字符与控制字符，
/// 并剥离目录部分（防止 content-disposition / URL 中的路径穿越）。
fn sanitize_filename(name: &str) -> String {
    let base = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(name);

    let illegal: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    let mut out: String = base
        .chars()
        .filter(|c| !illegal.contains(c) && !c.is_control())
        .collect();

    // 去除首尾空白与句点（Windows 不允许文件名以 . 结尾）
    let trimmed = out.trim().trim_matches('.');
    out = trimmed.to_string();

    // 限制长度，避免超长文件名
    if out.len() > 200 {
        let mut cut = out;
        let _ = cut.split_off(200);
        out = cut;
    }
    out
}

/// 解析 content-disposition 头：优先 RFC 5987 `filename*=UTF-8''...`（Unicode），
/// 再回退到传统 `filename="..."`。两者都无则返回 None。
fn parse_content_disposition(disposition: &str) -> Option<String> {
    for seg in disposition.split(';') {
        let seg = seg.trim();
        if seg.to_lowercase().starts_with("filename*=") {
            let val = &seg["filename*=".len()..];
            // 形如 UTF-8''%E4%B8%AD%E6%96%87.txt
            if let Some(encoded) = val.splitn(2, "''").nth(1) {
                let decoded = percent_decode(encoded);
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            }
        }
    }
    if let Some(name) = disposition.split("filename=").nth(1) {
        let name = name.split(';').next().unwrap_or(name);
        let name = name.trim_matches('"').trim_matches('\'').trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct DownloadConfig {
    pub max_threads: usize,
    pub max_concurrent: usize,
    pub speed_limit_kb: u64,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            max_threads: 16,
            max_concurrent: 3,
            speed_limit_kb: 0,
        }
    }
}

/// 共享令牌桶限速器：同一任务的所有分片共享一把限速器，
/// 保证聚合速率不超过 speed_limit（0 表示不限速）。
/// limit_bps 用 Arc<AtomicU64> 共享，acquire 每次动态读取，
/// 因此设置变更（含下载中改限速）能通过 manager 的共享 atomic 实时生效。
#[derive(Clone)]
struct RateLimiter {
    limit_bps: Arc<AtomicU64>, // 每秒字节数，0 = 不限速
    state: Arc<TokioMutex<RateState>>,
}

struct RateState {
    last_update: Instant,
    tokens: f64, // 当前可用字节额度
}

impl RateLimiter {
    fn new(limit_bps: Arc<AtomicU64>) -> Self {
        let initial = limit_bps.load(Ordering::Relaxed);
        RateLimiter {
            limit_bps,
            state: Arc::new(TokioMutex::new(RateState {
                last_update: Instant::now(),
                tokens: initial as f64,
            })),
        }
    }

    /// 申请 n 字节的发送额度；若超过限速则异步等待直到额度足够。
    async fn acquire(&self, n: u64) {
        let limit = self.limit_bps.load(Ordering::Relaxed);
        if limit == 0 {
            return;
        }
        let n = n as f64;
        let limit_f = limit as f64;
        loop {
            let mut st = self.state.lock().await;
            let now = Instant::now();
            let elapsed = now.duration_since(st.last_update).as_secs_f64();
            st.last_update = now;
            // 经过时间补充额度；限制最大囤积（突发上限 = 1 秒额度，或单次请求量，避免大块死锁）
            let cap = limit_f.max(n);
            st.tokens = (st.tokens + elapsed * limit_f).min(cap);
            if st.tokens >= n {
                st.tokens -= n;
                return;
            }
            let deficit = (n - st.tokens) / limit_f;
            drop(st);
            tokio::time::sleep(Duration::from_secs_f64(deficit)).await;
        }
    }
}

pub struct DownloadManager {
    tasks: Arc<TokioRwLock<HashMap<String, DownloadTask>>>,
    cancel_flags: Arc<TokioRwLock<HashMap<String, Arc<AtomicBool>>>>,
    app_handle: tauri::AppHandle,
    config: Arc<TokioRwLock<DownloadConfig>>,
    // 共享限速值（字节/秒，0=不限速）：所有进行中下载的限速器引用同一份，
    // 设置变更时实时更新，使"下载中改限速"也能立即生效。
    speed_limit_bps: Arc<AtomicU64>,
    client: reqwest::Client,
    // 并发控制：当前活跃下载数 + 等待通知（可在设置中动态调整上限）
    active_count: Arc<AtomicUsize>,
    concurrency_notify: Arc<tokio::sync::Notify>,
}


async fn stream_next_with_retry<S, T, E>(
    stream: &mut S,
    max_retries: u32,
) -> Result<Option<T>, Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::stream::Stream<Item = Result<T, E>> + Unpin,
    E: std::error::Error + Send + Sync + 'static,
{
    let mut last_err: Option<Box<dyn std::error::Error + Send + Sync>> = None;
    for attempt in 0..=max_retries {
        match stream.try_next().await {
            Ok(Some(chunk)) => return Ok(Some(chunk)),
            Ok(None) => return Ok(None),
            Err(e) => {
                tracing::warn!("Stream read failed (attempt {}/{}): {}", attempt + 1, max_retries + 1, e);
                last_err = Some(Box::new(e));
                if attempt < max_retries {
                    tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1) as u64)).await;
                }
            }
        }
    }
    Err(last_err.unwrap())
}

impl DownloadManager {
    pub fn new(app_handle: tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let config = DownloadConfig::default();
        Ok(Self {
            tasks: Arc::new(TokioRwLock::new(HashMap::new())),
            cancel_flags: Arc::new(TokioRwLock::new(HashMap::new())),
            app_handle,
            config: Arc::new(TokioRwLock::new(config.clone())),
            speed_limit_bps: Arc::new(AtomicU64::new(0)),
            client: reqwest::Client::builder()
                .user_agent("LeLe-Download/1.0")
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(60))
                .no_gzip()
                .no_deflate()
                .no_brotli()
                .build()
                .unwrap_or_default(),
            active_count: Arc::new(AtomicUsize::new(0)),
            concurrency_notify: Arc::new(tokio::sync::Notify::new()),
        })
    }

    pub async fn update_config(&self, max_threads: usize, max_concurrent: usize, speed_limit_kb: u64) {
        let mut cfg = self.config.write().await;
        cfg.max_threads = max_threads.max(1).min(32);
        cfg.max_concurrent = max_concurrent.max(1).min(10);
        cfg.speed_limit_kb = speed_limit_kb;
        // 实时更新共享限速 atomic，使进行中的下载也能立即应用新限速
        self.speed_limit_bps.store(speed_limit_kb.saturating_mul(1024), Ordering::Relaxed);
    }

    pub async fn create_download(
        &self,
        url: String,
        save_dir: String,
    ) -> Result<DownloadTask, String> {
        let filename = self.extract_filename(&url).await?;

        let save_path = PathBuf::from(&save_dir);
        fs::create_dir_all(&save_path).map_err(|e| e.to_string())?;

        if let Err(e) = check_disk_space(&save_dir, 100 * 1024 * 1024) {
            return Err(e);
        }

        // 使用配置中的线程数，使设置面板生效（不再硬编码 16）
        let thread_count = self.config.read().await.max_threads;

        let id = Uuid::new_v4().to_string();
        let task = DownloadTask {
            id: id.clone(),
            url: url.clone(),
            filename: filename.clone(),
            total_size: 0,
            downloaded_size: 0,
            speed: 0.0,
            status: DownloadStatus::Pending,
            progress: 0.0,
            thread_count,
            retry_count: 0,
            max_retries: 3,
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            error: None,
            save_path: PathBuf::from(&save_dir)
                .join(&filename)
                .to_string_lossy()
                .to_string(),
        };

        self.tasks.write().await.insert(id.clone(), task.clone());
        self.cancel_flags.write().await.insert(id.clone(), Arc::new(AtomicBool::new(false)));

        // 主动推送"任务已创建"事件：前端（含浏览器扩展下发的任务）据此立即刷新列表，
        // 否则只能等 download-progress/completed 事件——而它们只更新已有任务、无法新增，
        // 会导致通过扩展创建的任务延迟出现（甚至下载完成后才显示）。
        let _ = self.app_handle.emit("download-created", &task);

        Ok(task)
    }

    pub async fn start_download(
        &self,
        task_id: String,
    ) -> Result<(), String> {
        let task = {
            let tasks = self.tasks.read().await;
            tasks.get(&task_id).cloned().ok_or("Task not found")?
        };

        {
            let flags = self.cancel_flags.read().await;
            if let Some(flag) = flags.get(&task_id) {
                flag.store(false, Ordering::Relaxed);
            }
        }

        {
            let mut tasks = self.tasks.write().await;
            if let Some(t) = tasks.get_mut(&task_id) {
                t.status = DownloadStatus::Downloading;
            }
        }

        // clone 所有需要传入后台任务的共享 Arc 字段（&self 无法移入 'static spawn，必须先克隆）
        let (cancel_flags, tasks, app_handle, config, client, active_count, concurrency_notify, speed_limit) = (
            self.cancel_flags.clone(),
            self.tasks.clone(),
            self.app_handle.clone(),
            self.config.clone(),
            self.client.clone(),
            self.active_count.clone(),
            self.concurrency_notify.clone(),
            self.speed_limit_bps.clone(),
        );

        tokio::spawn(async move {
            // 并发闸门：活跃数 < config.max_concurrent 才放行，否则等待空闲名额
            loop {
                let max = config.read().await.max_concurrent.max(1);
                let n = active_count.fetch_add(1, Ordering::Relaxed);
                if n < max {
                    break;
                }
                active_count.fetch_sub(1, Ordering::Relaxed);
                concurrency_notify.notified().await;
            }

            let result = Self::download_file(
                task_id.clone(),
                task.url.clone(),
                task.save_path.clone(),
                tasks.clone(),
                cancel_flags.clone(),
                app_handle.clone(),
                config.clone(),
                speed_limit,
                client,
            ).await;

            // 释放并发名额并唤醒等待者
            active_count.fetch_sub(1, Ordering::Relaxed);
            concurrency_notify.notify_one();

            if let Err(e) = result {
                tracing::error!("Download failed: {}", e);
                if let Some(t) = tasks.write().await.get_mut(&task_id) {
                    t.status = DownloadStatus::Failed;
                    t.error = Some(e.to_string());
                }
                let _ = app_handle.emit("download-failed", (&task_id, e.to_string()));
            }
        });

        Ok(())
    }

    async fn download_file(
        task_id: String,
        url: String,
        save_path: String,
        tasks: Arc<TokioRwLock<HashMap<String, DownloadTask>>>,
        cancel_flags: Arc<TokioRwLock<HashMap<String, Arc<AtomicBool>>>>,
        app_handle: tauri::AppHandle,
        config: Arc<TokioRwLock<DownloadConfig>>,
        speed_limit_bps: Arc<AtomicU64>,
        client: reqwest::Client,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // HEAD 探测；部分 CDN/对象存储对 HEAD 返回 405/403，fallback 到 GET Range:0-0 拿 headers
        let head_response = match client.head(&url).send().await {
            Ok(r) if r.status().is_success() || r.status() == reqwest::StatusCode::PARTIAL_CONTENT => r,
            _ => client.get(&url).header("Range", "bytes=0-0").send().await?,
        };
        
        let accept_ranges = head_response
            .headers()
            .get("accept-ranges")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == "bytes")
            .unwrap_or(false);
        
        let total_size = head_response.content_length().unwrap_or(0);

        // 修复(P1)：用真实 content-length 校验磁盘空间（create_download 仅 100MB 兜底）
        if total_size > 0 {
            if let Some(parent) = std::path::Path::new(&save_path).parent().and_then(|p| p.to_str()) {
                if let Err(e) = check_disk_space(parent, total_size) {
                    return Err(e.into());
                }
            }
        }

        tracing::info!("File size: {}, Accept ranges: {}", total_size, accept_ranges);
        
        {
            let mut guard = tasks.write().await;
            if let Some(t) = guard.get_mut(&task_id) {
                t.total_size = total_size;
                let initial_progress = serde_json::json!({
                    "id": task_id,
                    "downloaded_size": 0,
                    "speed": 0,
                    "progress": 0,
                    "total_size": total_size,
                    "status": "downloading"
                });
                let _ = app_handle.emit("download-progress", initial_progress);
            }
        }
        
        let max_threads = config.read().await.max_threads;
        // 共享限速器：同一任务的所有分片/单线程下载共享一把，引用 manager 的共享 atomic，
        // 保证聚合速率受控且"下载中改限速"能实时生效
        let rate_limiter = RateLimiter::new(speed_limit_bps.clone());

        if !accept_ranges || total_size < 512 * 1024 {
            Self::download_single(
                task_id,
                url,
                save_path,
                tasks,
                cancel_flags,
                app_handle,
                rate_limiter.clone(),
                client,
            ).await
        } else {
            // Multi-threaded chunked download（支持断点续传：已完成的 .part 分片直接跳过，
            // 部分下载的分片从已下载字节处 Range 续传）
            let chunk_size = (total_size / max_threads as u64).max(256 * 1024);
            let mut handles: Vec<tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>> = Vec::new();
            let mut num_chunks: u32 = 0;

            // 共享进度计数器：已跳过分片字节（在循环中通过 fetch_add 计入）+ 正在下载分片的实时字节
            let downloaded_total = Arc::new(AtomicU64::new(0));

            for i in 0..max_threads {
                let start = i as u64 * chunk_size;
                let end = if i == max_threads - 1 {
                    total_size.saturating_sub(1)
                } else {
                    (i + 1) as u64 * chunk_size - 1
                };

                if start > end || start >= total_size {
                    continue;
                }
                let end = end.min(total_size - 1);
                // 统计所有有效分片（含已完整跳过的），保证合并时能按顺序拼接全部 .part.N
                num_chunks += 1;

                let resume_from = {
                    let part = format!("{}.part.{}", save_path, i);
                    fs::metadata(&part).map(|m| m.len()).unwrap_or(0)
                };
                let expected_len = end - start + 1;

                if resume_from >= expected_len {
                    // 该分片已完整下载，直接跳过（其 .part.N 仍参与合并）
                    // 把已跳过字节计入共享进度计数器，避免续传时进度从 0% 开始
                    // 修复(P0)：若曾调大 max_threads 致 chunk_size 变小，旧 .part.N 会大于当前
                    // expected_len，merge 时拼入多余字节会损坏最终文件 → 此处截断到 expected_len。
                    if resume_from > expected_len {
                        let part = format!("{}.part.{}", save_path, i);
                        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&part) {
                            let _ = f.set_len(expected_len);
                        }
                    }
                    downloaded_total.fetch_add(expected_len, Ordering::Relaxed);
                    continue;
                }

                let url = url.clone();
                let save_path = save_path.clone();
                let task_id_for_spawn = task_id.clone();
                let cancel_flags = cancel_flags.clone();
                // 共享同一把进度计数器：各分片用 fetch_add 累加实时下载字节，
                // 进度上报任务读取的也是它，保证进度条实时推进（而非冻结在跳过字节处）。
                let downloaded_total = downloaded_total.clone();
                let client = client.clone();
                let rate_limiter_clone = rate_limiter.clone();

                handles.push(tokio::spawn(async move {
                    Self::download_chunk_to_temp(
                        task_id_for_spawn,
                        url,
                        save_path,
                        start,
                        end,
                        i,
                        resume_from,
                        cancel_flags,
                        downloaded_total,
                        rate_limiter_clone.clone(),
                        client,
                    ).await
                }));
            }

            // 进度统计：已跳过分片的字节（已在 downloaded_total 中计入 skipped_bytes）
            // + 正在下载分片的实时字节（各分片 fetch_add 累加）。复用循环前声明的同一把共享计数器。
            let start_time = Instant::now();

            // Progress reporting task
            let tasks_clone = tasks.clone();
            let app_handle_clone = app_handle.clone();
            let task_id_progress = task_id.clone();

            let downloaded_total_clone = downloaded_total.clone();
            let total_size_clone = total_size;
            let start_time_clone = start_time;

            let progress_handle = tokio::spawn(async move {
                let mut last_update = Instant::now();

                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;

                    let downloaded = downloaded_total_clone.load(Ordering::Relaxed);
                    let elapsed = start_time_clone.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 { downloaded as f64 / elapsed } else { 0.0 };

                    if let Some(t) = tasks_clone.write().await.get_mut(&task_id_progress) {
                        t.downloaded_size = downloaded;
                        t.speed = speed;
                        t.progress = if total_size_clone > 0 {
                            (downloaded as f64 / total_size_clone as f64) * 100.0
                        } else {
                            0.0
                        };

                        if last_update.elapsed() > Duration::from_millis(300) {
                            let progress = serde_json::json!({
                                "id": task_id_progress,
                                "downloaded_size": downloaded,
                                "speed": speed,
                                "progress": t.progress,
                                "total_size": total_size_clone,
                                "status": "downloading"
                            });
                            let _ = app_handle_clone.emit("download-progress", progress);
                            last_update = Instant::now();
                        }
                    }

                    if downloaded >= total_size_clone && total_size_clone > 0 {
                        break;
                    }
                }
            });

            // Wait for all chunks to complete
            let mut all_success = true;
            for handle in handles {
                match handle.await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        tracing::error!("Chunk download error: {}", e);
                        all_success = false;
                    }
                    Err(e) => {
                        tracing::error!("Join error: {}", e);
                        all_success = false;
                    }
                }
            }

            // Stop progress reporter
            progress_handle.abort();
            let _ = progress_handle.await;

            // 修复(P0)：pause/cancel 共用 cancel_flag，分片检测到 flag 会提前返回 Ok，
            // 此时 all_success 仍为 true，但分片并未下完。若直接 merge 会产出损坏文件，
            // 并把状态覆盖成 Completed。故检测到 flag 时保持 pause_download/cancel_download
            // 已设置的状态、不 merge、保留 .part.N 供续传（cancel 由 cleanup 清理）。
            let was_cancelled = cancel_flags
                .read()
                .await
                .get(&task_id)
                .map(|f| f.load(Ordering::Relaxed))
                .unwrap_or(false);
            if was_cancelled {
                return Ok(());
            }

            if all_success {
                // Merge all part files into the final file
                Self::merge_chunks(&save_path, num_chunks as usize).await?;

                if let Some(t) = tasks.write().await.get_mut(&task_id) {
                    t.status = DownloadStatus::Completed;
                    t.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    t.downloaded_size = t.total_size;
                    t.progress = 100.0;
                }
                let _ = app_handle.emit("download-completed", &task_id);
                tracing::info!("Multi-thread download completed: {}", task_id);
            } else {
                // 修复(P1)：单分片失败不删除其它已下载分片，重试时可续传，避免一次网络抖动全员作废
                if let Some(t) = tasks.write().await.get_mut(&task_id) {
                    t.status = DownloadStatus::Failed;
                    t.error = Some("One or more chunks failed".to_string());
                }
                let _ = app_handle.emit("download-failed", (&task_id, "Chunk download failed".to_string()));
            }

            Ok(())
        }
    }

    async fn merge_chunks(save_path: &str, num_chunks: usize) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let save_path = save_path.to_string();
        let merging = format!("{}.merging", save_path);
        tokio::task::spawn_blocking(move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            // 修复(P1)：先写 .merging 临时文件，全部成功后再 rename 覆盖目标，
            // 避免中途磁盘满/IO 错误留下残缺的最终文件。
            let mut output = File::create(&merging)?;

            for i in 0..num_chunks {
                let part_path = format!("{}.part.{}", save_path, i);
                let mut part_file = File::open(&part_path)?;
                std::io::copy(&mut part_file, &mut output)?;
                drop(part_file);
                let _ = fs::remove_file(&part_path);
            }

            output.sync_all()?;
            drop(output);
            fs::rename(&merging, &save_path)?;
            Ok(())
        }).await.map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)) as Box<dyn std::error::Error + Send + Sync>)??;
        Ok(())
    }

    async fn download_single(
        task_id: String,
        url: String,
        save_path: String,
        tasks: Arc<TokioRwLock<HashMap<String, DownloadTask>>>,
        cancel_flags: Arc<TokioRwLock<HashMap<String, Arc<AtomicBool>>>>,
        app_handle: tauri::AppHandle,
        rate_limiter: RateLimiter,
        client: reqwest::Client,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // 断点续传：若目标文件已存在，从已下载字节处 Range 续传
        let mut resume_from = fs::metadata(&save_path).map(|m| m.len()).unwrap_or(0);
        let request = if resume_from > 0 {
            client.get(&url).header("Range", format!("bytes={}-", resume_from))
        } else {
            client.get(&url)
        };
        let response = request.send().await?;

        // 关键安全校验：很多服务器会忽略 Range 头并返回 200（完整文件）。
        // 若服务端未返回 206 Partial Content，则说明续传未生效，必须当作全新下载处理：
        // 重置 resume_from = 0，否则以 append 模式写入会导致文件损坏/内容重复。
        if resume_from > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            resume_from = 0;
        }

        let cancel_flag = cancel_flags.read().await.get(&task_id).cloned();
        let total_size = response.content_length().map(|c| c + resume_from).unwrap_or(0);

        {
            let mut guard = tasks.write().await;
            if let Some(t) = guard.get_mut(&task_id) {
                t.total_size = total_size;
                t.downloaded_size = resume_from;
                let initial_progress = serde_json::json!({
                    "id": task_id,
                    "downloaded_size": resume_from,
                    "speed": 0,
                    "progress": if total_size > 0 { (resume_from as f64 / total_size as f64) * 100.0 } else { 0.0 },
                    "total_size": total_size,
                    "status": "downloading"
                });
                let _ = app_handle.emit("download-progress", initial_progress);
            }
        }

        let save_path_clone = save_path.clone();
        let append_mode = resume_from > 0;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);

        // Spawn blocking file writer task
        let writer_handle = tokio::task::spawn_blocking(move || -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
            let mut file = if append_mode {
                let mut f = File::options().append(true).create(true).open(&save_path_clone)?;
                f.seek(std::io::SeekFrom::End(0))?;
                f
            } else {
                File::create(&save_path_clone)?
            };
            let mut downloaded: u64 = 0;
            while let Some(data) = rx.blocking_recv() {
                file.write_all(&data)?;
                downloaded += data.len() as u64;
            }
            file.sync_all()?;
            Ok(downloaded)
        });

        let mut downloaded: u64 = resume_from;
        let mut stream = response.bytes_stream().into_stream();
        let start_time = Instant::now();
        let mut last_update = Instant::now();

        while let Some(chunk_result) = stream_next_with_retry(&mut stream, 3).await? {
            if let Some(ref flag) = cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    drop(tx);
                    let _ = writer_handle.await;
                    return Ok(());
                }
            }

            let len = chunk_result.len() as u64;
            // 限速：申请本块字节额度（0 表示不限速，立即返回）
            rate_limiter.acquire(len).await;
            downloaded += len;
            if tx.send(chunk_result.to_vec()).await.is_err() {
                break;
            }

            let elapsed = start_time.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 { downloaded as f64 / elapsed } else { 0.0 };

            let progress = if total_size > 0 {
                (downloaded as f64 / total_size as f64) * 100.0
            } else {
                0.0
            };

            if let Some(t) = tasks.write().await.get_mut(&task_id) {
                t.downloaded_size = downloaded;
                t.speed = speed;
                t.progress = progress;
            }

            if last_update.elapsed() > Duration::from_millis(300) {
                let progress_event = serde_json::json!({
                    "id": task_id,
                    "downloaded_size": downloaded,
                    "speed": speed,
                    "progress": progress,
                    "total_size": total_size,
                    "status": "downloading"
                });
                let _ = app_handle.emit("download-progress", progress_event);
                last_update = Instant::now();
            }
        }

        drop(tx);
        let _ = writer_handle.await;

        if let Some(t) = tasks.write().await.get_mut(&task_id) {
            t.status = DownloadStatus::Completed;
            t.completed_at = Some(chrono::Utc::now().to_rfc3339());
            t.downloaded_size = t.total_size;
            t.progress = 100.0;
        }

        let _ = app_handle.emit("download-completed", &task_id);

        tracing::info!("Single download completed: {}", task_id);

        Ok(())
    }

    /// 下载某个分片到独立临时文件（无共享写 = 无竞争）。
    /// resume_from > 0 时从已下载字节处 Range 续传，并追加写入临时文件（断点续传）。
    async fn download_chunk_to_temp(
        task_id: String,
        url: String,
        save_path: String,
        start: u64,
        end: u64,
        chunk_idx: usize,
        resume_from: u64,
        cancel_flags: Arc<TokioRwLock<HashMap<String, Arc<AtomicBool>>>>,
        downloaded_total: Arc<AtomicU64>,
        rate_limiter: RateLimiter,
        client: reqwest::Client,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let range_start = (start + resume_from).min(end);
        let request = client.get(&url)
            .header("Range", format!("bytes={}-{}", range_start, end));

        let response = request.send().await?;

        // 分片下载必须拿到 206 部分响应；若服务端忽略 Range 返回 200（完整文件），
        // 每个分片都会写入整份文件，合并后将产生损坏文件。此处显式报错，避免静默损坏。
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!(
                "分片下载未获得 206 响应 (status={})，无法多线程拼接",
                response.status()
            ).into());
        }

        let cancel_flag = cancel_flags.read().await.get(&task_id).cloned();

        // Each chunk writes to its own isolated temp file via spawn_blocking
        let temp_file = format!("{}.part.{}", save_path, chunk_idx);
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);

        let writer_handle = tokio::task::spawn_blocking(move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            // 续传时追加写入，否则截断重建
            let mut file = if resume_from > 0 {
                let mut f = File::options().append(true).create(true).open(&temp_file)?;
                f.seek(std::io::SeekFrom::End(0))?;
                f
            } else {
                File::create(&temp_file)?
            };
            while let Some(data) = rx.blocking_recv() {
                file.write_all(&data)?;
            }
            file.sync_all()?;
            Ok(())
        });

        let mut stream = response.bytes_stream().into_stream();

        while let Some(chunk_result) = stream_next_with_retry(&mut stream, 3).await? {
            if let Some(ref flag) = cancel_flag {
                if flag.load(Ordering::Relaxed) {
                    // 修复(P0)：pause 与 cancel 共用此 flag。pause 必须保留 .part.N 以便续传；
                    // cancel 由 cancel_download 的 cleanup_task_files 统一清理分片。
                    // 故此处仅停止下载、不删除分片。
                    drop(tx);
                    let _ = writer_handle.await;
                    return Ok(());
                }
            }

            let len = chunk_result.len() as u64;
            // 限速：申请本块字节额度（0 表示不限速，立即返回）
            rate_limiter.acquire(len).await;
            downloaded_total.fetch_add(len, Ordering::Relaxed);
            if tx.send(chunk_result.to_vec()).await.is_err() {
                break;
            }
        }

        drop(tx);
        let _ = writer_handle.await;

        Ok(())
    }

    pub async fn pause_download(&self, id: String) -> Result<(), String> {
        {
            let flags = self.cancel_flags.read().await;
            if let Some(flag) = flags.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        {
            let mut tasks = self.tasks.write().await;
            if let Some(task) = tasks.get_mut(&id) {
                task.status = DownloadStatus::Paused;
            }
        }
        Ok(())
    }

    pub async fn resume_download(&self, id: String) -> Result<(), String> {
        self.start_download(id).await
    }

    pub async fn cancel_download(&self, id: String) -> Result<(), String> {
        {
            let flags = self.cancel_flags.read().await;
            if let Some(flag) = flags.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        {
            let mut tasks = self.tasks.write().await;
            if let Some(task) = tasks.get_mut(&id) {
                task.status = DownloadStatus::Failed;
                task.error = Some("Cancelled by user".to_string());
                let path = task.save_path.clone();
                Self::cleanup_task_files(&path);
            }
        }
        Ok(())
    }

    pub async fn remove_download(&self, id: String) -> Result<(), String> {
        {
            let path = self.tasks.read().await.get(&id).map(|t| t.save_path.clone()).unwrap_or_default();
            Self::cleanup_task_files(&path);
        }
        {
            self.cancel_flags.write().await.remove(&id);
            self.tasks.write().await.remove(&id);
        }
        Ok(())
    }

    /// 把已持久化的历史任务重新写回内存管理器（重启恢复用）
    pub async fn restore_task(&self, task: DownloadTask) {
        self.tasks.write().await.insert(task.id.clone(), task.clone());
        self.cancel_flags.write().await.insert(task.id.clone(), Arc::new(AtomicBool::new(false)));
    }

    /// 删除任务对应的目标文件及其所有分片临时文件（.part.N）
    pub fn cleanup_task_files(save_path: &str) {
        let _ = fs::remove_file(save_path);
        let save_pb = PathBuf::from(save_path);
        if let Some(parent) = save_pb.parent() {
            let base_name = save_pb
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if let Ok(entries) = fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        // 修复(P1)：精确匹配 {base}.part.{数字}，避免误删 x.part.bak 等同名前缀文件
                        let is_part_file = name.starts_with(base_name) && {
                            let rest = &name[base_name.len()..];
                            rest.starts_with(".part.")
                                && rest[".part.".len()..].chars().all(|c| c.is_ascii_digit())
                        };
                        if is_part_file {
                            let _ = fs::remove_file(p);
                        }
                    }
                }
            }
        }
    }

    pub async fn get_all_downloads(&self) -> Vec<DownloadTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }

    pub async fn get_download(&self, id: &str) -> Option<DownloadTask> {
        let tasks = self.tasks.read().await;
        tasks.get(id).cloned()
    }

    pub async fn clear_completed(&self) {
        self.tasks.write().await.retain(|_, t| t.status != DownloadStatus::Completed);
    }

    async fn extract_filename(&self, url: &str) -> Result<String, String> {
        // HEAD 探测；部分服务器对 HEAD 返回 405/403，fallback 到 GET Range:0-0
        let response = match self.client.head(url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => match self.client.get(url).header("Range", "bytes=0-0").send().await {
                Ok(r) => r,
                Err(e) => return Err(e.to_string()),
            },
        };

        let mut filename = None;
        if let Some(disposition) = response.headers().get("content-disposition") {
            if let Ok(disposition_str) = disposition.to_str() {
                // 修复(P1)：优先 RFC 5987 filename*=UTF-8''... 以支持 Unicode 文件名，
                // 再回退到传统 filename="..."
                filename = parse_content_disposition(disposition_str);
            }
        }

        if filename.is_none() {
            let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
            let last = parsed.path_segments()
                .and_then(|segments| segments.last())
                .unwrap_or("download");
            filename = Some(last.to_string());
        }

        // 清洗：去除路径穿越与 Windows/macOS 非法字符，避免写出越界文件或非法名
        let cleaned = sanitize_filename(&filename.unwrap());
        Ok(if cleaned.is_empty() { "download".to_string() } else { cleaned })
    }

}

#[cfg(test)]
mod tests {
        use super::*;
        use std::time::Duration as StdDuration;

        #[test]
        fn test_sanitize_filename_path_traversal() {
            // 路径穿越：只保留 basename，杜绝写出越界文件
            assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
            assert_eq!(sanitize_filename("a/b\\c"), "c");
        }

        #[test]
        fn test_sanitize_filename_illegal_chars() {
            // Windows 非法字符应被剥离
            let out = sanitize_filename("my:file*name?.txt");
            assert!(!out.contains(':'));
            assert!(!out.contains('*'));
            assert!(!out.contains('?'));
            assert_eq!(out, "myfilename.txt");
        }

        #[test]
        fn test_sanitize_filename_control_and_dots() {
            assert_eq!(sanitize_filename("  .hidden.  "), "hidden");
            // 控制字符（含 NUL）剥离
            assert_eq!(sanitize_filename("abc\x00def"), "abcdef");
        }

        #[test]
        fn test_sanitize_filename_long_truncate() {
            let long = "x".repeat(300);
            let out = sanitize_filename(&long);
            assert!(out.len() <= 200, "len={}", out.len());
        }

        #[test]
        fn test_format_bytes_simple() {
            assert_eq!(format_bytes_simple(0), "0 B");
            assert_eq!(format_bytes_simple(1024), "1.00 KB");
            assert_eq!(format_bytes_simple(1024 * 1024), "1.00 MB");
            assert_eq!(format_bytes_simple(1536), "1.50 KB");
        }

        #[tokio::test]
        async fn test_rate_limiter_unlimited_is_immediate() {
            // 不限速（speed_limit_kb=0）：acquire 必须立即返回，不得节流
            let limit = Arc::new(AtomicU64::new(0));
            let rl = RateLimiter::new(limit);
            let start = std::time::Instant::now();
            rl.acquire(1_000_000).await;
            assert!(
                start.elapsed() < StdDuration::from_millis(200),
                "unlimited limiter must not throttle"
            );
        }

        #[tokio::test]
        async fn test_rate_limiter_throttles() {
            // 1 KB/s 限速：第一次 acquire(1000) 立即消耗 1 秒额度，
            // 第二次 acquire(1000) 须等待约 1 秒，证明聚合限速生效
            let limit = Arc::new(AtomicU64::new(1 * 1024));
            let rl = RateLimiter::new(limit);
            let start = std::time::Instant::now();
            rl.acquire(1000).await;
            let first = start.elapsed();
            rl.acquire(1000).await;
            let total = start.elapsed();
            assert!(first < StdDuration::from_millis(200), "first acquire should be immediate: {:?}", first);
            assert!(total > StdDuration::from_millis(600), "second acquire should be throttled: {:?}", total);
        }

        #[tokio::test]
        async fn test_rate_limiter_dynamic_update() {
            // 验证本次修复：下载中改限速必须实时生效。
            // 初始不限速（acquire 立即返回），运行中改为 1 KB/s 后，
            // 后续 acquire 应被节流（聚合速率受控）。
            let limit = Arc::new(AtomicU64::new(0));
            let rl = RateLimiter::new(limit.clone());
            let start = std::time::Instant::now();
            rl.acquire(1_000_000).await;
            assert!(start.elapsed() < StdDuration::from_millis(200), "unlimited must not throttle");

            // 运行时切换为 1 KB/s
            limit.store(1 * 1024, Ordering::Relaxed);
            let start2 = std::time::Instant::now();
            rl.acquire(1000).await;
            rl.acquire(1000).await;
            let total = start2.elapsed();
            // 关键断言：切换成限速后，acquire 必须被节流（total 明显 > 0）。
            // 修复前（限速器冻结在下载启动值）total≈0，此处会失败；修复后 total>600ms。
            assert!(total > StdDuration::from_millis(600), "after switching to 1KB/s, acquires must be throttled: total={:?}", total);
        }
    }











