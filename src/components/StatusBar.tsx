interface StatusBarProps {
  totalTasks: number
  downloadingCount: number
  onClearCompleted: () => void
  hasCompleted: boolean
}

export function StatusBar({ totalTasks, downloadingCount, onClearCompleted, hasCompleted }: StatusBarProps) {
  return (
    <footer className="bg-white/80 backdrop-blur-sm border-t border-gray-200 px-6 py-2 flex items-center justify-between">
      <div className="text-sm text-gray-500">
        <span className="font-medium text-gray-700">{totalTasks}</span> 个任务
        {downloadingCount > 0 && (
          <span className="ml-3 text-blue-600 font-medium flex items-center gap-1 inline-flex">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            {downloadingCount} 正在下载
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {hasCompleted && (
          <button
            onClick={onClearCompleted}
            className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors font-medium"
          >
            清除已完成
          </button>
        )}
      </div>
    </footer>
  )
}
