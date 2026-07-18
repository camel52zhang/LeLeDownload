import { Download, Sparkles } from 'lucide-react'

export function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400">
      <div className="relative mb-6">
        <div className="p-6 bg-gradient-to-br from-indigo-100 to-blue-100 rounded-full">
          <Download className="w-16 h-16 text-indigo-400" />
        </div>
        <div className="absolute -top-1 -right-1">
          <Sparkles className="w-6 h-6 text-yellow-400 animate-pulse" />
        </div>
      </div>
      <h3 className="text-xl font-semibold text-gray-700 mb-2">暂无下载任务</h3>
      <p className="text-sm text-gray-400">在上方输入链接开始下载，支持 HTTP/FTP/Magnet</p>
    </div>
  )
}
