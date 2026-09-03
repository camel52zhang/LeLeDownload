import { useState, useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

interface NetdiskFile {
  name: string
  size: string
  url: string
  headers?: Record<string, string>
}

interface ResolveResult {
  id: string
  ok: boolean
  files?: NetdiskFile[]
  error?: string
  url?: string
  // 部分文件解析成功、部分失败时由扩展回传的提示（如 WeTransfer 个别文件取直链失败）。
  // 与 error 互斥：warning 出现时解析整体成功，仅个别文件缺失。
  warning?: string
}

// 平台识别规则必须与 extension/background.js 的 detectNetdiskPlatform 保持一致，
// 否则会出现「面板显示识别到 A 平台、扩展却按 B 平台解析」的错位。
// 注意 123 云盘只能匹配其具体马甲域名，不能宽松匹配 '123'（否则 pan.baidu123.com 这类会误判）。
//
// 返回值刻意区分 key 与 label：
//   key   —— 传给扩展做解析器路由的英文标识，必须与扩展侧枚举一字不差；
//   label —— 仅用于界面展示的中文名。
// 早期版本把中文名直接当作 platform 传下去，导致扩展的兜底分支永远匹配不上。
const PLATFORMS: { key: string; label: string; match: (h: string) => boolean }[] = [
  { key: 'baidu', label: '百度网盘', match: (h) => h.includes('baidu') },
  { key: 'aliyun', label: '阿里云盘', match: (h) => h.includes('aliyun') || h.includes('alipan') },
  { key: 'quark', label: '夸克网盘', match: (h) => h.includes('quark') },
  {
    key: 'pan123',
    label: '123云盘',
    match: (h) =>
      h.includes('123pan') || h.includes('123912') || h.includes('123685') || h.includes('123959'),
  },
  { key: 'tianyi', label: '天翼云盘', match: (h) => h.includes('cloud.189') || h.includes('189.cn') },
  { key: 'xunlei', label: '迅雷云盘', match: (h) => h.includes('xunlei') },
  {
    key: 'wetransfer',
    label: 'WeTransfer',
    // 与扩展侧保持一致：只认短链域 we.tl 与官方主域（含子域），不做宽松 includes，
    // 否则 weather.com / weibo.com 这类含 "we" 的域名会被误判成网盘链接。
    match: (h) => h === 'we.tl' || h === 'wetransfer.com' || h.endsWith('.wetransfer.com'),
  },
]

function detectPlatform(u: string): { key: string | null; label: string } {
  try {
    const h = new URL(u).hostname.toLowerCase()
    const hit = PLATFORMS.find((p) => p.match(h))
    if (hit) return { key: hit.key, label: hit.label }
  } catch {
    /* ignore */
  }
  return { key: null, label: '自动' }
}

// 百度 / 迅雷的分享链接常带 ?pwd=xxxx；用户粘贴时习惯把链接和提取码一起复制，
// 但 UI 上还要求「提取码」单独填——不自动提取就会触发 PASS_CODE_EMPTY。
// 正则匹配而非 URL API，保留用户原始 URL 格式（不去做百分号重编码）。
// 支持的键名：pwd / password / code / p（迅雷/百度/123 实际只用 pwd）。
function extractPwdFromUrl(rawUrl: string): { cleanUrl: string; pwd: string | null } {
  const m = rawUrl.match(/[?&](?:pwd|password|code|p)=([^&#]+)/i)
  if (!m) return { cleanUrl: rawUrl, pwd: null }
  let pwd = ''
  try {
    pwd = decodeURIComponent(m[1])
  } catch {
    pwd = m[1]
  }
  // 去掉该参数本身（保留其它 query 如 from / utm 等）
  let clean = rawUrl.replace(/[?&](?:pwd|password|code|p)=[^&#]+/i, '')
  // 收尾：剥掉孤立的 ? 或 &
  clean = clean.replace(/[?&]$/, '')
  return { cleanUrl: clean, pwd }
}

export function NetdiskPanel() {
  const [url, setUrl] = useState('')
  const [pwd, setPwd] = useState('')
  const [platform, setPlatform] = useState('自动')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<NetdiskFile[]>([])
  const [source, setSource] = useState('')
  const [warning, setWarning] = useState('')
  // 解析请求是「投递到队列等扩展来取」的异步模型：扩展没装、没登录、
  // 或 Service Worker 被浏览器回收时，App 侧收不到任何回执。
  // 没有超时兜底的话界面会一直停在「解析中…」，用户无从判断是慢还是坏了。
  const timeoutRef = useRef<number | null>(null)

  function clearResolveTimeout() {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  useEffect(() => {
    const un = listen<ResolveResult>('netdisk-resolve-result', (e) => {
      const p = e.payload
      clearResolveTimeout()
      if (!p.ok) {
        setError(p.error || '解析失败')
        setLoading(false)
        return
      }
      // F9 修复：若前端 60s 兜底超时已先触发并写入红字 error，真实结果到达时必须清掉，
      // 否则会出现「解析超时」红字与解析结果同屏。warning 与 error 互斥，这里一并复位。
      setError('')
      setWarning(p.warning || '')
      setResults(p.files || [])
      setSource(p.url || '')
      setLoading(false)
    })
    return () => {
      clearResolveTimeout()
      un.then((f) => f())
    }
  }, [])

  async function onResolve() {
    if (!url.trim()) {
      setError('请粘贴网盘分享链接')
      return
    }
    // 磁力链接 / .torrent 不属于网盘解析，引导到「下载列表」标签，避免被误判为网盘平台
    const isBt =
      url.trim().toLowerCase().startsWith('magnet:') ||
      /\.torrent($|\?|#)/i.test(url.trim())
    if (isBt) {
      setPlatform('')
      setError('这是磁力链接 / .torrent 文件，请到上方「下载列表」标签粘贴，不要放在网盘解析。')
      return
    }
    const p = detectPlatform(url)
    setPlatform(p.label)
    if (!p.key) {
      setError('暂不支持该链接所属的网盘平台（当前支持：百度 / 阿里 / 夸克 / 123 / 天翼 / 迅雷 / WeTransfer）')
      return
    }
    setError('')
    setWarning('')
    setResults([])
    setLoading(true)
    clearResolveTimeout()
    try {
      await invoke('request_netdisk_resolve', {
        url: url.trim(),
        pwd: pwd.trim() || null,
        platform: p.key,
      })
      // 60s 兜底：扩展轮询间隔 2.5s，正常解析（含多文件换直链）一般在 10s 内完成。
      timeoutRef.current = window.setTimeout(() => {
        setLoading(false)
        setError(
          '解析超时：请确认浏览器已安装并启用「乐乐下载器」扩展，且已登录对应网盘。' +
            '若扩展刚被浏览器休眠，可打开一次浏览器窗口后重试。'
        )
      }, 60000)
    } catch (e) {
      clearResolveTimeout()
      setError('提交解析请求失败: ' + e)
      setLoading(false)
    }
  }

  async function addFile(f: NetdiskFile) {
    try {
      await invoke('create_download', {
        url: f.url,
        saveDir: undefined,
        headers: f.headers || null,
        filename: f.name,
      })
      alert(`已加入下载：${f.name}`)
    } catch (e) {
      alert('加入下载失败: ' + e)
    }
  }

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-white/70 backdrop-blur rounded-2xl shadow-sm border border-white/40 p-5">
          <h2 className="text-lg font-semibold text-gray-800 mb-1">网盘真实下载地址解析</h2>
          <p className="text-sm text-gray-500 mb-4">
            粘贴国内网盘分享链接 + 提取码，由已登录对应网盘的浏览器扩展在本地解析出直链后交给下载引擎。
            cookie 仅在扩展内使用，不会离开你的浏览器。
          </p>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">分享链接</label>
              <input
                type="text"
                value={url}
                onChange={(e) => {
                  // 粘贴百度/迅雷分享链接时，常带 ?pwd=xxxx / ?password= / ?code=
                  // 这里自动提取并填到「提取码」输入框，并把 URL 显示清干净。
                  const { cleanUrl, pwd } = extractPwdFromUrl(e.target.value)
                  setUrl(cleanUrl)
                  if (pwd) setPwd(pwd)
                }}
                placeholder="https://pan.baidu.com/s/xxxx 或 https://www.123pan.com/s/xxxx"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">
                  提取码（可选）{platform === 'WeTransfer' ? ' · WeTransfer 填分享密码' : ''}
                </label>
                <input
                  type="text"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  placeholder="如 xxxx"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={onResolve}
                  disabled={loading}
                  className="px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors"
                >
                  {loading ? '解析中…' : '解析'}
                </button>
              </div>
            </div>
            {platform !== '自动' && (
              <div className="text-xs text-gray-400">已识别平台：{platform}</div>
            )}
            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>
            )}
          </div>
        </div>

        {loading && (
          <div className="text-sm text-gray-500 text-center py-4">正在请浏览器扩展解析直链，请稍候…</div>
        )}

        {warning && !loading && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {warning}
          </div>
        )}

        {results.length > 0 && (
          <div className="bg-white/70 backdrop-blur rounded-2xl shadow-sm border border-white/40 p-5">
            <div className="text-sm text-gray-500 mb-3">解析结果（来源：{source || '网盘'}）</div>
            <div className="space-y-2">
              {results.map((f, i) => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{f.name}</div>
                    <div className="text-xs text-gray-400">{f.size || '未知大小'}</div>
                  </div>
                  <button
                    onClick={() => addFile(f)}
                    className="px-4 py-1.5 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
                  >
                    加入下载
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-gray-400 leading-relaxed">
          说明：百度网盘免费账号直链由平台限速（会员账号登录则可满速）；直链具时效性，过期后请重新解析。
          各网盘接口可能随官方变动失效，需更新扩展解析逻辑。
        </div>
      </div>
    </div>
  )
}

export default NetdiskPanel
