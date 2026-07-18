// 构建后把 nsis 产物重命名为 LeLeDownload_v<yymmdd>_x64-setup.exe(+.sig)。
// 由 `npm run tauri:build` 在 tauri build 后自动调用。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nsisDir = path.join(root, 'src-tauri/target/release/bundle/nsis');

const now = new Date();
const yy = String(now.getFullYear()).slice(2);
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const yymmdd = `${yy}${mm}${dd}`;
const newName = `LeLeDownload_v${yymmdd}_x64-setup.exe`;

if (!fs.existsSync(nsisDir)) {
  console.log('[post-build] nsis dir not found, skip');
  process.exit(0);
}

const files = fs.readdirSync(nsisDir);
const exe = files.find(f => f.endsWith('_x64-setup.exe'));
const sig = files.find(f => f.endsWith('_x64-setup.exe.sig'));

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
