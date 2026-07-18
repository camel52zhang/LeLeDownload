import { Play, Pause, X, Trash2, CheckCircle, AlertCircle, Clock, Zap, Copy, FolderOpen } from 'lucide-react'
import { formatBytes, formatSpeed } from '../lib/format'
import { invoke } from '@tauri-apps/api/core'
import type { DownloadTask } from '../types'

interface DownloadItemProps {
  task: DownloadTask
  onPause: (task: DownloadTask) => void
  onResume: (task: DownloadTask) => void
  onCancel: (task: DownloadTask) => void
  onRemove: (task: DownloadTask) => void
}

const statusConfig = {
  pending: { icon: Clock, label: '等待中', color: 'text-gray-500', bg: 'bg-gray-100' },
  downloading: { icon: Zap, label: '下载中', color: 'text-blue-600', bg: 'bg-blue-100' },
  paused: { icon: Pause, label: '已暂停', color: 'text-yellow-600', bg: 'bg-yellow-100' },
  completed: { icon: CheckCircle, label: '已完成', color: 'text-green-600', bg: 'bg-green-100' },
  failed: { icon: AlertCircle, label: '失败', color: 'text-red-600', bg: 'bg-red-100' },
}

export function DownloadItem({ task, onPause, onResume, onCancel, onRemove }: DownloadItemProps) {
  const status = statusConfig[task.status] || statusConfig.pending
  const StatusIcon = status.icon
  // 下载中/暂停态展示进度条；完成/失败/等待态压成单行，最大化列表密度
  const showProgress = task.status === 'downloading' || task.status === 'paused'

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(task.url)
  }

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (task.save_path && task.save_path.trim()) {
      try {
        await invoke('open_folder', { filePath: task.save_path })
      } catch (err) {
        console.error('开目录失败:', err)
      }
    }
  }

  const getActions = () => {
    switch (task.status) {
      case 'downloading':
        return [
          { icon: Pause, action: () => onPause(task), class: 'hover:bg-yellow-100 text-yellow-600', title: '暂停' },
          { icon: X, action: () => onCancel(task), class: 'hover:bg-red-100 text-red-600', title: '取消' },
        ]
      case 'paused':
        return [
          { icon: Play, action: () => onResume(task), class: 'hover:bg-green-100 text-green-600', title: '继续' },
          { icon: X, action: () => onCancel(task), class: 'hover:bg-red-100 text-red-600', title: '取消' },
        ]
      case 'completed':
        return [
          { icon: FolderOpen, action: handleOpenFolder, class: 'hover:bg-green-100 text-green-600', title: '开目录' },
          { icon: Copy, action: handleCopyUrl, class: 'hover:bg-blue-100 text-blue-600', title: '复制链接' },
          { icon: Trash2, action: () => onRemove(task), class: 'hover:bg-red-100 text-red-600', title: '删除' },
        ]
      case 'failed':
        return [
          { icon: Play, action: () => onResume(task), class: 'hover:bg-green-100 text-green-600', title: '重试' },
          { icon: Trash2, action: () => onRemove(task), class: 'hover:bg-red-100 text-red-600', title: '删除' },
        ]
      default:
        return []
    }
  }

  return (
    <div className="group bg-white rounded-xl px-3.5 py-2.5 border border-gray-100 hover:border-gray-200 hover:shadow-sm transition-all duration-200 min-w-0">
      <div className="flex items-center gap-2.5 min-w-0">
        {/* 状态图标（紧凑） */}
        <div className={`p-1.5 rounded-lg flex-shrink-0 ${status.bg}`}>
          <StatusIcon className={`w-4 h-4 ${status.color} ${task.status === 'downloading' ? 'animate-pulse' : ''}`} />
        </div>

        {/* 中间内容：文件名行 + (下载中/暂停)进度条行 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-medium text-sm text-gray-800 truncate min-w-0">{task.filename || '未知文件'}</h3>
            {task.status === 'downloading' && (
              <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">{formatBytes(task.downloaded_size)} / {formatBytes(task.total_size)}</span>
            )}
            {task.status === 'completed' && (
              <span className="text-xs text-green-600 flex-shrink-0 whitespace-nowrap">{formatBytes(task.total_size)}</span>
            )}
            {task.status === 'failed' && task.error && (
              <span className="text-xs text-red-500 flex-shrink-0 truncate" title={task.error}>{task.error}</span>
            )}
          </div>

          {showProgress && (
            <div className="flex items-center gap-2 mt-1.5">
              <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ease-out ${task.status === 'paused' ? 'bg-gray-400' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
                  style={{ width: `${Math.min(task.progress, 100)}%` }}
                />
              </div>
              <span className="text-xs font-medium text-blue-600 flex-shrink-0 w-8 text-right">{task.progress.toFixed(0)}%</span>
              {task.status === 'downloading' && (
                <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">{formatSpeed(task.speed)}</span>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮：icon-only，hover 整项时更明显 */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {getActions().map((action, idx) => (
            <button
              key={idx}
              onClick={action.action}
              className={`p-1.5 rounded-lg transition-colors ${action.class}`}
              title={action.title}
            >
              <action.icon className="w-4 h-4" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
