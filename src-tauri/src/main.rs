mod download;
mod db;
mod commands;

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use tokio::sync::RwLock;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

pub use download::{DownloadManager, DownloadTask, DownloadStatus};

// 网盘解析：App 侧暂存的「待解析」请求队列（由浏览器扩展轮询取走，在扩展内用 cookie 完成解析）。
// cookie 不离开扩展，仅把解析出的直链回传，避免敏感凭据落盘或进入 Rust 进程。
#[derive(Clone)]
pub struct PendingResolve {
    pub url: String,
    pub pwd: Option<String>,
    pub platform: Option<String>,
    pub created_at: u64,
}
pub type NetdiskPending = Arc<Mutex<HashMap<String, PendingResolve>>>;
pub static NETDISK_SEQ: AtomicU64 = AtomicU64::new(0);

// 网盘解析：扩展回报结果时，把「直链 URL -> 真实文件名」暂存下来。
// 兜底用：前端「加入下载」理论上会透传 filename，但若该参数因故没跨过 Tauri 边界到达
// Rust 侧（例如前端/后端二次打包不一致、旧前端未传），仍可用直链 URL 反查回真实文件名，
// 避免把百度直链末段的哈希串当成文件名存盘。不落盘、仅内存、随进程退出释放。
#[derive(Clone, Default)]
pub struct NetdiskFilenames(pub Arc<Mutex<HashMap<String, String>>>);


#[cfg(windows)]
extern "system" { fn FreeConsole() -> i32; }

fn main() {
    #[cfg(windows)]
    unsafe { FreeConsole(); }

    let log_dir = dirs::data_local_dir().unwrap_or_default().join("lele_download").join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let file = RollingFileAppender::new(Rotation::DAILY, log_dir, "lele_download.log");
    let _ = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().with_writer(file).with_ansi(false))
        .try_init();

    tracing::info!("乐乐下载器 starting...");
    std::panic::set_hook(Box::new(|p| { tracing::error!("Panic: {:?}", p); }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())

        .setup(|app| {
            let handle = app.handle().clone();
            let db = db::Database::new()?;

            // 载入历史任务；把中断中的 downloading/pending 标记为失败并同步修正 DB，
            // 避免重启后 UI 显示假的进行中进度。
            let restored: Vec<DownloadTask> = db
                .load_tasks()
                .unwrap_or_default()
                .into_iter()
                .map(|mut task| {
                    if matches!(task.status, DownloadStatus::Downloading | DownloadStatus::Pending) {
                        task.status = DownloadStatus::Failed;
                        task.error = Some("应用重启，下载已中断".to_string());
                        let _ = db.update_task(&task);
                    }
                    task
                })
                .collect();

            let db_arc = Arc::new(RwLock::new(db));
            app.manage(db_arc.clone());
            let dm = Arc::new(DownloadManager::new(handle.clone())?);
            app.manage(dm.clone());

            // 网盘解析待办队列（App 内存态，不落盘）
            let netdisk_pending: NetdiskPending = Arc::new(Mutex::new(HashMap::new()));
            app.manage(netdisk_pending.clone());
            // 网盘解析：直链URL -> 真实文件名 兜底暂存表
            app.manage(NetdiskFilenames(Arc::new(Mutex::new(HashMap::new()))));

            // 创建系统托盘：关闭窗口时最小化到托盘，而非退出程序。
            // 右键托盘菜单可「显示主窗口 / 退出」，左键点击在显示/隐藏间切换。
            {
                let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
                let _tray = TrayIconBuilder::with_id("lele-tray")
                    .icon(app.default_window_icon().cloned().expect("缺少窗口图标"))
                    .tooltip("LeLe Download")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let visible = w.is_visible().unwrap_or(false);
                                if visible {
                                    let _ = w.hide();
                                } else {
                                    let _ = w.unminimize();
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            // 把历史任务写回内存管理器，使重启后列表不丢失
            let dm_clone = dm.clone();
            tauri::async_runtime::spawn(async move {
                for task in restored {
                    dm_clone.restore_task(task).await;
                }
            });

            // 注意：必须在 spawn 之前取出 AppHandle 并 clone。
            // 若在闭包内部调用 app.handle()，闭包会捕获 &mut tauri::App（非 Send），
            // std::thread::spawn 会因 Send 约束编译失败。
            let app_for_http = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = run_http(dm, app_for_http) {
                    tracing::error!("HTTP: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_download, commands::request_netdisk_resolve,
            commands::pause_download,
            commands::resume_download, commands::cancel_download,
            commands::remove_download, commands::get_downloads,
            commands::get_download, commands::clear_completed,
            commands::get_download_settings, commands::update_download_settings,
            commands::get_default_download_dir, commands::select_download_dir,
            commands::open_devtools, commands::open_folder,
            commands::open_extension_folder,
        ])
        // 点击窗口关闭（X）：拦截默认退出，改为隐藏到系统托盘，让程序在后台继续运行。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("run error");
}

// 对桥接上报的自定义请求头做边界校验（P1-3 安全收尾）：
// - 丢弃由引擎自行管理的头：Host / Content-Length / Range / Connection /
//   Transfer-Encoding / Content-Encoding / Proxy-*（避免请求走私或覆盖引擎行为）；
// - 丢弃空值头、键名超长（>256）或单值超长（>8KB）防滥用；
// - 限制头数量（<=64）防滥用。
// 返回 None 表示无任何有效头（等价于旧路径，引擎按无头下载，行为完全不变）。
fn sanitize_headers(raw: &Option<HashMap<String, String>>) -> Option<HashMap<String, String>> {
    let Some(h) = raw else { return None; };
    let mut out: HashMap<String, String> = HashMap::with_capacity(h.len().min(64));
    for (k, v) in h.iter() {
        let kl = k.to_lowercase();
        if kl.is_empty() || kl.len() > 256 {
            continue;
        }
        if kl == "host"
            || kl == "content-length"
            || kl == "range"
            || kl == "connection"
            || kl == "transfer-encoding"
            || kl == "content-encoding"
            || kl.starts_with("proxy-")
        {
            continue;
        }
        if v.is_empty() || v.len() > 8192 {
            continue;
        }
        if out.len() >= 64 {
            break;
        }
        out.insert(k.clone(), v.clone());
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// 从 /download 请求 body 中解析出 (url, 已清洗的 headers, 显式文件名)。
// 供 run_http 桥接主流程与测试复用；headers 缺省时返回 None（旧路径兼容），
// 显式文件名缺省时返回 None（此时由 create_download 走 extract_filename 探测）。
// 注意：此处只做 JSON 解析 + 边界清洗，SSRF 校验(is_url_safe)由调用方在拿到 url 后执行。
fn parse_download_request(body: &str) -> Option<(String, Option<HashMap<String, String>>, Option<String>)> {
    let j: serde_json::Value = serde_json::from_str(body).ok()?;
    let url = j.get("url").and_then(|v| v.as_str())?.to_string();
    let raw_headers = j
        .get("headers")
        .and_then(|h| h.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect::<HashMap<String, String>>()
        });
    let headers = sanitize_headers(&raw_headers);
    // 兼容调用方显式指定的文件名：优先 `filename`，回退 `name`（netdisk-resolver 会同时带这两个字段）。
    // 显式文件名可跳过 extract_filename 的 HEAD 探测，避免 123 云盘等分享直链因取不到
    // Content-Disposition 而落回到无意义的 URL 路径段（如 c-m9013）。
    let filename = j
        .get("filename")
        .and_then(|v| v.as_str())
        .or_else(|| j.get("name").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    Some((url, headers, filename))
}

// 向 socket 写出一段 JSON 响应。CORS 仅对浏览器扩展 origin 放开（chrome-extension://*、
// moz-extension://*），普通网页跨域请求不返回 CORS 头，阻止恶意页面调用本地桥接。
fn write_json(s: &mut std::net::TcpStream, status_line: &str, body: &str, origin: Option<&str>) {
    let cors = match origin {
        Some(o) if o.starts_with("chrome-extension://") || o.starts_with("moz-extension://") => {
            format!(
                "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n",
                o
            )
        }
        _ => String::new(),
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {len}\r\nConnection: close\r\n{cors}\r\n",
        status = status_line,
        len = body.as_bytes().len(),
        cors = cors
    );
    let _ = s.write_all(header.as_bytes());
    let _ = s.write_all(body.as_bytes());
}

// 从原始 HTTP 请求文本中提取指定头（大小写不敏感）的值。
fn req_header<'a>(req: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{}:", name.to_lowercase());
    for l in req.lines() {
        if l.to_lowercase().starts_with(&prefix) {
            return l.splitn(2, ':').nth(1).map(|v| v.trim());
        }
    }
    None
}

/// 下载 url 安全校验：仅允许 http/https，拒绝私网/回环/链路本地/未指定 IP 与云元数据主机，
/// 防止恶意网页通过本地桥接发起 SSRF（探测/触发内网请求）。
fn is_url_safe(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid url: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("scheme '{}' not allowed", other)),
    }
    let host = parsed.host_str().ok_or("missing host")?;
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let blocked = match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_unspecified() || v4.is_private() || v4.is_link_local()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00
            }
        };
        if blocked {
            return Err(format!("target IP {} is private/loopback/link-local, blocked", ip));
        }
    }
    if host == "metadata.google.internal" {
        return Err("metadata host blocked".into());
    }
    Ok(())
}

// 网盘解析：列出待解析队列（GET /api/netdisk/resolve/pending）。
// 同时清理超过 5 分钟未被取走的僵尸条目，返回 JSON 数组字符串。
fn netdisk_pending_list(pending: &NetdiskPending) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    pending
        .lock()
        .unwrap()
        .retain(|_, p| now.saturating_sub(p.created_at) < 300);
    let list: Vec<serde_json::Value> = pending
        .lock()
        .unwrap()
        .iter()
        .map(|(id, p)| {
            serde_json::json!({
                "id": id,
                "url": p.url,
                "pwd": p.pwd,
                "platform": p.platform,
            })
        })
        .collect();
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())
}

// 网盘解析：处理扩展回传的解析结果（POST /api/netdisk/resolve/result）。
// 从队列移除对应 id，对直链做 SSRF 过滤；返回 (status_line, 响应体, 待 emit 事件)。
// 解析失败 / 非 JSON 时返回 None（调用方回 400）。
fn netdisk_result_apply(
    pending: &NetdiskPending,
    body: &str,
) -> Option<(String, String, serde_json::Value)> {
    let mut v: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
        pending.lock().unwrap().remove(id);
    }
    if let Some(files) = v.get_mut("files").and_then(|x| x.as_array_mut()) {
        // 收集每个文件被过滤的具体原因（SSRF 规则 vs url 字段缺失），
        // 避免「解析结果为空或直链未通过安全校验」一个文案掩盖三种情况。
        let total = files.len();
        let mut rejected: Vec<String> = Vec::new();
        files.retain(|f| match f.get("url").and_then(|u| u.as_str()) {
            Some(u) => match is_url_safe(u) {
                Ok(()) => true,
                Err(reason) => {
                    let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                    rejected.push(format!("{} [{}]: {}", name, u, reason));
                    false
                }
            },
            None => {
                let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                rejected.push(format!("{}: url 字段为空或非字符串", name));
                false
            }
        });
        if files.is_empty() {
            v["ok"] = serde_json::Value::Bool(false);
            v["error"] = if total == 0 {
                serde_json::Value::String("解析结果为空：扩展未返回任何文件".to_string())
            } else if rejected.is_empty() {
                serde_json::Value::String("解析结果为空或直链未通过安全校验".to_string())
            } else {
                // 限长避免错误框太长；最多展示前 3 条
                let head: Vec<String> = rejected.iter().take(3).cloned().collect();
                let more = if rejected.len() > 3 {
                    format!(" …等共 {} 条", rejected.len())
                } else {
                    String::new()
                };
                serde_json::Value::String(format!(
                    "全部 {} 个文件被过滤：{}{}",
                    total,
                    head.join("；"),
                    more
                ))
            };
        }
    }
    Some(("200 OK".to_string(), "{\"ok\":true}".to_string(), v))
}

// 把桥接请求简要记录到 %TEMP%/lele_http_bridge.log，便于排查扩展下发是否真的到达 App。
fn log_http(line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("lele_http_bridge.log"))
    {
        let _ = writeln!(f, "{}", line);
    }
}

// 从已接受的 socket 读取完整的 HTTP 请求（含 body）。
// 关键：socket 必须设为阻塞 + 读超时，并循环读取直到按 Content-Length 收全 body，
// 否则在 POST 分片到达时会因首包仅有请求头而读取不完整，导致扩展下发的下载任务被静默丢弃。
fn read_full_request(s: &mut std::net::TcpStream) -> Option<String> {
    use std::io::Read;
    let _ = s.set_nonblocking(false);
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= 4 {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&buf[..pos]);
                        let cl = header
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .starts_with("content-length:")
                                    .then(|| {
                                        l["content-length:".len()..]
                                            .trim()
                                            .parse::<usize>()
                                            .ok()
                                    })
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if buf.len() >= pos + 4 + cl {
                            break;
                        }
                    }
                }
                if buf.len() > 1_000_000 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if buf.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&buf).to_string())
    }
}

fn run_http(dm: Arc<DownloadManager>, app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 仅当显式设置 LELE_HTTP_TOKEN 时才强制鉴权；否则本地回环（127.0.0.1）免鉴权，
    // 以便浏览器扩展默认即可把下载任务下发到本机 App。
    let token: Option<String> = std::env::var("LELE_HTTP_TOKEN").ok();

    let rt = tokio::runtime::Runtime::new()?;

    let ln = std::net::TcpListener::bind("127.0.0.1:45678")?;
    // 修复(P2)：直接阻塞 accept（run_http 跑在独立 std::thread，阻塞不影响主线程），
    // 替代 set_nonblocking + sleep(10ms) 轮询，消除每秒 100 次空唤醒的 CPU 占用。

    loop {
        match ln.accept() {
            Ok((mut s, _)) => {
                let dm = dm.clone();
                let token = token.clone();
                let app = app.clone();
                rt.spawn(async move {
                    let r = match read_full_request(&mut s) {
                        Some(r) => r,
                        None => return,
                    };
                    let first_line = r.lines().next().unwrap_or("").to_string();
                    log_http(&format!("[recv] {}", first_line));

                    // CORS origin：仅对浏览器扩展 origin 放开，普通网页不返回 CORS 头
                    let origin = req_header(&r, "origin");

                    // 鉴权：仅当配置了 LELE_HTTP_TOKEN 时才校验，否则本地回环直接放行。
                    let authorized = match &token {
                        Some(expected) => {
                            let auth = r
                                .lines()
                                .find(|l| l.to_lowercase().starts_with("x-auth-token:"))
                                .map(|l| l["X-Auth-Token:".len()..].trim().to_string());
                            auth.as_deref() == Some(expected.as_str())
                        }
                        None => true,
                    };
                    if !authorized {
                        write_json(&mut s, "401 Unauthorized", "{\"e\":\"unauthorized\"}", origin);
                        return;
                    }

                    // CORS 预检
                    if first_line.to_uppercase().starts_with("OPTIONS") {
                        write_json(&mut s, "204 No Content", "", origin);
                        return;
                    }

                    if r.contains("/status") {
                        write_json(&mut s, "200 OK", "{\"s\":\"ok\",\"service\":\"lele-download\"}", origin);
                        return;
                    }

                    // 网盘解析：扩展轮询待办队列（仅扩展 origin 可访问）
                    if r.contains("/api/netdisk/resolve/pending") {
                        let pending = app.state::<NetdiskPending>();
                        let body = netdisk_pending_list(pending.inner());
                        write_json(&mut s, "200 OK", &body, origin);
                        return;
                    }

                    // 网盘解析：扩展把解析结果（直链）回传 App，App 推给前端面板
                    if r.contains("/api/netdisk/resolve/result") {
                        if let Some(pos) = r.find("\r\n\r\n") {
                            let body = &r[pos + 4..];
                            if let Some((status, resp, event)) =
                                netdisk_result_apply(app.state::<NetdiskPending>().inner(), body)
                            {
                                // 兜底：把「直链 URL -> 真实文件名」暂存，供 create_download
                                // 在没收到显式 filename 时反查，避免存成哈希串。
                                if let Some(files) = event.get("files").and_then(|x| x.as_array()) {
                                    let store = app.state::<NetdiskFilenames>();
                                    let mut m = store.0.lock().unwrap();
                                    for f in files {
                                        if let (Some(u), Some(n)) = (
                                            f.get("url").and_then(|x| x.as_str()),
                                            f.get("name").and_then(|x| x.as_str()),
                                        ) {
                                            if !n.trim().is_empty() {
                                                m.insert(u.to_string(), n.to_string());
                                            }
                                        }
                                    }
                                }
                                let _ = app.emit("netdisk-resolve-result", event);
                                write_json(&mut s, &status, &resp, origin);
                                return;
                            }
                        }
                        write_json(&mut s, "400 Bad Request", "{\"e\":\"bad\"}", origin);
                        return;
                    }

                    if r.contains("/download") {
                        if let Some(pos) = r.find("\r\n\r\n") {
                            let body = &r[pos + 4..];
                            if let Some((url, headers, filename)) = parse_download_request(body) {
                                // 可观测性日志（桥接到 %TEMP%/lele_http_bridge.log）：收到 /download 时打印
                                // headers 是否有值及来源类型（带 headers=扩展 share-link 上报；无 headers=直链/右键）。
                                let has_headers = headers.is_some();
                                let source = if has_headers { "share-link" } else { "direct" };
                                log_http(&format!(
                                    "[recv] POST /download headers={} source={}",
                                    has_headers, source
                                ));
                                // 修复(P0)：SSRF 防护——仅允许 http/https，拒绝私网/回环/链路本地 IP
                                if let Err(reason) = is_url_safe(&url) {
                                    log_http(&format!("[block] {} -> {}", url, reason));
                                    write_json(
                                        &mut s,
                                        "400 Bad Request",
                                        &format!("{{\"e\":\"url_blocked\",\"msg\":\"{}\"}}", reason),
                                        origin,
                                    );
                                    return;
                                }
                                // 修复：优先用用户配置的首选下载目录（设置面板持久化到
                                // settings.json），未配置时回退系统默认 Downloads。
                                let dir = commands::load_download_dir()
                                    .unwrap_or_else(|| {
                                        dirs::download_dir()
                                            .unwrap_or_default()
                                            .to_string_lossy()
                                            .to_string()
                                    });
                                // 显式文件名（来自请求 body 的 filename/name）原样透传，
                                // 跳过 extract_filename 的 HEAD 探测，保证 123 云盘等分享直链存盘为中文真实名。
                                match dm.create_download(url.clone(), dir, headers, filename).await {
                                    Ok(t) => {
                                        log_http(&format!("[ok] id={} url={}", t.id, url));
                                        let _ = dm.start_download(t.id.clone()).await;
                                        write_json(
                                            &mut s,
                                            "200 OK",
                                            &format!("{{\"ok\":true,\"id\":\"{}\"}}", t.id),
                                            origin,
                                        );
                                        return;
                                    }
                                    Err(e) => {
                                        log_http(&format!("[err] {} {:?}", url, e));
                                        write_json(
                                            &mut s,
                                            "400 Bad Request",
                                            &format!(
                                                "{{\"e\":\"create_failed\",\"msg\":\"{:?}\"}}",
                                                e
                                            ),
                                            origin,
                                        );
                                        return;
                                    }
                                }
                            }
                        }
                        write_json(&mut s, "400 Bad Request", "{\"e\":\"bad\"}", origin);
                        return;
                    }

                    // 根路径 / 其它：返回可读的状态说明，方便浏览器直接访问验证服务存活
                    write_json(
                        &mut s,
                        "200 OK",
                        "{\"s\":\"ok\",\"service\":\"lele-download\",\"usage\":\"POST /download {\\\"url\\\":\\\"...\\\"} | GET /status\"}",
                        origin,
                    );
                });
            }
            Err(e) => {
                tracing::error!("HTTP accept error: {}", e);
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    // 模拟浏览器扩展下发的「分片 POST」：先发请求头、停顿、再发 body。
    // 旧实现因非阻塞 + 单读会在此场景直接丢弃连接；修复后的 read_full_request 必须收全。
    #[test]
    fn read_full_request_handles_fragmented_post() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = "{\"url\":\"http://example.com/a.gz\",\"timestamp\":1}";
        let request = format!(
            "POST /download HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let header_part = request[..request.len() - body.len()].to_string();

        thread::spawn(move || {
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.write_all(header_part.as_bytes()).unwrap();
            client.flush().unwrap();
            thread::sleep(std::time::Duration::from_millis(50));
            client.write_all(body.as_bytes()).unwrap();
            client.flush().unwrap();
            thread::sleep(std::time::Duration::from_millis(200));
        });

        let (mut server, _) = listener.accept().unwrap();
        let got = read_full_request(&mut server).expect("should read full request");
        assert!(got.contains("/download"), "path missing: {}", got);
        let pos = got.find("\r\n\r\n").expect("no header/body separator");
        let got_body = &got[pos + 4..];
        assert_eq!(got_body, body, "body mismatch: {:?}", got_body);
        let j: serde_json::Value = serde_json::from_str(got_body).unwrap();
        assert_eq!(j["url"], "http://example.com/a.gz");
    }

    // 单次发送的 GET（如 /status 探活）也应能正确读取
    #[test]
    fn read_full_request_handles_single_shot_get() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.write_all(b"GET /status HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            client.flush().unwrap();
            thread::sleep(std::time::Duration::from_millis(200));
        });
        let (mut server, _) = listener.accept().unwrap();
        let got = read_full_request(&mut server).expect("should read");
        assert!(got.contains("/status"), "got: {}", got);
    }

    // ---- sanitize_headers 边界校验（P1-3 安全收尾）----

    #[test]
    fn sanitize_drops_engine_managed_headers() {
        let mut h = HashMap::new();
        h.insert("Host".to_string(), "evil.com".to_string());
        h.insert("Proxy-Authorization".to_string(), "secret".to_string());
        h.insert("Content-Length".to_string(), "999".to_string());
        h.insert("Range".to_string(), "bytes=0-10".to_string());
        h.insert("Connection".to_string(), "keep-alive".to_string());
        h.insert("Transfer-Encoding".to_string(), "chunked".to_string());
        h.insert("Content-Encoding".to_string(), "gzip".to_string());
        h.insert("Cookie".to_string(), "a=1".to_string());
        let out = sanitize_headers(&Some(h)).expect("应至少保留 Cookie");
        assert!(out.get("Host").is_none(), "Host 必须被丢弃");
        assert!(out.get("Proxy-Authorization").is_none(), "Proxy-* 必须被丢弃");
        assert!(out.get("Content-Length").is_none(), "Content-Length 必须被丢弃");
        assert!(out.get("Range").is_none(), "Range 必须被丢弃");
        assert!(out.get("Connection").is_none(), "Connection 必须被丢弃");
        assert!(out.get("Transfer-Encoding").is_none());
        assert!(out.get("Content-Encoding").is_none());
        assert_eq!(out.get("Cookie"), Some(&"a=1".to_string()));
    }

    #[test]
    fn sanitize_keeps_normal_headers() {
        let mut h = HashMap::new();
        h.insert("Cookie".to_string(), "sess=abc".to_string());
        h.insert("Referer".to_string(), "https://we.tl/x".to_string());
        h.insert("Authorization".to_string(), "Bearer t".to_string());
        h.insert("User-Agent".to_string(), "Mozilla/5.0".to_string());
        let out = sanitize_headers(&Some(h)).expect("应保留正常头");
        assert_eq!(out.get("Cookie"), Some(&"sess=abc".to_string()));
        assert_eq!(out.get("Referer"), Some(&"https://we.tl/x".to_string()));
        assert_eq!(out.get("Authorization"), Some(&"Bearer t".to_string()));
        assert_eq!(out.get("User-Agent"), Some(&"Mozilla/5.0".to_string()));
    }

    #[test]
    fn sanitize_rejects_oversized_value() {
        let mut h = HashMap::new();
        h.insert("X-Evil".to_string(), "x".repeat(9000)); // > 8192
        h.insert("Cookie".to_string(), "ok".to_string());
        let out = sanitize_headers(&Some(h)).expect("应保留 Cookie");
        assert!(out.get("X-Evil").is_none(), "超过 8KB 的头值必须被丢弃");
        assert_eq!(out.get("Cookie"), Some(&"ok".to_string()));
    }

    #[test]
    fn sanitize_none_returns_none() {
        assert!(sanitize_headers(&None).is_none());
    }

    #[test]
    fn sanitize_all_dropped_returns_none() {
        let mut h = HashMap::new();
        h.insert("Host".to_string(), "x".to_string());
        h.insert("Range".to_string(), "bytes=1-2".to_string());
        assert!(sanitize_headers(&Some(h)).is_none(), "全被丢弃时应返回 None（等价于旧路径）");
    }

    #[test]
    fn sanitize_rejects_empty_value_and_overlong_key() {
        let mut h = HashMap::new();
        h.insert("Cookie".to_string(), "".to_string()); // 空值丢弃
        h.insert("X".repeat(300).to_string(), "v".to_string()); // 超长键名丢弃
        h.insert("Referer".to_string(), "https://we.tl".to_string());
        let out = sanitize_headers(&Some(h)).expect("应保留 Referer");
        assert!(out.get("Cookie").is_none(), "空值头必须被丢弃");
        assert!(out.get(&"X".repeat(300)).is_none(), "超长键名必须被丢弃");
        assert_eq!(out.get("Referer"), Some(&"https://we.tl".to_string()));
    }

    #[test]
    fn sanitize_caps_header_count() {
        let mut h = HashMap::new();
        for i in 0..100 {
            h.insert(format!("X-Custom-{}", i), "v".to_string());
        }
        let out = sanitize_headers(&Some(h)).expect("非空");
        assert!(out.len() <= 64, "头数量必须被限制，got {}", out.len());
    }

    // ---- 桥接 JSON 解析兼容性（向后兼容旧调用方）----

    #[test]
    fn bridge_json_with_headers_parses_some() {
        let body = r#"{"url":"https://cdn.example.com/file.zip","timestamp":1,"headers":{"Cookie":"a=1","Referer":"https://we.tl/x","Authorization":"Bearer t"}}"#;
        let (u, headers, filename) = parse_download_request(body).expect("应解析成功");
        assert_eq!(u, "https://cdn.example.com/file.zip");
        let h = headers.expect("headers 应为 Some");
        assert_eq!(h.get("Cookie"), Some(&"a=1".to_string()));
        assert_eq!(h.get("Referer"), Some(&"https://we.tl/x".to_string()));
        assert_eq!(h.get("Authorization"), Some(&"Bearer t".to_string()));
        assert!(filename.is_none(), "未带 filename/name 时应为 None");
    }

    #[test]
    fn bridge_json_without_headers_parses_none() {
        // 旧调用方（右键菜单 / onCreated / popup）不含 headers 字段 -> headers=None（旧分支不变）
        let body = r#"{"url":"https://cdn.example.com/file.zip","timestamp":1}"#;
        let (u, headers, _filename) = parse_download_request(body).expect("应解析成功");
        assert_eq!(u, "https://cdn.example.com/file.zip");
        assert!(headers.is_none(), "缺省 headers 时必须为 None（旧路径兼容）");
    }

    #[test]
    fn bridge_json_missing_url_is_none() {
        let body = r#"{"timestamp":1,"headers":{"Cookie":"a=1"}}"#;
        assert!(parse_download_request(body).is_none(), "缺 url 必须返回 None -> 桥接回 400 bad");
    }

    #[test]
    fn bridge_json_with_empty_headers_object_is_none() {
        // headers 字段存在但为空对象 -> 解析后无有效头 -> None（不污染旧路径）
        let body = r#"{"url":"https://cdn.example.com/file.zip","headers":{}}"#;
        let (_u, headers, _filename) = parse_download_request(body).expect("应解析成功");
        assert!(headers.is_none(), "空 headers 对象应等价 None");
    }

    #[test]
    fn bridge_json_prefers_filename_then_name() {
        // netdisk-resolver 会带 filename/name：显式文件名应被解析出来，跳过 HEAD 探测。
        let with_filename = r#"{"url":"https://cdn.123pan.cn/c-m9013?auto_redirect=1","filename":"西游记.1996.S01E18.1080P.H265.mp4"}"#;
        let (_, _, f1) = parse_download_request(with_filename).expect("应解析成功");
        assert_eq!(f1.as_deref(), Some("西游记.1996.S01E18.1080P.H265.mp4"));

        let with_name_only = r#"{"url":"https://cdn.123pan.cn/c-m9013?auto_redirect=1","name":"西游记.mp4"}"#;
        let (_, _, f2) = parse_download_request(with_name_only).expect("应解析成功");
        assert_eq!(f2.as_deref(), Some("西游记.mp4"));
    }
}

// 网盘解析 HTTP 桥接的冒烟测试：直接驱动真实的 netdisk_pending_list /
// netdisk_result_apply（与 run_http 内调用的同一份实现），覆盖「挂单 → 轮询列出
// → 回传直链 → 出队 + 推事件」全链路，以及僵尸清理与 SSRF 过滤等边角。
#[cfg(test)]
mod netdisk_tests {
    use super::*;

    fn make_pending() -> NetdiskPending {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn insert(pending: &NetdiskPending, id: &str, age_secs: u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        pending.lock().unwrap().insert(
            id.to_string(),
            PendingResolve {
                url: "https://pan.baidu.com/s/ABC".to_string(),
                pwd: None,
                platform: Some("baidu".to_string()),
                created_at: now.saturating_sub(age_secs),
            },
        );
    }

    #[test]
    fn pending_list_returns_inserted_item() {
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = netdisk_pending_list(&p);
        let arr = serde_json::from_str::<serde_json::Value>(&body)
            .expect("应为 JSON 数组")
            .as_array()
            .expect("应为数组")
            .clone();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"].as_str().unwrap(), "nk_1");
        assert_eq!(arr[0]["url"].as_str().unwrap(), "https://pan.baidu.com/s/ABC");
        assert_eq!(arr[0]["platform"].as_str().unwrap(), "baidu");
    }

    #[test]
    fn pending_list_drops_zombie_entries() {
        let p = make_pending();
        insert(&p, "nk_old", 400); // 400s 前挂单，超过 300s 阈值
        insert(&p, "nk_fresh", 0);
        let arr = serde_json::from_str::<serde_json::Value>(&netdisk_pending_list(&p))
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(arr.len(), 1, "僵尸条目应被清理");
        assert_eq!(arr[0]["id"].as_str().unwrap(), "nk_fresh");
    }

    #[test]
    fn result_apply_removes_pending_and_emits_ok() {
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[{"name":"a.zip","url":"https://x.com/a.zip","size":1024}]}"#;
        let (status, resp, event) = netdisk_result_apply(&p, body).expect("应解析成功");
        assert_eq!(status.as_str(), "200 OK");
        assert_eq!(resp.as_str(), "{\"ok\":true}");
        assert_eq!(event["id"].as_str().unwrap(), "nk_1");
        assert_eq!(event["files"][0]["url"].as_str().unwrap(), "https://x.com/a.zip");
        assert!(p.lock().unwrap().is_empty(), "回传后 pending 应被移除");
    }

    #[test]
    fn result_apply_ssrf_filters_private_url() {
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[{"name":"a","url":"http://127.0.0.1:8080/a","size":1}]}"#;
        let (_s, _r, event) = netdisk_result_apply(&p, body).unwrap();
        let files = event["files"].as_array().unwrap();
        assert!(files.is_empty(), "私网直链必须被过滤");
        assert_eq!(event["ok"], serde_json::Value::Bool(false));
    }

    #[test]
    fn result_apply_keeps_public_url() {
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[{"name":"a","url":"https://cdn.example.com/a.zip","size":1}]}"#;
        let (_s, _r, event) = netdisk_result_apply(&p, body).unwrap();
        let files = event["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "公网直链应保留");
    }

    #[test]
    fn result_apply_reports_missing_url_field() {
        // url 字段缺失（实际 baidu dlink 为空时会被静默丢弃），应给出诊断而非笼统报错。
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[{"name":"a.zip","size":1024}]}"#;
        let (_s, _r, event) = netdisk_result_apply(&p, body).unwrap();
        let files = event["files"].as_array().unwrap();
        assert!(files.is_empty(), "缺失 url 必须被过滤");
        assert_eq!(event["ok"], serde_json::Value::Bool(false));
        let err = event["error"].as_str().unwrap();
        assert!(
            err.contains("url 字段为空"),
            "应提示 url 字段缺失原因: {}",
            err
        );
    }

    #[test]
    fn result_apply_reports_empty_files_array() {
        // 扩展根本没返回文件（files:[]）—— 与「全部被过滤」语义不同，需区分。
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[]}"#;
        let (_s, _r, event) = netdisk_result_apply(&p, body).unwrap();
        assert_eq!(event["ok"], serde_json::Value::Bool(false));
        let err = event["error"].as_str().unwrap();
        assert!(
            err.contains("未返回任何文件"),
            "应区分扩展未返回文件: {}",
            err
        );
    }

    #[test]
    fn result_apply_reports_ssrf_block_reasons() {
        // 多种拦截原因混在一起：错误文案应包含每条具体原因（域名/IP/原因），便于排查。
        // 当前设计：3 条全部被拦时，error 文案应列出全部 3 条（限长前 3 = 全部展示）。
        let p = make_pending();
        insert(&p, "nk_1", 0);
        let body = r#"{"id":"nk_1","ok":true,"files":[
            {"name":"a","url":"http://127.0.0.1:8080/a"},
            {"name":"b","url":"http://169.254.169.254/latest/meta-data"},
            {"name":"c","url":"ftp://example.com/x"}
        ]}"#;
        let (_s, _r, event) = netdisk_result_apply(&p, body).unwrap();
        let files = event["files"].as_array().unwrap();
        assert!(files.is_empty(), "全部被拦时 files 应清空");
        assert_eq!(event["ok"], serde_json::Value::Bool(false));
        let err = event["error"].as_str().unwrap();
        assert!(err.contains("127.0.0.1"), "应提示私网 IP 拦截: {}", err);
        assert!(
            err.contains("169.254") || err.contains("metadata"),
            "应提示元数据拦截: {}",
            err
        );
        assert!(
            err.contains("scheme") || err.contains("ftp"),
            "应提示非法 scheme: {}",
            err
        );
        assert!(err.contains("全部 3 个文件被过滤"), "应说明总数: {}", err);
    }

    #[test]
    fn result_apply_bad_json_returns_none() {
        let p = make_pending();
        assert!(netdisk_result_apply(&p, "not json").is_none());
    }
}
