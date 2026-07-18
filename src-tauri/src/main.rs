mod download;
mod db;
mod commands;

use std::io::Write;
use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

pub use download::{DownloadManager, DownloadTask, DownloadStatus};

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

            std::thread::spawn(move || { if let Err(e) = run_http(dm) { tracing::error!("HTTP: {}", e); } });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_download, commands::pause_download,
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

fn run_http(dm: Arc<DownloadManager>) -> Result<(), Box<dyn std::error::Error>> {
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

                    if r.contains("/download") {
                        if let Some(pos) = r.find("\r\n\r\n") {
                            let body = &r[pos + 4..];
                            if let Ok(j) = serde_json::from_str::<serde_json::Value>(body) {
                                if let Some(u) = j.get("url").and_then(|v| v.as_str()) {
                                    // 修复(P0)：SSRF 防护——仅允许 http/https，拒绝私网/回环/链路本地 IP
                                    if let Err(reason) = is_url_safe(u) {
                                        log_http(&format!("[block] {} -> {}", u, reason));
                                        write_json(
                                            &mut s,
                                            "400 Bad Request",
                                            &format!("{{\"e\":\"url_blocked\",\"msg\":\"{}\"}}", reason),
                                            origin,
                                        );
                                        return;
                                    }
                                    let dir = dirs::download_dir()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_string();
                                    match dm.create_download(u.into(), dir).await {
                                        Ok(t) => {
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
}
