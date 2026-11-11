// 构建前自动把当天日期写进版本号配置，无需手动改。
// 规则：yy/mm/dd 格式（示例 26/08/06），semver = 26.8.6（去掉前导零，合法 semver），界面显示 v26.08.06。
// 由 `npm run tauri:build` 自动调用。
// 同日多发版（hotfix 第二版）时支持显式指定：`node scripts/set-version.mjs 26.11.12`，
// 此时 npm run tauri:build 不可用（其内置调用会按日期覆盖），改为手动
// `node_modules/.bin/tauri build && node scripts/post-build.mjs`。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 解析版本：优先显式参数（yy.m.d / yy.mm.dd），无参按当天日期
const argVer = process.argv[2];
let yy, mm, dd;
if (argVer) {
  const m = argVer.match(/^(\d{2})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) {
    console.error(`[set-version] 非法版本参数: ${argVer}（应为 yy.m.d 或 yy.mm.dd，如 26.11.12）`);
    process.exit(1);
  }
  [, yy, mm, dd] = m;
  mm = mm.padStart(2, '0');
  dd = dd.padStart(2, '0');
  console.log(`[set-version] explicit=${argVer}`);
} else {
  const now = new Date();
  yy = String(now.getFullYear()).slice(2);
  mm = String(now.getMonth() + 1).padStart(2, '0');
  dd = String(now.getDate()).padStart(2, '0');
}
const yymmdd = `${yy}${mm}${dd}`;
const semver = `${yy}.${parseInt(mm)}.${parseInt(dd)}`;

console.log(`[set-version] yymmdd=${yymmdd} semver=${semver}`);

// tauri.conf.json
const tauriConfPath = path.join(root, 'src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = semver;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 4));

// Cargo.toml（只替换 [package] 下的 version 行）
const cargoPath = path.join(root, 'src-tauri/Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf8');
cargo = cargo.replace(/^version = ".*"/m, `version = "${semver}"`);
fs.writeFileSync(cargoPath, cargo);

// package.json
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = semver;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// src/version.ts（界面显示用）
const versionTsPath = path.join(root, 'src/version.ts');
fs.writeFileSync(versionTsPath, `// 应用版本号：yy.mm.dd 格式（内部 semver 为 ${yy}.${parseInt(mm)}.${parseInt(dd)}，去掉前导零）。\n// 由 scripts/set-version.mjs 在构建时自动写入当天日期，无需手动改。\nexport const APP_VERSION = '${yy}.${mm}.${dd}'\n`);

console.log('[set-version] done');
