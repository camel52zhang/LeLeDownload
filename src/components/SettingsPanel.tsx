import { useState, useEffect } from 'react'
import { X, Download, Wifi, FolderOpen, Bell, Info } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  onSave?: (settings: { downloadPath: string }) => void
}

interface Settings {
  maxThreads: number
  maxConcurrent: number
  speedLimit: number
  enableSpeedLimit: boolean
  autoStart: boolean
  autoOpenFile: boolean
  autoOpenFolder: boolean
  notifications: boolean
  downloadPath: string
}

export function SettingsPanel({ isOpen, onClose, onSave }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>({
    maxThreads: 16,
    maxConcurrent: 3,
    speedLimit: 0,
    enableSpeedLimit: false,
    autoStart: true,
    autoOpenFile: false,
    autoOpenFolder: true,
    notifications: true,
    downloadPath: '',
  })
  const [activeTab, setActiveTab] = useState('general')
  const [isSelectingDir, setIsSelectingDir] = useState(false)

  // 打开时从 localStorage 回读此前保存的完整配置（含线程数/限速等），避免重开后被默认值覆盖
  useEffect(() => {
    if (!isOpen) return;
    const savedDir = localStorage.getItem('download_dir');
    const savedSettings = localStorage.getItem('settings');
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings) as Partial<Settings>;
        setSettings(prev => ({
          ...prev,
          ...parsed,
          downloadPath: parsed.downloadPath || savedDir || prev.downloadPath,
        }));
        return;
      } catch {
        // 解析失败则回退到仅回读目录
      }
    }
    if (savedDir) {
      setSettings(prev => ({ ...prev, downloadPath: savedDir }));
    } else {
      loadDefaultDir();
    }
  }, [isOpen])

  async function loadDefaultDir() {
    try {
      const defaultDir = await invoke<string>('get_default_download_dir')
      if (defaultDir && !settings.downloadPath) {
        setSettings(prev => ({ ...prev, downloadPath: defaultDir }))
      }
    } catch (e) {
      console.error('获取默认目录失败:', e)
    }
  }

  const handleSelectFolder = async () => {
    setIsSelectingDir(true)
    try {
      const selected = await invoke<string>('select_download_dir')
      if (selected && selected.trim()) {
        setSettings(prev => ({ ...prev, downloadPath: selected.trim() }))
      }
    } catch (e) {
      console.error('选择目录失败:', e)
    } finally {
      setIsSelectingDir(false)
    }
  }

  if (!isOpen) return null

  const handleSave = async () => {
    // 本地持久化（UI 开关：下载目录/自动打开/通知等由前端读取）
    localStorage.setItem('download_dir', settings.downloadPath)
    localStorage.setItem('settings', JSON.stringify(settings))

    // 同步到后端：线程数 / 并发数 / 限速 真正生效
    try {
      await invoke('update_download_settings', {
        settings: {
          maxThreads: settings.maxThreads,
          maxConcurrent: settings.maxConcurrent,
          downloadDir: settings.downloadPath,
          autoStart: settings.autoStart,
          autoOpenFile: settings.autoOpenFile,
          autoOpenFolder: settings.autoOpenFolder,
          notifications: settings.notifications,
          speedLimitKb: settings.enableSpeedLimit ? settings.speedLimit : 0,
        },
      })
    } catch (e) {
      console.error('保存设置到后端失败:', e)
    }

    // 通知父组件
    if (onSave) {
      onSave({ downloadPath: settings.downloadPath })
    }

    console.log('保存设置:', settings)
    onClose()
  }

  const tabs = [
    { id: 'general', label: '常规', icon: Info },
    { id: 'download', label: '下载', icon: Download },
    { id: 'speed', label: '速度', icon: Wifi },
    { id: 'notifications', label: '通知', icon: Bell },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">设置</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="flex border-b border-gray-100 px-4">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-gray-900">下载目录</h3>
                  <p className="text-sm text-gray-500">默认保存下载文件的位置: {settings.downloadPath || '未设置'}</p>
                </div>
                <div className="flex items-center gap-2 w-72">
                  <input type="text" value={settings.downloadPath}
                    onChange={(e) => setSettings({...settings, downloadPath: e.target.value})}
                    placeholder="点击右侧按钮选择..."
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                  />
                  <button 
                    onClick={handleSelectFolder}
                    disabled={isSelectingDir}
                    className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-lg transition-colors"
                    title="点击选择目录"
                  >
                    {isSelectingDir ? '...' : <FolderOpen className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <SettingItem title="下载前询问保存位置" description="每次下载时都弹出保存对话框">
                <Toggle checked={!settings.autoStart} onChange={(c) => setSettings({...settings, autoStart: !c})} />
              </SettingItem>

              <SettingItem title="下载完成后打开文件" description="下载完成后自动打开下载的文件">
                <Toggle checked={settings.autoOpenFile} onChange={(c) => setSettings({...settings, autoOpenFile: c})} />
              </SettingItem>

              <SettingItem title="下载完成后打开文件夹" description="下载完成后自动打开所在文件夹">
                <Toggle checked={settings.autoOpenFolder} onChange={(c) => setSettings({...settings, autoOpenFolder: c})} />
              </SettingItem>

              <div className="pt-4 border-t border-gray-100">
                <h3 className="font-medium text-gray-900">浏览器扩展</h3>
                <p className="text-sm text-gray-500 mt-1">把下载接管能力集成到 Chrome/Edge。安装步骤：</p>
                <ol className="text-xs text-gray-500 mt-2 space-y-1 list-decimal list-inside">
                  <li>在 Chrome/Edge 地址栏输入 <code className="bg-gray-100 px-1 rounded">chrome://extensions</code>（Edge 用 <code className="bg-gray-100 px-1 rounded">edge://extensions</code>）</li>
                  <li>打开右上角「开发者模式」开关</li>
                  <li>点击「加载已解压的扩展程序」，选择下方按钮打开的 <code className="bg-gray-100 px-1 rounded">extension</code> 文件夹</li>
                </ol>
                <button onClick={() => invoke('open_extension_folder').catch(console.error)} className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg flex items-center gap-2">
                  <FolderOpen className="w-4 h-4" /> 打开扩展文件夹
                </button>
              </div>
            </div>
          )}

          {activeTab === 'download' && (
            <div className="space-y-6">
              <SettingItem title="同时下载任务数" description="最大同时进行的下载任务数量">
                <select value={settings.maxConcurrent} onChange={(e) => setSettings({...settings, maxConcurrent: parseInt(e.target.value)})} className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
                  {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n} 个任务</option>)}
                </select>
              </SettingItem>
              <SettingItem title="每个任务的线程数" description="每个下载任务使用的连接线程数">
                <select value={settings.maxThreads} onChange={(e) => setSettings({...settings, maxThreads: parseInt(e.target.value)})} className="px-3 py-2 border border-gray-200 rounded-lg text-sm">
                  {[1,2,4,6,8,10,12,16,32].map(n => <option key={n} value={n}>{n} 线程</option>)}
                </select>
              </SettingItem>
            </div>
          )}

          {activeTab === 'speed' && (
            <div className="space-y-6">
              <SettingItem title="启用速度限制" description="限制下载速度以节省带宽">
                <Toggle checked={settings.enableSpeedLimit} onChange={(c) => setSettings({...settings, enableSpeedLimit: c})} />
              </SettingItem>
              <SettingItem title="最大下载速度" description="设置最大下载速度（KB/s）" disabled={!settings.enableSpeedLimit}>
                <input type="number" min="1" max="100000" value={settings.speedLimit}
                  onChange={(e) => setSettings({...settings, speedLimit: parseInt(e.target.value)||0})}
                  disabled={!settings.enableSpeedLimit}
                  className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-50" />
              </SettingItem>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-6">
              <SettingItem title="下载完成通知" description="下载完成后发送系统通知">
                <Toggle checked={settings.notifications} onChange={(c) => setSettings({...settings, notifications: c})} />
              </SettingItem>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50">
          <button onClick={onClose} className="px-5 py-2.5 text-gray-600 hover:bg-gray-100 rounded-xl font-medium">取消</button>
          <button onClick={handleSave} className="px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-blue-500 text-white rounded-xl font-medium">保存设置</button>
        </div>
      </div>
    </div>
  )
}

function SettingItem({ title, description, children, disabled }: { title: string; description: string; children: React.ReactNode; disabled?: boolean }) {
  return <div className={`flex items-center justify-between ${disabled ? 'opacity-50' : ''}`}><div><h3 className="font-medium text-gray-900">{title}</h3><p className="text-sm text-gray-500">{description}</p></div>{children}</div>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (c: boolean) => void }) {
  return <button type="button" onClick={() => onChange(!checked)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} /></button>
}

