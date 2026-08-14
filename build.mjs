import { build } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 同步项目根最新扩展 → src-tauri/extension，确保桌面端打包的扩展始终是最新版
// （tauri.conf.json 的 resources."extension" 相对 src-tauri 解析，无法直接 ../ 跳出）。
// 这样扩展只需维护项目根 extension/ 一份，避免陈旧副本被打进安装包。
const srcExt = path.resolve(__dirname, 'extension');
const dstExt = path.resolve(__dirname, 'src-tauri', 'extension');
try {
  fs.rmSync(dstExt, { recursive: true, force: true });
} catch {
  // 忽略清理失败（如 safe-delete 垫片拦截），下方 cpSync 会覆盖同名文件
}
fs.cpSync(srcExt, dstExt, { recursive: true, filter: (s) => !path.basename(s).startsWith('test-') });
console.log('[build] synced extension -> src-tauri/extension');

build({
  root: __dirname,
  logLevel: 'info',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
}).catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
