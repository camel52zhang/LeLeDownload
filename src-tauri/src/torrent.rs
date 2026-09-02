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

/// 进程内 metadata 缓存：info_hash(hex) -> 完整 bencoded .torrent 字节。
/// 由 `get_file_list` 写入（来自 `ListOnlyResponse.torrent_bytes`），`add_torrent` 命中后
/// 改用 `AddTorrent::from_bytes` 直接建任务，跳过第二次 BEP9 metadata 互换。
/// 语义：**只读不移除**（用户取消后重新选择仍可命中）；不持久化，进程退出自然失效并回退常规流程。
static BT_METADATA_CACHE: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();

pub fn bt_tasks() -> &'static Mutex<HashMap<String, Arc<ManagedTorrent>>> {
    BT_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bt_metadata_cache() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    BT_METADATA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
///
/// only_files：只下载这些索引对应的文件（索引契约见 `BtFileEntry.index`）。
///   `None` = 全量下载，与旧版行为完全一致（HTTP 路由 / 降级路径继续走这条）。
/// metadata_cache_key：`get_file_list` 返回的 info_hash。命中 `BT_METADATA_CACHE` 时
///   直接用缓存的完整 .torrent 字节建任务，跳过第二次 BEP9 metadata 互换（秒级启动）；
///   未命中则回退常规 from_url / 读本地文件流程（行为不变）。
pub async fn add_torrent(
    source: String,
    save_dir: Option<String>,
    default_dir: PathBuf,
    only_files: Option<Vec<usize>>,
    metadata_cache_key: Option<String>,
) -> Result<serde_json::Value, String> {
    // 边界校验：显式传了空选集等于「一个文件都不下」，属无意义任务，直接拒绝
    // （librqbit 会接受空 Vec 并建出永不完成的任务）。
    if only_files.as_ref().is_some_and(|v| v.is_empty()) {
        return Err("未选择任何文件，请至少勾选一个文件后再添加".to_string());
    }

    let session = ensure_session(default_dir).await?;

    let mut options = AddTorrentOptions::default();
    options.overwrite = true; // 允许覆盖已存在文件/续传
    options.only_files = only_files;
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

    // 优先命中 get_file_list 缓存的完整 .torrent 字节：省掉一次 metadata 互换。
    let cached_bytes = match metadata_cache_key.as_deref() {
        Some(key) if !key.is_empty() => bt_metadata_cache()
            .lock()
            .map_err(|_| "metadata 缓存锁被污染")?
            .get(key)
            .cloned(),
        _ => None,
    };
    let from_cache = cached_bytes.is_some();

    let add = if let Some(bytes) = cached_bytes {
        AddTorrent::from_bytes(bytes)
    } else if is_magnet || is_http_url {
        AddTorrent::from_url(enriched_source)
    } else {
        let bytes = std::fs::read(&source).map_err(|e| format!("读取 torrent 文件失败: {e}"))?;
        AddTorrent::from_bytes(bytes)
    };

    tracing::info!(
        "[bt] 添加任务: scheme=magnet={} http={} default_trackers=4 enriched_url_len={} from_metadata_cache={} only_files={:?}",
        is_magnet,
        is_http_url,
        if is_magnet { source.len() } else { 0 },
        from_cache,
        options.only_files.as_ref().map(|v| v.len())
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

/// 种子内单个文件条目。
/// `index` 即 librqbit `AddTorrentOptions.only_files` 的索引契约 ——
/// 来源是 `iter_file_details().enumerate()`，与 librqbit 内部过滤（`api.rs` 的
/// `only_files.contains(&idx)`）和 `update_only_files` 三者严格一致。前端必须原样回传，不得重排。
#[derive(serde::Serialize)]
struct BtFileEntry {
    index: usize,
    /// 完整相对路径，统一用 '/' 连接（**不用 `filename.to_string()`**：
    /// librqbit 的 Display 实现用 `std::path::MAIN_SEPARATOR`，在 Windows 上会输出 '\'，
    /// 导致跨平台 JSON 不一致。这里直接由 components join 得到，保证前后端渲染一致）。
    name: String,
    /// 路径分量；单文件种子即 [文件名]（无目录），与多文件种子同一结构。
    components: Vec<String>,
    length: u64,
}

/// 由 metadata 枚举出文件清单。**index 契约的唯一产地**：`iter_file_details()` 的枚举序
/// 即 `only_files` 的索引序（librqbit 内部同样用 `.enumerate()` 过滤）。
fn build_file_entries<B: AsRef<[u8]>>(
    info: &librqbit::ValidatedTorrentMetaV1Info<B>,
) -> Vec<BtFileEntry> {
    info.iter_file_details()
        .enumerate()
        .map(|(index, d)| {
            let components = d.filename.to_vec();
            BtFileEntry {
                index,
                name: components.join("/"),
                components,
                length: d.len,
            }
        })
        .collect()
}

/// `get_file_list` 的返回结构（Tauri 默认 serde 直传，前端 TS 同名 snake_case 字段）。
#[derive(serde::Serialize)]
struct BtFileList {
    info_hash: String,
    name: String,
    can_download: bool,
    reason: Option<String>,
    message: String,
    total_bytes: u64,
    file_count: usize,
    seen_peers: usize,
    files: Vec<BtFileEntry>,
}

/// 取磁力 / .torrent 的**完整文件清单**（供用户勾选后只下选中项）。
///
/// 与 `precheck_torrent` 同样走 librqbit `list_only`（真实 BEP9 metadata 互换、不下载、
/// 不留常驻任务），但额外做两件事：
///   1. 枚举 `iter_file_details()` 下发每个文件的 index/name/components/length；
///   2. 把 `ListOnlyResponse.torrent_bytes`（完整 bencoded .torrent）以 info_hash 为 key
///      存入 `BT_METADATA_CACHE`，随后的 `add_torrent` 命中缓存即可跳过第二次 metadata
///      互换 —— 消除旧「precheck(12s) + add(60s) 两次握手」的重复开销。
///
/// 拿不到 metadata（冷门种子 / 无做种者）时返回 `can_download=false, reason="no_metadata"`，
/// 由前端弹确认让用户显式决定是否降级为全量下载（不做静默降级）。
pub async fn get_file_list(
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

    // 12s 超时：与 precheck 同一基线（活跃资源实测 <15s 拿到 metadata）。
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        session.add_torrent(add, Some(opts)),
    )
    .await;

    if resp.is_err() {
        let out = BtFileList {
            info_hash: String::new(),
            name: String::new(),
            can_download: false,
            reason: Some("no_metadata".to_string()),
            message: "获取文件清单超时（12s）：该资源当前无活跃做种者（DHT 发现的 peer 均无法连接或无人提供 metadata），\
拿不到种子内的文件列表。可以选择仍按全量尝试下载，或换一个磁力 / 让原分享者提供 .torrent 文件。"
                .to_string(),
            total_bytes: 0,
            file_count: 0,
            seen_peers: 0,
            files: Vec::new(),
        };
        return serde_json::to_value(out).map_err(|e| format!("清单序列化失败: {e}"));
    }

    match resp.unwrap() {
        Ok(AddTorrentResponse::ListOnly(r)) => {
            let info_hash = r.info_hash.as_string();
            // 缓存完整 bencoded .torrent 供 add 复用（只写不移除，见 BT_METADATA_CACHE 注释）。
            {
                let mut cache = bt_metadata_cache()
                    .lock()
                    .map_err(|_| "metadata 缓存锁被污染")?;
                cache.insert(info_hash.clone(), r.torrent_bytes.to_vec());
            }

            let files = build_file_entries(&r.info);

            let total_bytes: u64 = files.iter().map(|f| f.length).sum();
            let file_count = files.len();
            let seen_peers = r.seen_peers.len();
            let name = r
                .info
                .name()
                .map(|c| c.to_string())
                .unwrap_or_else(|| info_hash.clone());

            tracing::info!(
                "[bt] 文件清单: info_hash={} files={} total={} peers={} cached_torrent_bytes={}",
                info_hash,
                file_count,
                total_bytes,
                seen_peers,
                r.torrent_bytes.len()
            );

            let out = BtFileList {
                info_hash,
                name,
                can_download: true,
                reason: None,
                message: format!(
                    "已取到文件清单（DHT 发现 {seen_peers} 个 peer，共 {file_count} 个文件 / {}），请勾选需要下载的文件",
                    format_bytes(total_bytes)
                ),
                total_bytes,
                file_count,
                seen_peers,
                files,
            };
            serde_json::to_value(out).map_err(|e| format!("清单序列化失败: {e}"))
        }
        // list_only=true 时 librqbit 必在解析出 metadata 后立即返回 ListOnly
        // （session.rs:1297 的 early return 早于 AlreadyManaged 判定），以下仅防御性兜底。
        Ok(AddTorrentResponse::Added(_, h)) => {
            let _ = session
                .delete(TorrentIdOrHash::Hash(h.info_hash()), false)
                .await;
            Err("获取清单时意外创建了常驻任务（已清理），请重试".to_string())
        }
        Ok(AddTorrentResponse::AlreadyManaged(_, _)) => {
            Err("该资源已在任务列表中，如需重新选择文件请先删除原任务".to_string())
        }
        Err(e) => {
            // librqbit-core 在拿到 metadata 后会做安全校验（librqbit-core/src/torrent_metainfo.rs:307-355）：
            // 文件名含路径分隔符 / ".." 穿越 / 重名 / 0 长度等一律拒绝解析。这类种子**全量下载
            // 也同样无法进行**，因此不提示"降级全量"（那只会再报一次同样的错），直接给明确结论。
            let raw = e.to_string();
            let bad_meta = [
                "suspicious separator in filename",
                "path traversal detected",
                "duplicate filenames in torrent",
                "empty filename in torrent",
                "torrent has a file with no name",
                "no files in torrent",
            ]
            .iter()
            .any(|k| raw.contains(k));
            if bad_meta {
                Err(format!(
                    "该种子的文件结构不合法，BT 引擎出于安全拒绝解析（这类种子全量下载也无法进行），\
请让分享者重新制种或换一个磁力。原始错误: {raw}"
                ))
            } else {
                Err(format!("获取文件清单失败: {raw}"))
            }
        }
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
    // 选择性下载任务（only_files=Some）时下发已选文件数，让列表行能区分「部分下载」与全量。
    // 直接取 librqbit 的权威状态（ManagedTorrent::only_files），不在本地另存一份，避免状态漂移。
    let only_files = handle.only_files();
    Some(serde_json::json!({
        "id": id,
        "name": handle.name().unwrap_or_else(|| id.to_string()),
        "selected_count": only_files.as_ref().map(|v| v.len()),
        "only_files": only_files,
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

// ===========================================================================
// 测试。本 crate 是二进制 crate（无 lib target），因此只能用 `cargo test <过滤名>` 运行，
// 不能用 `cargo test --lib`。
//   离线单测（默认跑）：cargo test bt_          （不联网，秒级）
//   联网正确性测试     ：cargo test only_files -- --ignored --nocapture
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// 团队给的样本磁力：DHT peer 充足、metadata 秒级可取，但**文件名内含路径分隔符**，
    /// 被 librqbit-core 的安全校验拒绝（见 `bt_probe_file_list` 探针实测）。只用于
    /// 「不触网的离线用例」与「畸形种子的错误路径」，联网下载类用例改用 `SINTEL_MAGNET`。
    const SAMPLE_MAGNET: &str = "magnet:?xt=urn:btih:9C08401EDA498BF1561F9668EA0A1597E2B30CA3";

    /// 联网用例的基准种子：Sintel（Blender 开源短片）。多文件（10 个 srt + 1 个 mp4 + 海报），
    /// 常年做种充足；index=0 是 1.6KB 的字幕，几秒即可下完，适合验证 only_files。
    const SINTEL_MAGNET: &str = "magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lele_bt_test_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 离线：metadata 缓存读写语义（写入可读回、未知 key 必 miss、重复写覆盖）。
    #[test]
    fn bt_metadata_cache_read_write() {
        let key = "0123456789abcdef0123456789abcdef01234567".to_string();
        {
            let mut c = bt_metadata_cache().lock().unwrap();
            c.insert(key.clone(), vec![1, 2, 3]);
        }
        {
            let c = bt_metadata_cache().lock().unwrap();
            assert_eq!(c.get(&key).map(|v| v.as_slice()), Some(&[1u8, 2, 3][..]));
            assert!(c.get("ffffffffffffffffffffffffffffffffffffffff").is_none());
        }
        // 同 key 重复 get_file_list 应覆盖而非追加
        {
            let mut c = bt_metadata_cache().lock().unwrap();
            c.insert(key.clone(), vec![9]);
            assert_eq!(c.get(&key).map(|v| v.len()), Some(1));
            c.remove(&key); // 不污染同进程内其它测试
        }
    }

    /// 离线：magnet 追补默认 trackers；非 magnet 原样返回。
    #[test]
    fn bt_enrich_magnet_appends_trackers() {
        let out = enrich_magnet(SAMPLE_MAGNET);
        assert_eq!(out.matches("&tr=").count(), 4);
        assert!(out.starts_with(SAMPLE_MAGNET));
        let plain = "https://example.com/a.torrent";
        assert_eq!(enrich_magnet(plain), plain);
    }

    /// 离线：**index 契约** —— 用 librqbit 自带的 create_torrent 就地造一个多文件种子
    /// （含子目录 + 典型垃圾文件），验证 build_file_entries 产出的 index 连续、
    /// name 与 components 一致且统一用 '/'（不能出现 Windows 的 '\'）、length 正确。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bt_build_file_entries_index_contract() {
        let src = temp_dir("mk");
        std::fs::write(src.join("movie.mp4"), vec![7u8; 3000]).unwrap();
        std::fs::write(src.join("readme.nfo"), vec![1u8; 12]).unwrap();
        std::fs::create_dir_all(src.join("subs")).unwrap();
        std::fs::write(src.join("subs").join("cn.srt"), vec![2u8; 500]).unwrap();

        let res = librqbit::create_torrent(
            &src,
            librqbit::CreateTorrentOptions {
                name: Some("sample"),
                ..Default::default()
            },
            &librqbit::spawn_utils::BlockingSpawner::new(1),
        )
        .await
        .expect("造种失败");
        let validated = res
            .as_info()
            .info
            .data
            .clone()
            .validate()
            .expect("种子 info 校验失败");

        let entries = build_file_entries(&validated);
        assert_eq!(entries.len(), 3, "应枚举出 3 个文件");
        for (i, e) in entries.iter().enumerate() {
            assert_eq!(e.index, i, "index 必须是 0..n 连续枚举序（only_files 契约）");
            assert_eq!(e.name, e.components.join("/"), "name 必须等于分量以 '/' 连接");
            assert!(!e.name.contains('\\'), "name 不允许出现平台分隔符 '\\': {}", e.name);
            assert!(!e.components.is_empty());
        }
        assert_eq!(entries.iter().map(|e| e.length).sum::<u64>(), 3000 + 12 + 500);

        let mut names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["movie.mp4", "readme.nfo", "subs/cn.srt"]);
        let srt = entries.iter().find(|e| e.name == "subs/cn.srt").unwrap();
        assert_eq!(srt.components, vec!["subs".to_string(), "cn.srt".to_string()]);
        assert_eq!(srt.length, 500);

        let _ = std::fs::remove_dir_all(&src);
    }

    /// 离线：空选集必须被拒绝（否则 librqbit 会建出一个永不完成的空任务）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bt_add_torrent_rejects_empty_selection() {
        let dir = temp_dir("empty");
        let err = add_torrent(
            SAMPLE_MAGNET.to_string(),
            Some(dir.to_string_lossy().to_string()),
            dir.clone(),
            Some(Vec::new()),
            None,
        )
        .await
        .expect_err("空选集应直接报错，且不应触碰网络");
        assert!(err.contains("未选择任何文件"), "错误信息不符: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 诊断探针（联网，默认跳过）：对多个 magnet 逐个跑 get_file_list 并打印耗时/结果。
    /// 控制组用一个不存在的 info_hash —— 它必须**超时**（12s）才能证明"其它 magnet 的
    /// 报错是真的拿到 metadata 之后才发生的"，而不是我们代码路径的问题。
    /// 手动运行: cargo test bt_probe_file_list -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "诊断用，需真实网络"]
    async fn bt_probe_file_list() {
        let out = temp_dir("probe");
        let cands: Vec<(&str, &str)> = vec![
            (
                "控制组(不存在的 hash，应超时)",
                "magnet:?xt=urn:btih:0000000000000000000000000000000000000001",
            ),
            ("样本 magnet", SAMPLE_MAGNET),
            ("Sintel(多文件)", SINTEL_MAGNET),
            (
                "BigBuckBunny(多文件)",
                "magnet:?xt=urn:btih:DD8255ECDC7CA55FB0BBF81323D87062DB1F6D1C",
            ),
        ];
        for (label, m) in cands {
            let t0 = std::time::Instant::now();
            let r = get_file_list(m.to_string(), out.clone()).await;
            let ms = t0.elapsed().as_millis();
            match r {
                Err(e) => println!("[probe] {label}: Err({ms}ms) {e}"),
                Ok(v) => {
                    println!(
                        "[probe] {label}: Ok({ms}ms) can_download={} name={} files={} total={} peers={}",
                        v["can_download"],
                        v["name"].as_str().unwrap_or(""),
                        v["file_count"],
                        format_bytes(v["total_bytes"].as_u64().unwrap_or(0)),
                        v["seen_peers"]
                    );
                    if let Some(fs) = v["files"].as_array() {
                        for f in fs.iter().take(30) {
                            println!(
                                "[probe]   #{:<3} {:>12}  {}",
                                f["index"],
                                format_bytes(f["length"].as_u64().unwrap_or(0)),
                                f["name"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&out);
    }

    /// **正确性必测（联网，默认跳过）**：只勾选 1 个文件时，只有该文件被完整写出，
    /// 未选中的大文件绝不会被下载。
    ///
    /// librqbit 的三条实现事实（决定了断言只能这么写）：
    ///   1. `FilesystemStorage::init`（`storage/filesystem/fs.rs:125-166`）会为种子内**全部**
    ///      文件 `create(true)` 建出占位文件，**与 only_files 无关** —— 所以不能断言"文件不存在"。
    ///   2. 只有被选中的文件会 `ensure_file_length` + 被下满
    ///      （`torrent_state/initializing.rs:259-275`）。
    ///   3. **分片边界溢出**：`file_ops::write_chunk`（`src/file_ops.rs:310-355`）把一个 chunk
    ///      落到它跨越的**每一个**文件上，不看 only_files。BT 的下载单位是 piece，选中文件所在
    ///      的首/末 piece 会顺带覆盖相邻文件的一小段，因此相邻文件可能被写入 **< 1 个 piece**
    ///      的残缺字节（永远拼不成完整文件，对"拦截夹带垃圾"的目标无影响）。
    ///
    /// 故断言为：选中文件大小 == 其 length；其余文件写入量合计 < 16 MiB（≤1 个 piece 的溢出，
    /// 对比种子总大小 123 MB），且未选中的大文件远小于其 length（证明没被下载）。
    ///
    /// 注：这里**不能**用 `SAMPLE_MAGNET`（`9C08401E…`）—— 它的 metadata 能取到，但文件名里
    /// 含路径分隔符，被 librqbit-core 的安全校验拒绝（`torrent_metainfo.rs:307-355`），
    /// 该种子在旧版 `bt_precheck` / 全量下载路径下同样无法使用，与本功能无关。详见
    /// `bt_probe_file_list` 探针。改用 Sintel（Blender 开源短片，多文件 + 常年做种充足）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "需真实网络与做种者，耗时约 30-180s。手动运行: cargo test only_files -- --ignored --nocapture"]
    async fn test_only_files_download_writes_only_selected() {
        let out = temp_dir("dl");
        println!("[test] 输出目录: {}", out.display());

        // 1) 取清单
        let list = get_file_list(SINTEL_MAGNET.to_string(), out.clone())
            .await
            .expect("get_file_list 返回 Err");
        println!("[test] 清单: {}", list["message"].as_str().unwrap_or(""));
        assert_eq!(
            list["can_download"],
            serde_json::json!(true),
            "样本种子应能取到 metadata"
        );
        let files = list["files"].as_array().expect("files 不是数组").clone();
        assert!(!files.is_empty());
        assert_eq!(files.len() as u64, list["file_count"].as_u64().unwrap());
        // dump 真实清单（验证解析正确性，同时直观暴露种子里夹带的垃圾文件）
        println!(
            "[test] 种子名={} info_hash={} 文件数={} 总大小={}",
            list["name"].as_str().unwrap_or(""),
            list["info_hash"].as_str().unwrap_or(""),
            list["file_count"],
            format_bytes(list["total_bytes"].as_u64().unwrap_or(0))
        );
        for f in files.iter() {
            println!(
                "[test]   #{:<3} {:>12}  {}",
                f["index"],
                format_bytes(f["length"].as_u64().unwrap_or(0)),
                f["name"].as_str().unwrap_or("")
            );
        }
        for (i, f) in files.iter().enumerate() {
            assert_eq!(f["index"].as_u64().unwrap() as usize, i, "index 必须连续");
        }

        // 缓存必须命中（否则 add 会再握手一次 metadata）
        let info_hash = list["info_hash"].as_str().unwrap().to_string();
        assert!(
            bt_metadata_cache()
                .lock()
                .unwrap()
                .contains_key(&info_hash),
            "get_file_list 后 BT_METADATA_CACHE 应命中 {info_hash}"
        );

        // 2) 只选 index=0（种子内第一个文件，绝对偏移 0）。挑它是为了让"需要的 piece"只有
        //    piece 0，把上面第 3 条分片溢出的影响压到最小，同时几 KB 就能跑完。
        let pick = files[0].clone();
        let pick_idx = pick["index"].as_u64().unwrap() as usize;
        let pick_len = pick["length"].as_u64().unwrap();
        let pick_name = pick["name"].as_str().unwrap().to_string();
        assert_eq!(pick_idx, 0);
        println!("[test] 只下: index={pick_idx} len={pick_len} name={pick_name}");

        // 3) 只下该文件（走缓存字节，跳过二次 metadata 互换）
        let added = add_torrent(
            SINTEL_MAGNET.to_string(),
            Some(out.to_string_lossy().to_string()),
            out.clone(),
            Some(vec![pick_idx]),
            Some(info_hash),
        )
        .await
        .expect("add_torrent 返回 Err");
        let id = added["id"].as_str().unwrap().to_string();
        assert_eq!(
            added["selected_count"].as_u64(),
            Some(1),
            "任务应记录已选 1 个文件"
        );

        // 4) 轮询至完成（≤180s）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut done = false;
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let s = task_stats(&id).expect("任务应在表中");
            let state = s["state"].as_str().unwrap_or("");
            println!(
                "[test] state={state} progress={} downloaded={}",
                s["progress"], s["downloaded_bytes"]
            );
            if state == "completed" {
                done = true;
                break;
            }
            assert_ne!(state, "error", "任务进入错误态: {s}");
        }
        assert!(done, "180s 内未完成（可能样本种子已无做种者）");

        // 5) 断言：只有选中的文件被完整写出；其余文件顶多被分片边界溢出写入极少量残缺字节
        const SPILL_LIMIT: u64 = 16 * 1024 * 1024; // 1 个 piece 的上限（BT 常见最大 piece = 16MiB）
        let path_of = |name: &str| {
            let mut p = out.clone();
            for c in name.split('/') {
                p.push(c);
            }
            p
        };
        let target = path_of(&pick_name);
        let meta = std::fs::metadata(&target)
            .unwrap_or_else(|e| panic!("选中的文件不存在 {target:?}: {e}"));
        assert_eq!(meta.len(), pick_len, "选中文件大小应等于其 length");

        let mut spill_total = 0u64;
        for f in files.iter() {
            let idx = f["index"].as_u64().unwrap() as usize;
            if idx == pick_idx {
                continue;
            }
            let name = f["name"].as_str().unwrap();
            let len = f["length"].as_u64().unwrap();
            let on_disk = std::fs::metadata(path_of(name)).map(|m| m.len()).unwrap_or(0);
            spill_total += on_disk;
            println!("[test]   未选 #{idx:<3} 磁盘={on_disk:>10} / 应有={len:>10}  {name}");
            // 未选中的**大文件**绝不能被下载下来（小文件可能整个落在同一个 piece 里，
            // 那属于上述溢出，用 spill_total 统一兜住）。
            if len > SPILL_LIMIT {
                assert!(
                    on_disk < len / 10,
                    "未选中的大文件被下载了: {name} 磁盘 {on_disk} / 应有 {len}"
                );
            }
        }
        let total_bytes = list["total_bytes"].as_u64().unwrap();
        assert!(
            spill_total < SPILL_LIMIT,
            "未选中文件被写入过多数据: {spill_total} 字节（种子总大小 {total_bytes}）"
        );
        println!(
            "[test] 通过：index={pick_idx} 完整写出 {pick_len} 字节；其余 {} 个文件合计仅 {}（分片边界溢出，种子总大小 {}）",
            files.len() - 1,
            format_bytes(spill_total),
            format_bytes(total_bytes)
        );

        let _ = remove_task(&id).await;
        let _ = std::fs::remove_dir_all(&out);
    }
}
