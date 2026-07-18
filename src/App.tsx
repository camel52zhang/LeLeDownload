import { useState, useEffect, useRef, useMemo } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { X } from 'lucide-react'
import { Header, DownloadForm, DownloadItem, StatusBar, EmptyState, SettingsPanel } from './components'
import type { DownloadTask } from './types'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { checkForUpdate, downloadAndInstallUpdate, getUpdate } from './lib/updater'

function App() {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<'all' | 'downloading' | 'completed' | 'failed'>('all')
  const [downloadDir, setDownloadDir] = useState('')

  // 镜像最新任务列表，供事件回调在无闭包陷阱的情况下读取（避免把副作用写进 setState 更新函数）
  const tasksRef = useRef<DownloadTask[]>([])
  useEffect(() => { tasksRef.current = tasks }, [tasks])

  useEffect(() => {
    const saved = localStorage.getItem('download_dir')
    if (saved) setDownloadDir(saved)
    else invoke<string>('get_default_download_dir').then(dir => { setDownloadDir(dir); localStorage.setItem('download_dir', dir) }).catch(console.error)
  }, [])

  useEffect(() => {
    loadDownloads()
    const unlistenProgress = listen<{ id: string, downloaded_size: number, speed: number, progress: number, status: string }>('download-progress', (event) => {
      setTasks(prev => prev.map(task => task.id === event.payload.id ? { ...task, downloaded_size: event.payload.downloaded_size, speed: event.payload.speed, progress: event.payload.progress, status: event.payload.status as DownloadTask['status'] } : task))
    })
    const unlistenCompleted = listen<string>('download-completed', async (event) => {
      const id = event.payload
      const completedTask = tasksRef.current.find(t => t.id === id)
      setTasks(prev => prev.map(task => task.id === id ? { ...task, status: 'completed', progress: 100 } : task))
      if (!completedTask) return
      const settings = JSON.parse(localStorage.getItem('settings') || '{}')
      if (settings.autoOpenFolder) { try { const task = await invoke<DownloadTask>('get_download', { id }); if (task?.save_path) await invoke('open_folder', { filePath: task.save_path }) } catch (e) { console.error('自动打开文件夹失败:', e) } }
      if (settings.notifications) { try { let hasPermission = await isPermissionGranted(); if (!hasPermission) { const permission = await requestPermission(); hasPermission = permission === 'granted' }; if (hasPermission) sendNotification({ title: '下载完成', body: completedTask.filename }) } catch (e) { console.error('发送通知失败:', e) } }
    })
    const unlistenFailed = listen<[string, string]>('download-failed', (event) => { const [id, error] = event.payload; setTasks(prev => prev.map(task => task.id === id ? { ...task, status: 'failed', error } : task)) })
    // 任务被创建（来自 UI 添加 或 浏览器扩展下发）时刷新列表。
    // 修复(P1)：debounce 200ms，批量粘贴多个 URL 时合并为一次 reload，避免 N 次竞态 RPC。
    let createdTimer: ReturnType<typeof setTimeout> | null = null
    const unlistenCreated = listen('download-created', () => {
      if (createdTimer) clearTimeout(createdTimer)
      createdTimer = setTimeout(() => { loadDownloads() }, 200)
    })
    return () => { unlistenProgress.then(fn => fn()); unlistenCompleted.then(fn => fn()); unlistenFailed.then(fn => fn()); unlistenCreated.then(fn => fn()); if (createdTimer) clearTimeout(createdTimer) }
  }, [])

  // F12 打开 DevTools（走 Rust 后端避免 release build 受限）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F12') {
        e.preventDefault()
        invoke('open_devtools').catch(() => {
          // Fallback：release 若后端也没权限则尝试 JS API
          try { (window as any).__TAURI__?.window?.WebviewWindow?.getCurrent()?.openDevTools?.() } catch {}
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  async function loadDownloads() { try { const downloads = await invoke<DownloadTask[]>('get_downloads'); setTasks(downloads) } catch (err) { console.error('Failed to load downloads:', err) } }
  async function addDownload(url: string, saveDir?: string) { setIsAdding(true); try { const dir = saveDir || downloadDir || undefined; await invoke('create_download', { url, saveDir: dir }); loadDownloads() } catch (err) { console.error('Failed to create download:', err); alert('创建下载失败: ' + err) } finally { setIsAdding(false) } }
  function handleSaveSettings(settings: { downloadPath: string }) { const dir = settings.downloadPath; if (dir) { setDownloadDir(dir); localStorage.setItem('download_dir', dir) } }
  async function handlePause(task: DownloadTask) { try { await invoke('pause_download', { id: task.id }); setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'paused' } : t)) } catch (err) { console.error('Failed to pause:', err) } }
  async function handleResume(task: DownloadTask) { try { await invoke('resume_download', { id: task.id }); setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'downloading' } : t)) } catch (err) { console.error('Failed to resume:', err) } }
  async function handleCancel(task: DownloadTask) { try { await invoke('cancel_download', { id: task.id }); setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'failed', error: 'Cancelled by user' } : t)) } catch (err) { console.error('Failed to cancel:', err) } }
  async function handleRemove(task: DownloadTask) { try { await invoke('remove_download', { id: task.id }); setTasks(prev => prev.filter(t => t.id !== task.id)); setSelectedIds(prev => { const n = new Set(prev); n.delete(task.id); return n }) } catch (err) { console.error('Failed to remove:', err) } }
  async function handleClearCompleted() { try { await invoke('clear_completed'); loadDownloads() } catch (err) { console.error('Failed to clear:', err) } }
  async function handleCheckUpdate() {
    try {
      const r = await checkForUpdate()
      if (r.available) {
        if (confirm(`发现新版本 v${r.version}（当前 v${r.currentVersion}），是否立即下载并安装？\n\n${r.body || ''}`)) {
          const update = await getUpdate()
          if (update) { await downloadAndInstallUpdate(update) }
        }
      } else {
        alert(`当前已是最新版本（v${r.currentVersion}）`)
      }
    } catch (e) { alert('检查更新失败：' + e) }
  }

  const filteredTasks = useMemo(() => tasks.filter(task => { if (filterStatus !== 'all' && task.status !== filterStatus) return false; if (searchQuery) { const query = searchQuery.toLowerCase(); return task.filename.toLowerCase().includes(query) || task.url.toLowerCase().includes(query) }; return true }), [tasks, filterStatus, searchQuery])
  const sortedTasks = useMemo(() => [...filteredTasks].sort((a, b) => { if (a.status === 'downloading' && b.status !== 'downloading') return -1; if (b.status === 'downloading' && a.status !== 'downloading') return 1; return new Date(b.created_at).getTime() - new Date(a.created_at).getTime() }), [filteredTasks])
  const downloadingCount = tasks.filter(t => t.status === 'downloading').length
  const hasCompleted = tasks.some(t => t.status === 'completed')

  const handleSelectAll = () => { if (selectedIds.size === filteredTasks.length) setSelectedIds(new Set()); else setSelectedIds(new Set(filteredTasks.map(t => t.id))) }
  const handleToggleSelect = (id: string) => { const newSet = new Set(selectedIds); if (newSet.has(id)) newSet.delete(id); else newSet.add(id); setSelectedIds(newSet) }
  const handleBatchDelete = async () => { if (selectedIds.size === 0) return; if (!confirm('确定删除选中的 ' + selectedIds.size + ' 个任务吗？')) return; for (const id of selectedIds) { try { await invoke('remove_download', { id }) } catch (err) { console.error('删除失败:', err) } }; setSelectedIds(new Set()); loadDownloads() }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 flex flex-col">
      <Header onSettingsClick={() => setShowSettings(!showSettings)} onCheckUpdate={handleCheckUpdate} />
      <DownloadForm onAdd={addDownload} isLoading={isAdding} />
      <div className="bg-white/50 border-b border-white/20 px-6 py-1.5 flex items-center gap-4">
        <div className="flex items-center gap-2"><svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg><input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索文件名或链接..." className="bg-transparent border-none text-sm text-gray-600 placeholder-gray-400 focus:outline-none w-48" />{searchQuery && <button onClick={() => setSearchQuery('')} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>}</div>
        <div className="h-4 w-px bg-gray-200" />
        <div className="flex items-center gap-1">{(['all', 'downloading', 'completed', 'failed'] as const).map(status => (<button key={status} onClick={() => setFilterStatus(status)} className={'px-3 py-1 text-xs rounded-full transition-colors ' + (filterStatus === status ? 'bg-indigo-100 text-indigo-600' : 'text-gray-500 hover:bg-gray-100')}>{status === 'all' ? '全部' : status === 'downloading' ? '下载中' : status === 'completed' ? '已完成' : '失败'}</button>))}</div>
        <div className="ml-auto text-xs text-gray-400">{sortedTasks.length} 个任务{searchQuery || filterStatus !== 'all' ? ' (筛选)' : ''}</div>
      </div>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        {filterStatus === 'completed' && filteredTasks.length > 0 && (<div className="flex items-center gap-3 mb-3"><input type="checkbox" checked={selectedIds.size === filteredTasks.length && filteredTasks.length > 0} onChange={handleSelectAll} className="w-4 h-4 rounded border-gray-300 text-indigo-600" /><span className="text-sm text-gray-500">全选 ({selectedIds.size}/{filteredTasks.length})</span>{selectedIds.size > 0 && (<button onClick={handleBatchDelete} className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg">删除选中</button>)}</div>)}
        {sortedTasks.length === 0 ? <EmptyState /> : <div className="w-full space-y-2">{sortedTasks.map(task => (<div key={task.id} className="flex items-center gap-2">{task.status === 'completed' && <input type="checkbox" checked={selectedIds.has(task.id)} onChange={() => handleToggleSelect(task.id)} className="w-4 h-4 rounded border-gray-300 text-indigo-600 flex-shrink-0" />}<div className="flex-1 min-w-0"><DownloadItem task={task} onPause={handlePause} onResume={handleResume} onCancel={handleCancel} onRemove={handleRemove} /></div></div>))}</div>}
      </main>
      <StatusBar totalTasks={tasks.length} downloadingCount={downloadingCount} onClearCompleted={handleClearCompleted} hasCompleted={hasCompleted} />
      <SettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} onSave={handleSaveSettings} />
    </div>
  )
}
export default App
