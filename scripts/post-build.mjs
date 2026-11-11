// 构建后把 nsis 产物重命名为 LeLeDownload_v<yymmdd>_x64-setup.exe(+.sig)。
// 由 `npm run tauri:build` 在 tauri build 后自动调用。
// 版本来源：src-tauri/tauri.conf.json 的 version 字段（set-version.mjs 统一写入的单一事实源），
// 不再按当天日期推导——同日多发版（如 hotfix 26.11.12）时日期推导会把新包改名成旧版本号、
// 覆盖已发版安装包（2026-11-11 踩过：26.11.12 的包被改成 v26.11.11）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nsisDir = path.join(root, 'src-tauri/target/release/bundle/nsis');

// 从 tauri.conf.json 读 semver（如 "26.11.12"），格式化为显示版本 v26.11.12（mm/dd 补零）
const tauriConf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const [vy, vm, vd] = String(tauriConf.version).split('.');
if (!vy || !vm || !vd) {
  console.error(`[post-build] 无法解析 tauri.conf.json version: ${tauriConf.version}`);
  process.exit(1);
}
const newName = `LeLeDownload_v${vy}.${vm.padStart(2, '0')}.${vd.padStart(2, '0')}_x64-setup.exe`;

if (!fs.existsSync(nsisDir)) {
  console.log('[post-build] nsis dir not found, skip');
  process.exit(0);
}

const files = fs.readdirSync(nsisDir);
const exe = files.find(f => f.startsWith('LeLeDownload_') && !f.startsWith('LeLeDownload_v') && f.endsWith('_x64-setup.exe'));
const sig = files.find(f => f.startsWith('LeLeDownload_') && !f.startsWith('LeLeDownload_v') && f.endsWith('_x64-setup.exe.sig'));

if (exe && exe !== newName) {
  fs.renameSync(path.join(nsisDir, exe), path.join(nsisDir, newName));
  console.log(`[post-build] ${exe} -> ${newName}`);
} else if (exe === newName) {
  console.log(`[post-build] already named ${newName}`);
}
if (sig && sig !== newName + '.sig') {
  fs.renameSync(path.join(nsisDir, sig), path.join(nsisDir, newName + '.sig'));
  console.log(`[post-build] ${sig} -> ${newName}.sig`);
}
console.log('[post-build] done');
