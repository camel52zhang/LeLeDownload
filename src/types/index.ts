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
