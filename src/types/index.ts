export interface DownloadTask {
  id: string;
  url: string;
  filename: string;
  total_size: number;
  downloaded_size: number;
  speed: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'failed';
  progress: number;
  thread_count: number;
  created_at: string;
  completed_at?: string;
  error?: string;
  save_path: string;
  retry_count?: number;
  max_retries?: number;
  // 任务来源标识："direct"（旧直链路径）/ "share-link"（分享链接·需会话凭证增强路径）
  source?: string;
}

export interface DownloadProgress {
  id: string;
  downloaded_size: number;
  speed: number;
  progress: number;
  status: DownloadTask['status'];
}

// BitTorrent / 磁力任务（librqbit 会话，独立于 HTTP 下载列表）
export interface BtTask {
  id: string;
  name: string;
  state: 'downloading' | 'paused' | 'completed' | 'error' | 'fetching_metadata';
  progress: number;          // 0-100
  download_rate: number;     // B/s
  upload_rate: number;       // B/s
  downloaded_bytes: number;
  total_bytes: number;
  // 选择性下载任务才有：已选文件数 / 选中的文件索引（全量任务为 null）
  selected_count?: number | null;
  only_files?: number[] | null;
}

// 种子内的单个文件（来自 bt_get_file_list）。
// index 是 librqbit only_files 的索引契约（后端 iter_file_details().enumerate() 产生），
// 前端必须原样回传，绝不能按显示顺序重新编号，否则会下错文件。
export interface BtFileEntry {
  index: number;
  name: string;          // 完整相对路径，'/' 连接
  components: string[];  // 路径分量；单文件种子 = [文件名]
  length: number;        // 字节
}

// bt_get_file_list 返回：种子完整文件清单
export interface BtFileList {
  info_hash: string;
  name: string;
  can_download: boolean;         // false = 拿不到 metadata（无做种者），无清单可选
  reason?: string;               // 'no_metadata' | ...
  message: string;
  total_bytes: number;
  file_count: number;
  seen_peers: number;
  files: BtFileEntry[];
}

// 添加前的磁力资源预检结果（后端 bt_precheck，list_only 真实取 metadata）
export interface BtPrecheckResult {
  can_download: boolean;         // false = 无活跃做种者 / 取不到 metadata
  reason?: string;               // 'no_metadata' | 'already_managed' | ...
  info_hash?: string;
  name?: string;
  file_count?: number;
  total_bytes?: number;
  seen_peers?: number;
  message: string;               // 给用户的可读说明
}
