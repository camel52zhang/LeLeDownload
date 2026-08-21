import { useState, useEffect, useRef, useMemo } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { X, Play, Pause, Trash2 } from 'lucide-react'
import { Header, DownloadForm, DownloadItem, StatusBar, EmptyState, SettingsPanel, NetdiskPanel } from './components'
import type { DownloadTask, BtTask, BtPrecheckResult } from './types'
import { formatBytes, formatSpeed } from './lib/format'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { checkForUpdate, downloadAndInstallUpdate, getUpdate } from './lib/updater'

function App() {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [btTasks, setBtTasks] = useState<BtTask[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<'all' | 'downloading' | 'completed' | 'failed'>('all')
  const [downloadDir, setDownloadDir] = useState('')
  const [activeTab, setActiveTab] = useState<'downloads' | 'netdisk'>('downloads')

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
      // 任务转为「已完成」时补上完成时间：优先保留后端下发的 completed_at（重载场景），
      // 否则用当前时刻（RFC3339，与后端格式一致）兜底，保证本次会话内完成项也能显示时间。
      setTasks(prev => prev.map(task => task.id === id ? { ...task, status: 'completed', progress: 100, completed_at: task.completed_at || new Date().toISOString() } : task))
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
  async function loadBtTasks() { try { const bt = await invoke<BtTask[]>('bt_list_tasks'); setBtTasks(bt) } catch (err) { console.error('Failed to load BT tasks:', err) } }

  // BT 任务轮询（有 BT 任务时每 2s 刷新进度/速度）
  useEffect(() => {
    if (btTasks.length === 0) return
    const timer = setInterval(loadBtTasks, 2000)
    return () => clearInterval(timer)
  }, [btTasks.length > 0])

  const isBtSource = (url: string) => url.trim().startsWith('magnet:') || /\.torrent($|\?)/i.test(url.trim())
  // invoke 包超时：librqbit 启动 DHT/UTP listener 偶尔阻塞，前端 30s 后强制断 Promise 让 finally 执行重置按钮
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}超时（${ms / 1000}s）。librqbit 启动监听端口/DHT 阻塞，可能是防火墙拦截或网络受限。请检查后重试`)), ms)),
    ])
  }

  async function addDownload(url: string, saveDir?: string) {
    setIsAdding(true)
    try {
      const dir = saveDir || downloadDir || undefined
      if (isBtSource(url)) {
        // 磁力 / torrent → BT 会话（后端 15s+60s 双重超时；前端 70s 兜底保险）
        // 先快速预检：判断资源是否有活跃做种者（list_only 真实取 metadata，不下载）。
        // 首次运行时预检会顺带初始化 BT 会话（≤15s），故前端超时放宽到 45s。
        const pre = await withTimeout(
          invoke<BtPrecheckResult>('bt_precheck', { source: url.trim() }),
          45000,
          'BT 资源预检',
        )
        // 资源当前无活跃做种者：明确告知，让用户决定是否仍要尝试添加（避免误以为软件坏了）
        if (pre && pre.can_download === false) {
          const ok = window.confirm(pre.message + '\n\n仍要尝试添加吗？')
          if (!ok) {
            setIsAdding(false)
            return
          }
        }
        await withTimeout(invoke('bt_add_torrent', { source: url.trim(), saveDir: dir }), 70000, '添加 BT 任务')
        await loadBtTasks()
      } else {
        await invoke('create_download', { url, saveDir: dir })
        loadDownloads()
      }
    } catch (err) {
      console.error('Failed to create download:', err)
      // Tauri v2 invoke reject.value 直接是后端 Result 的 Err 值（我们用 String）。
      // 当作 Error 取 .message 会得到 undefined（→ alert 显示 "undefined"）。
      // 兼容 string | Error | unknown。
      const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : String(err))
      // 先恢复按钮，避免 alert 阻塞期间仍显示"添加中"的卡顿错觉
      setIsAdding(false)
      setTimeout(() => alert('创建下载失败: ' + msg), 0)
    } finally { setIsAdding(false) }
  }
  async function handleBtPause(id: string) { try { await invoke('bt_pause', { id }); loadBtTasks() } catch (err) { console.error('Failed to pause BT:', err) } }
  async function handleBtResume(id: string) { try { await invoke('bt_resume', { id }); loadBtTasks() } catch (err) { console.error('Failed to resume BT:', err) } }
  async function handleBtRemove(id: string) { try { await invoke('bt_remove', { id }); loadBtTasks() } catch (err) { console.error('Failed to remove BT:', err) } }
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
      <div className="px-6 pt-2 flex items-center gap-2">
        <button onClick={() => setActiveTab('downloads')} className={'px-4 py-1.5 text-sm rounded-full transition-colors ' + (activeTab === 'downloads' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100')}>下载列表</button>
        <button onClick={() => setActiveTab('netdisk')} className={'px-4 py-1.5 text-sm rounded-full transition-colors ' + (activeTab === 'netdisk' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100')}>网盘解析</button>
      </div>
      {activeTab === 'downloads' && (<>
      <DownloadForm onAdd={addDownload} isLoading={isAdding} />
      <div className="bg-white/50 border-b border-white/20 px-6 py-1.5 flex items-center gap-4">
        <div className="flex items-center gap-2"><svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg><input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索文件名或链接..." className="bg-transparent border-none text-sm text-gray-600 placeholder-gray-400 focus:outline-none w-48" />{searchQuery && <button onClick={() => setSearchQuery('')} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>}</div>
        <div className="h-4 w-px bg-gray-200" />
        <div className="flex items-center gap-1">{(['all', 'downloading', 'completed', 'failed'] as const).map(status => (<button key={status} onClick={() => setFilterStatus(status)} className={'px-3 py-1 text-xs rounded-full transition-colors ' + (filterStatus === status ? 'bg-indigo-100 text-indigo-600' : 'text-gray-500 hover:bg-gray-100')}>{status === 'all' ? '全部' : status === 'downloading' ? '下载中' : status === 'completed' ? '已完成' : '失败'}</button>))}</div>
        <div className="ml-auto text-xs text-gray-400">{sortedTasks.length} 个任务{searchQuery || filterStatus !== 'all' ? ' (筛选)' : ''}</div>
      </div>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        {btTasks.length > 0 && (<div className="mb-4">
          <div className="flex items-center gap-2 mb-2"><span className="text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded">BT 任务</span><span className="text-xs text-gray-400">{btTasks.length} 个（磁力/种子）</span></div>
          <div className="w-full space-y-2">
            {btTasks.map(t => (<div key={t.id} className="bg-white rounded-xl border border-gray-100 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800 truncate" title={t.name}>{t.name}</div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                    <span className={t.state === 'downloading' ? 'text-blue-600' : t.state === 'completed' ? 'text-green-600' : t.state === 'error' ? 'text-red-600' : t.state === 'fetching_metadata' ? 'text-indigo-600 animate-pulse' : 'text-yellow-600'}>
                      {t.state === 'downloading' ? '下载中' : t.state === 'paused' ? '已暂停' : t.state === 'completed' ? '已完成' : t.state === 'fetching_metadata' ? '获取元数据中…' : '异常'}
                    </span>
                    <span>{t.progress.toFixed(1)}%</span>
                    <span>{formatBytes(t.downloaded_bytes)} / {formatBytes(t.total_bytes)}</span>
                    {(t.state === 'downloading' || t.state === 'fetching_metadata') && <span>↓ {formatSpeed(t.download_rate)} ↑ {formatSpeed(t.upload_rate)}</span>}
                  </div>
                  <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: Math.min(100, t.progress) + '%' }} /></div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {t.state === 'downloading' && <button onClick={() => handleBtPause(t.id)} className="p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 rounded-lg" title="暂停"><Pause className="w-4 h-4" /></button>}
                  {t.state === 'paused' && <button onClick={() => handleBtResume(t.id)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg" title="恢复"><Play className="w-4 h-4" /></button>}
                  <button onClick={() => handleBtRemove(t.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="删除"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>))}
          </div>
        </div>)}
        {filterStatus === 'completed' && filteredTasks.length > 0 && (<div className="flex items-center gap-3 mb-3"><input type="checkbox" checked={selectedIds.size === filteredTasks.length && filteredTasks.length > 0} onChange={handleSelectAll} className="w-4 h-4 rounded border-gray-300 text-indigo-600" /><span className="text-sm text-gray-500">全选 ({selectedIds.size}/{filteredTasks.length})</span>{selectedIds.size > 0 && (<button onClick={handleBatchDelete} className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-lg">删除选中</button>)}</div>)}
        {sortedTasks.length === 0 && btTasks.length === 0 ? <EmptyState /> : <div className="w-full space-y-2">{sortedTasks.map(task => (<div key={task.id} className="flex items-center gap-2">{task.status === 'completed' && <input type="checkbox" checked={selectedIds.has(task.id)} onChange={() => handleToggleSelect(task.id)} className="w-4 h-4 rounded border-gray-300 text-indigo-600 flex-shrink-0" />}<div className="flex-1 min-w-0"><DownloadItem task={task} onPause={handlePause} onResume={handleResume} onCancel={handleCancel} onRemove={handleRemove} /></div></div>))}</div>}
      </main>
      <StatusBar totalTasks={tasks.length} downloadingCount={downloadingCount} onClearCompleted={handleClearCompleted} hasCompleted={hasCompleted} />
      </>)}
      {activeTab === 'netdisk' && <NetdiskPanel />}
      <SettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} onSave={handleSaveSettings} />
    </div>
  )
}
export default App
