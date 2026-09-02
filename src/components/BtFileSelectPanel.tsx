// 磁力 / 种子文件清单选择面板（模态）。
//
// 用户粘贴 magnet/.torrent 后强制先弹本面板：展示种子内**全部**文件，勾选后只下载勾选项，
// 从源头拦掉广告/.nfo/.url 等垃圾文件。
//
// 索引契约：行数据里的 `index` 由后端 iter_file_details().enumerate() 产生，
// 本组件只做「过滤显示」和「收集勾选」，**绝不重排或重新编号**，确认时原样回传。
import { useMemo, useState } from 'react'
import { X, Search } from 'lucide-react'
import type { BtFileEntry, BtFileList } from '../types'
import { formatBytes } from '../lib/format'

const MB = 1024 * 1024

// 「隐藏小于 N MB」的档位（0 = 不隐藏）
export const SIZE_FILTER_OPTIONS = [0, 1, 10, 100] as const

/** 按文件名子串 + 最小体积过滤（纯函数，供单测）。query 大小写不敏感。 */
export function filterFiles(files: BtFileEntry[], query: string, minBytes: number): BtFileEntry[] {
  const q = query.trim().toLowerCase()
  return files.filter(f => f.length >= minBytes && (q === '' || f.name.toLowerCase().includes(q)))
}

/** 勾选集合的总字节数（纯函数，供单测）。 */
export function selectedBytes(files: BtFileEntry[], selected: Set<number>): number {
  return files.reduce((sum, f) => (selected.has(f.index) ? sum + f.length : sum), 0)
}

/** 勾选集合 → 回传给 Rust 的 only_files 数组（升序，纯函数，供单测）。 */
export function toOnlyFiles(selected: Set<number>): number[] {
  return Array.from(selected).sort((a, b) => a - b)
}

/** 确认按钮是否禁用：未勾选任何文件时禁用（纯函数，供单测验证空选禁用逻辑）。 */
export function isConfirmDisabled(selected: Set<number>): boolean {
  return selected.size === 0
}

interface Props {
  list: BtFileList
  onConfirm: (onlyFiles: number[]) => void
  onCancel: () => void
}

export function BtFileSelectPanel({ list, onConfirm, onCancel }: Props) {
  // 默认全选：保持「不主动帮用户做取舍」，由用户取消掉不想要的
  const [selected, setSelected] = useState<Set<number>>(() => new Set(list.files.map(f => f.index)))
  const [query, setQuery] = useState('')
  const [minMb, setMinMb] = useState(0)

  const visible = useMemo(() => filterFiles(list.files, query, minMb * MB), [list.files, query, minMb])
  const pickedBytes = useMemo(() => selectedBytes(list.files, selected), [list.files, selected])
  const hiddenPicked = selected.size - visible.filter(f => selected.has(f.index)).length

  const toggle = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  // 全选 / 反选 只作用于**当前可见**的文件（过滤后所见即所得）
  const selectAllVisible = () => setSelected(prev => { const n = new Set(prev); visible.forEach(f => n.add(f.index)); return n })
  const invertVisible = () => setSelected(prev => { const n = new Set(prev); visible.forEach(f => n.has(f.index) ? n.delete(f.index) : n.add(f.index)); return n })
  const clearAll = () => setSelected(new Set())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-xl border border-white/40">
        {/* 头部：来源信息 */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate" title={list.name}>{list.name}</div>
            <div className="mt-1 text-xs text-gray-400">
              共 {list.file_count} 个文件 · {formatBytes(list.total_bytes)} · DHT 发现 {list.seen_peers} 个 peer
            </div>
          </div>
          <button onClick={onCancel} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg" title="取消">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 工具条：搜索 / 批量勾选 / 隐藏小文件 */}
        <div className="px-5 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 flex-1 px-3 py-1.5 border border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-indigo-200">
              <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索文件名（如 .mp4 / 关键字）"
                className="flex-1 min-w-0 bg-transparent border-none text-sm text-gray-600 placeholder-gray-400 focus:outline-none"
              />
              {query && <button onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-xs text-gray-400">隐藏小于</span>
              {SIZE_FILTER_OPTIONS.map(n => (
                <button
                  key={n}
                  onClick={() => setMinMb(n)}
                  className={'px-2 py-1 text-xs rounded-full transition-colors ' + (minMb === n ? 'bg-indigo-100 text-indigo-600' : 'text-gray-500 hover:bg-gray-100')}
                >
                  {n === 0 ? '不限' : n + 'MB'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={selectAllVisible} className="px-2.5 py-1 text-gray-600 hover:bg-gray-100 rounded-lg">全选</button>
            <button onClick={invertVisible} className="px-2.5 py-1 text-gray-600 hover:bg-gray-100 rounded-lg">反选</button>
            <button onClick={clearAll} className="px-2.5 py-1 text-gray-600 hover:bg-gray-100 rounded-lg">清空</button>
            <span className="text-gray-300">|</span>
            <span className="text-gray-500">显示 {visible.length}/{list.file_count}</span>
            <span className="ml-auto text-gray-600">
              已选 <span className="text-indigo-600 font-medium">{selected.size}</span> 个 · {formatBytes(pickedBytes)}
              {hiddenPicked > 0 && <span className="text-gray-400">（含 {hiddenPicked} 个已隐藏）</span>}
            </span>
          </div>
        </div>

        {/* 文件列表（可滚动） */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {visible.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-8">没有匹配的文件，试试放宽搜索或体积过滤</div>
          ) : (
            <div className="space-y-1">
              {visible.map(f => (
                <label
                  key={f.index}
                  className="flex items-center gap-3 px-3 py-2 rounded-xl border border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.index)}
                    onChange={() => toggle(f.index)}
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600 flex-shrink-0"
                  />
                  <span className="flex-1 min-w-0 text-sm text-gray-700 truncate" title={f.components.join('/')}>
                    {f.components.join('/')}
                  </span>
                  <span className="text-xs text-gray-400 flex-shrink-0">{formatBytes(f.length)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-3 px-5 py-4 border-t border-gray-100">
          <div className="text-xs text-gray-400 flex-1">只有勾选的文件会被下载，未勾选的不会占用磁盘和带宽</div>
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">取消</button>
          <button
            onClick={() => onConfirm(toOnlyFiles(selected))}
            disabled={isConfirmDisabled(selected)}
            title={selected.size === 0 ? '请至少勾选一个文件' : ''}
            className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            下载选中 {selected.size} 个文件
          </button>
        </div>
      </div>
    </div>
  )
}

export default BtFileSelectPanel
