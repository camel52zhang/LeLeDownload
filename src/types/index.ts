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
