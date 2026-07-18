import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, Loader2, Upload, X } from 'lucide-react'

interface DownloadFormProps {
  onAdd: (url: string, saveDir?: string) => Promise<void>
  isLoading: boolean
}

export function DownloadForm({ onAdd, isLoading }: DownloadFormProps) {
  const [url, setUrl] = useState('')
  const [urls, setUrls] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showBatch, setShowBatch] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 处理剪贴板粘贴 - 支持多个URL
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') || ''
    if (!text.trim()) return
    
    const lines = text.split(/[\n\r]+/).filter(line => line.trim())
    if (lines.length > 1) {
      e.preventDefault()
      const validUrls = lines.filter(line => {
        const trimmed = line.trim()
        return trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ftp://')
      })
      if (validUrls.length > 0) {
        setUrls(validUrls)
        setShowBatch(true)
      }
    }
  }, [])

  // 监听全局粘贴事件
  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  // 拖拽事件处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    
    const text = e.dataTransfer.getData('text') || ''
    if (text) {
      const lines = text.split(/[\n\r]+/).filter(line => line.trim())
      const validUrls = lines.filter(line => {
        const trimmed = line.trim()
        return trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ftp://')
      })
      if (validUrls.length > 0) {
        setUrls(validUrls)
        setShowBatch(true)
      }
    }
  }

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!url.trim()) return
    await onAdd(url.trim())
    setUrl('')
  }

  const handleBatchAdd = async () => {
    for (const u of urls) {
      try {
        await onAdd(u.trim())
      } catch (err) {
        console.error('Failed to add:', u, err)
      }
    }
    setUrls([])
    setShowBatch(false)
    setUrl('')
  }

  const handleRemoveUrl = (idx: number) => {
    setUrls(urls.filter((_, i) => i !== idx))
  }

  // 显示批量导入弹窗
  if (showBatch && urls.length > 0) {
    return (
      <div className="bg-white/80 backdrop-blur-sm border-b border-white/20 px-6 py-4">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-amber-800">
              <Upload className="w-5 h-5" />
              <span className="font-medium">批量导入 ({urls.length} 个链接)</span>
            </div>
            <button
              onClick={() => { setShowBatch(false); setUrls([]) }}
              className="p-1 hover:bg-amber-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-amber-600" />
            </button>
          </div>
          
          <div className="max-h-48 overflow-y-auto space-y-1 mb-3">
            {urls.map((u, idx) => (
              <div key={idx} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 text-sm">
                <span className="flex-1 truncate text-gray-700">{u}</span>
                <button
                  onClick={() => handleRemoveUrl(idx)}
                  className="p-1 hover:bg-red-50 rounded text-red-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={handleBatchAdd}
            disabled={isLoading || urls.length === 0}
            className="px-6 py-2 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
          >
            全部添加
          </button>
        </div>
      </div>
    )
  }

  return (
    <div 
      className={`bg-white/80 backdrop-blur-sm border-b border-white/20 px-6 py-3 transition-all duration-300 ${isDragging ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-200' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-400 to-indigo-500 animate-pulse" />
      )}
      <form onSubmit={handleSubmit} className="flex gap-3 items-center">
        <div className="flex-1 relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="输入下载链接，支持 HTTP/FTP/Magnet... (Ctrl+V 粘贴)"
            className="w-full pl-12 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all duration-200 text-gray-700 placeholder-gray-400"
            disabled={isLoading}
          />
        </div>
        
        <button
          type="submit"
          disabled={isLoading || !url.trim()}
          className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-blue-500 text-white rounded-xl font-medium hover:from-indigo-700 hover:to-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="hidden sm:inline">添加中</span>
            </>
          ) : (
            <>
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">添加下载</span>
            </>
          )}
        </button>
      </form>

      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-500/10 rounded-2xl pointer-events-none">
          <div className="bg-white rounded-2xl px-8 py-6 shadow-2xl flex items-center gap-4">
            <Upload className="w-10 h-10 text-blue-500 animate-bounce" />
            <span className="text-lg font-medium text-blue-700">释放添加下载链接</span>
          </div>
        </div>
      )}
    </div>
  )
}
