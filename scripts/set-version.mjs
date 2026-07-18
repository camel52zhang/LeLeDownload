// 构建前自动把当天日期写进版本号配置，无需手动改。
// 规则：yymmdd = 260718，semver = 1.260718.0，界面显示 v260718。
// 由 `npm run tauri:build` 自动调用。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const now = new Date();
const yy = String(now.getFullYear()).slice(2);
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const yymmdd = `${yy}${mm}${dd}`;
const semver = `1.${yymmdd}.0`;

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
fs.writeFileSync(versionTsPath, `// 应用版本号：yymmdd 格式（内部 semver 为 1.<yymmdd>.0）。\n// 由 scripts/set-version.mjs 在构建时自动写入当天日期，无需手动改。\nexport const APP_VERSION = '${yymmdd}'\n`);

console.log('[set-version] done');
