import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { APP_VERSION } from '../version'

export interface UpdateResult {
  available: boolean
  version: string
  currentVersion: string
  body?: string
}

// 检查是否有新版本（从 tauri.conf.json 配置的 endpoints 拉取并校验签名）
export async function checkForUpdate(): Promise<UpdateResult> {
  try {
    const update = await check()
    if (update?.available) {
      return { available: true, version: update.version, currentVersion: APP_VERSION, body: update.body }
    }
    return { available: false, version: APP_VERSION, currentVersion: APP_VERSION }
  } catch (e) {
    console.error('[乐乐] 检查更新失败:', e)
    throw e
  }
}

// 下载并安装更新，完成后重启应用
export async function downloadAndInstallUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall()
  await relaunch()
}

// 重新探测一次以拿到可执行的 Update 对象（checkForUpdate 只返回摘要）
export async function getUpdate(): Promise<Update | null> {
  return await check()
}
