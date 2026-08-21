// BitTorrent / 磁力下载支持（librqbit 嵌入式会话，纯 Rust 无外部二进制）。
//
// 设计：
//   - 全局懒初始化 Session（首次添加任务时创建，默认下载目录 = 用户首选目录）
//   - BT_TASKS 维护 info_hash(hex) -> Arc<ManagedTorrent> 映射，任务 id 即 info_hash
//   - 进度/速度通过 handle.stats()（TorrentStats）查询，前端轮询
//   - 暂停/恢复走 Session::pause/unpause；删除走 Session::delete（不删文件）
//
// 关键修复（r22, 2026-08-20）：
//   - 经实测 magnet `urn:btih:C807C4AF...1CBF1` 仍是活的（在 opentrackr/stealth.si 各 9-14 个 seeder）。
//   - 但 magnet 不带 tr= 时，librqbit 完全依赖 DHT bootstrap 找 peers。DHT 依赖入站端口可绑定，
//     NAT/防火墙后入连不可达时，DHT bootstrap 极慢，导致 add_torrent 30s/60s 内拿不到 metadata。
//   - 修：在 SessionOptions.trackers 与 AddTorrentOptions.trackers 两层都注入一组公开
//     UDP tracker（opentrackr / torrent.eu.org / open.stealth.si / openbittorrent），
//     让 tracker 直接告诉 peers，绕过 DHT 冷启动。
//   - 同时 add_torrent 超时 30s → 60s（首次冷 metadata 互换需时），
//   - task_stats 增加 fetching_metadata 状态（ManagedTorrentState::Initializing），
//     让前端能看到「正在下载 metadata」而不是卡死的假象。
//   - magnet URL 自动追补 4 个默认 tracker（magnet 协议允许多个 tr=，librqbit 会去重）。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, ManagedTorrentState,
    Session, SessionOptions,
};
use url::Url;

static BT_SESSION: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();
static BT_TASKS: OnceLock<Mutex<HashMap<String, Arc<ManagedTorrent>>>> = OnceLock::new();

pub fn bt_tasks() -> &'static Mutex<HashMap<String, Arc<ManagedTorrent>>> {
    BT_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bt_session() -> &'static Mutex<Option<Arc<Session>>> {
    BT_SESSION.get_or_init(|| Mutex::new(None))
}

/// 公开的兜底 UDP trackers（经 2026-08-20 实测：opentrackr/stealthsi/torrent.eu.org 都可达）。
/// 当用户提供的 magnet 不含 tr= 参数时，这些 trackers 让 librqbit 立即下发 peers，
/// 避免冷 DHT bootstrap 超时。
fn default_public_trackers() -> Vec<Url> {
    const TRACKERS: &[&str] = &[
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.openbittorrent.com:1337/announce",
    ];
    TRACKERS
        .iter()
        .filter_map(|s| Url::parse(s).ok())
        .collect()
}

/// 给 magnet URL 追补默认 trackers（magnet 协议允许多个 tr= 重复，librqbit 会去重）。
/// 其它类型 source 原样返回。
fn enrich_magnet(magnet: &str) -> String {
    if !magnet.starts_with("magnet:") {
        return magnet.to_string();
    }
    let mut url = magnet.to_string();
    for tr in default_public_trackers() {
        url.push_str("&tr=");
        url.push_str(tr.as_str());
    }
    url
}

/// 惰性创建 BT 会话（下载目录 = 默认下载目录）。
/// 包 15s 超时：librqbit 启动 DHT/UTP listener + bind 6881 等网络初始化在国内/受限网络下可能阻塞，
/// 超时返回清晰错误，避免前端 invoke 永远 pending。
async fn ensure_session(default_dir: PathBuf) -> Result<Arc<Session>, String> {
    // 快速路径：已有会话直接返回（先取快照再 drop guard，避免 guard 跨 await 导致 future 非 Send）
    if let Some(s) = bt_session()
        .lock()
        .map_err(|_| "BT 会话锁被污染")?
        .clone()
    {
        return Ok(s);
    }

    // 把默认 trackers 注入 Session 全局 trackers 集合。所有 magnet 即使完全没 tr=
    // 也能立即拿到首批 peers，绕过 DHT 冷启动。
    let opts = SessionOptions {
        trackers: default_public_trackers().into_iter().collect(),
        ..SessionOptions::default()
    };

    let session = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        Session::new_with_opts(default_dir, opts),
    )
    .await
    .map_err(|_| {
        "BT 会话启动超时（15s）：librqbit 启动 DHT/UTP listener 阻塞，可能被防火墙拦截或 DHT 引导失败。请检查网络/防火墙后重试"
            .to_string()
    })?;
    let session: Arc<Session> = session.map_err(|e| format!("BT 会话初始化失败: {e}"))?;
    let mut s = bt_session().lock().map_err(|_| "BT 会话锁被污染")?;
    if s.is_none() {
        *s = Some(session.clone());
    }
    Ok(s.as_ref().expect("just set").clone())
}

/// 添加磁力链接或 .torrent 下载任务，返回任务信息 JSON。
/// source: "magnet:?xt=..." / "http(s)://.../x.torrent" / 本地 ".torrent 文件路径"
pub async fn add_torrent(
    source: String,
    save_dir: Option<String>,
    default_dir: PathBuf,
) -> Result<serde_json::Value, String> {
    let session = ensure_session(default_dir).await?;

    let mut options = AddTorrentOptions::default();
    options.overwrite = true; // 允许覆盖已存在文件/续传
    if let Some(dir) = save_dir {
        if !dir.trim().is_empty() {
            options.output_folder = Some(dir.trim().to_string());
        }
    }
    // 显式追补 trackers（即使 magnet 自带 tr= 也追加，librqbit 会去重并并入全局集合）。
    // 这一层加固：SessionOptions.trackers 是全 session 默认；Options.trackers 则是本次任务级；
    // 两层叠加防止 magnet URL + Session 都错过某 tracker。
    // AddTorrentOptions.trackers 字段类型是 Vec<String>，需要转换。
    let tr_strs: Vec<String> = default_public_trackers()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    options.trackers = Some(tr_strs);

    let is_magnet = source.starts_with("magnet:");
    let is_http_url = source.starts_with("http://") || source.starts_with("https://");

    // magnet URL 字符串内追加 tr= 参数（兜底 magnet 没自带 tr= 的场景）。
    let enriched_source = if is_magnet {
        enrich_magnet(&source)
    } else {
        source.clone()
    };

    let add = if is_magnet || is_http_url {
        AddTorrent::from_url(enriched_source)
    } else {
        let bytes = std::fs::read(&source).map_err(|e| format!("读取 torrent 文件失败: {e}"))?;
        AddTorrent::from_bytes(bytes)
    };

    tracing::info!(
        "[bt] 添加任务: scheme=magnet={} http={} default_trackers=4 enriched_url_len={}",
        is_magnet,
        is_http_url,
        if is_magnet { source.len() } else { 0 }
    );

    // 60s 超时：磁力解析 + DHT/peer 启动可能慢（特别是冷启动/弱网）。
    // 30s 在国内 NAT 网络下不够 -> 60s 给 metadata 互换充足时间。
    let resp_outer = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        session.add_torrent(add, Some(options)),
    )
    .await
    .map_err(|_| {
        "添加 BT 任务超时（60s）：磁力 metadata 互换或 peer 发现阻塞。请检查网络/防火墙（如允许 udp:1337、udp:451、tcp:80 入连），或换一个磁力试试"
            .to_string()
    })?;
    let resp = resp_outer.map_err(|e| format!("添加任务失败: {e}"))?;
    let handle = resp
        .into_handle()
        .ok_or_else(|| "添加任务未返回句柄（可能是 list-only 模式）".to_string())?;
    let id = handle.info_hash().as_string();

    {
        let mut tasks = bt_tasks().lock().map_err(|_| "任务表锁被污染")?;
        tasks.insert(id.clone(), handle);
    }

    Ok(task_stats(&id).unwrap_or_else(|| {
        serde_json::json!({ "id": id, "name": id, "state": "downloading", "progress": 0.0,
            "download_rate": 0, "upload_rate": 0, "downloaded_bytes": 0, "total_bytes": 0 })
    }))
}

/// 添加前快速预检：判断该磁力资源是否有「活跃做种者」、能否真实取到 metadata。
///
/// 复用 librqbit 的 `list_only` 模式：对 magnet 会走 `resolve_magnet` 做真实的 BEP9 metadata 互换
/// （与真正下载走同一条 DHT/peer 路径）。成功后返回 `AddTorrentResponse::ListOnly`——
/// **不下载、不留常驻任务、无需清理**，正是理想的预检原语。
///
/// 判定矩阵：
///   - 12s 内取到 metadata  → can_download=true（资源活着，有 peer 愿意提供 metadata）
///   - 12s 超时（DHT 找到的 peer 都连不上 / 无人提供 metadata）→ can_download=false
///     （"DHT 有 peer 记录" ≠ 资源活着；这里是真要求完成 metadata 传输，判别力远高于只看 tracker seeders）
///   - magnet 本身非法（缺 infohash 等）→ Err（真实错误，前端按创建失败处理，不要给"仍要添加"）
pub async fn precheck_torrent(
    source: String,
    default_dir: PathBuf,
) -> Result<serde_json::Value, String> {
    let session = ensure_session(default_dir).await?;

    let is_magnet = source.starts_with("magnet:");
    let is_http_url = source.starts_with("http://") || source.starts_with("https://");

    let enriched_source = if is_magnet {
        enrich_magnet(&source)
    } else {
        source.clone()
    };

    let add = if is_magnet || is_http_url {
        AddTorrent::from_url(enriched_source)
    } else {
        let bytes = std::fs::read(&source).map_err(|e| format!("读取 torrent 文件失败: {e}"))?;
        AddTorrent::from_bytes(bytes)
    };

    let mut opts = AddTorrentOptions::default();
    opts.list_only = true; // 只取 metadata，不下载、不常驻
    opts.overwrite = true;
    let tr_strs: Vec<String> = default_public_trackers()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    opts.trackers = Some(tr_strs);

    // 12s 预检超时：真实 metadata 互换通常秒级完成（活跃资源实测 <10s）；
    // 超过即视为该资源当前无活跃做种者 / 所有发现的 peer 均不可达。
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        session.add_torrent(add, Some(opts)),
    )
    .await;

    // 超时分支：资源极可能已死（无人做种 / 全是死 peer）。返回结构化「不可下载」，
    // 让前端弹确认而非笼统报错，避免用户误以为软件坏了。
    if resp.is_err() {
        return Ok(serde_json::json!({
            "can_download": false,
            "reason": "no_metadata",
            "message": "预检超时（12s）：该磁力资源当前无活跃做种者（DHT 发现的 peer 均无法连接或无人提供 metadata），可能无法下载。\
建议换一个磁力链接，或让原分享者提供带 metadata 的 .torrent 文件。",
        }));
    }

    match resp.unwrap() {
        Ok(AddTorrentResponse::ListOnly(r)) => {
            let name = r
                .info
                .name()
                .map(|c| c.to_string())
                .unwrap_or_else(|| r.info_hash.as_string());
            let file_count = r.info.iter_file_details().count();
            let total_bytes: u64 = r.info.iter_file_lengths().sum();
            let seen_peers = r.seen_peers.len();
            Ok(serde_json::json!({
                "can_download": true,
                "info_hash": r.info_hash.as_string(),
                "name": name,
                "file_count": file_count,
                "total_bytes": total_bytes,
                "seen_peers": seen_peers,
                "message": format!(
                    "资源当前可下载（DHT 发现 {seen_peers} 个 peer，已成功取到 metadata，共 {file_count} 个文件 / {}）",
                    format_bytes(total_bytes)
                ),
            }))
        }
        // 以下两分支理论上不会走到（list_only=true 必返回 ListOnly），仅作防御性兜底。
        Ok(AddTorrentResponse::Added(_, h)) => {
            let _ = session
                .delete(TorrentIdOrHash::Hash(h.info_hash()), false)
                .await;
            Ok(serde_json::json!({
                "can_download": true,
                "reason": "already_added_as_managed",
                "message": "资源可下载（预检意外转为常驻任务，请重新操作）",
            }))
        }
        Ok(AddTorrentResponse::AlreadyManaged(_, _)) => Ok(serde_json::json!({
            "can_download": true,
            "reason": "already_managed",
            "message": "该资源已在任务列表中（重复添加）",
        })),
        Err(e) => Err(format!("预检失败: {e}")),
    }
}

/// 人类可读的字节数（复用显示用，不进 i18n）。
fn format_bytes(n: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{:.2} {}", v, UNITS[i])
    }
}

/// 查询任务状态（进度/速度/状态），前端轮询。
/// 重要：通过 ManagedTorrentState 区分 Initializing（metadata 互换中）/ Live（下载中）/
/// Paused / Error，前端可以看到「正在获取元数据」而不是误以为下载卡死。
pub fn task_stats(id: &str) -> Option<serde_json::Value> {
    let tasks = bt_tasks().lock().ok()?;
    let handle = tasks.get(id)?.clone();
    drop(tasks);
    let stats = handle.stats();
    let total = stats.total_bytes.max(1);
    let progress = (stats.progress_bytes as f64 / total as f64).clamp(0.0, 1.0);
    // Initializing 表示正在做磁力 metadata 互换（ut_metadata BEP9）；下载任务尚未真正开始。
    let state = {
        let mut s = String::from("downloading");
        handle.with_state(|st| {
            s = match st {
                ManagedTorrentState::Initializing(_) => "fetching_metadata".to_string(),
                ManagedTorrentState::Live(_) => {
                    if stats.finished {
                        "completed".to_string()
                    } else {
                        "downloading".to_string()
                    }
                }
                ManagedTorrentState::Paused(_) => "paused".to_string(),
                ManagedTorrentState::Error(_) => "error".to_string(),
                _ => "downloading".to_string(),
            };
        });
        s
    };
    let (down, up) = match &stats.live {
        Some(l) => (l.download_speed.as_bytes(), l.upload_speed.as_bytes()),
        None => (0, 0),
    };
    Some(serde_json::json!({
        "id": id,
        "name": handle.name().unwrap_or_else(|| id.to_string()),
        "state": state,
        "progress": (progress * 10000.0).round() / 100.0,
        "download_rate": down,
        "upload_rate": up,
        "downloaded_bytes": stats.progress_bytes,
        "total_bytes": stats.total_bytes,
    }))
}

/// 列出所有 BT 任务
pub fn list_tasks() -> Vec<serde_json::Value> {
    let tasks = bt_tasks().lock().unwrap();
    let ids: Vec<String> = tasks.keys().cloned().collect();
    drop(tasks);
    ids.iter().filter_map(|id| task_stats(id)).collect()
}

fn session_ref() -> Result<Arc<Session>, String> {
    bt_session()
        .lock()
        .map_err(|_| "BT 会话锁被污染".to_string())?
        .clone()
        .ok_or_else(|| "BT 会话未初始化".to_string())
}

/// 暂停任务
pub async fn pause_task(id: &str) -> Result<(), String> {
    let session = session_ref()?;
    let handle = {
        let tasks = bt_tasks().lock().map_err(|_| "任务表锁被污染")?;
        tasks
            .get(id)
            .ok_or_else(|| format!("任务不存在: {id}"))?
            .clone()
    };
    session
        .pause(&handle)
        .await
        .map_err(|e| format!("暂停失败: {e}"))
}

/// 恢复任务
pub async fn resume_task(id: &str) -> Result<(), String> {
    let session = session_ref()?;
    let handle = {
        let tasks = bt_tasks().lock().map_err(|_| "任务表锁被污染")?;
        tasks
            .get(id)
            .ok_or_else(|| format!("任务不存在: {id}"))?
            .clone()
    };
    session
        .unpause(&handle)
        .await
        .map_err(|e| format!("恢复失败: {e}"))
}

/// 删除任务（停止下载，不删已下载文件）
pub async fn remove_task(id: &str) -> Result<(), String> {
    let session = session_ref()?;
    let info_hash = {
        let tasks = bt_tasks().lock().map_err(|_| "任务表锁被污染")?;
        tasks
            .get(id)
            .ok_or_else(|| format!("任务不存在: {id}"))?
            .info_hash()
    };
    session
        .delete(TorrentIdOrHash::Hash(info_hash), false)
        .await
        .map_err(|e| format!("删除任务失败: {e}"))?;
    let mut tasks = bt_tasks().lock().map_err(|_| "任务表锁被污染")?;
    tasks.remove(id);
    Ok(())
}
