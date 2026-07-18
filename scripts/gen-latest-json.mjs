// CI 专用：构建后生成 latest.json 供 updater 检查更新。
// 读当天 yymmdd + .sig 内容 + 仓库地址，输出 latest.json。
// 由 GitHub Actions 在 `npm run tauri:build` 后调用。
import fs from 'fs';

const d = new Date();
const yymmdd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const semver = `1.${yymmdd}.0`;
const exe = `LeLeDownload_v${yymmdd}_x64-setup.exe`;
const sigPath = `src-tauri/target/release/bundle/nsis/${exe}.sig`;
const sig = fs.readFileSync(sigPath, 'utf8').trim();
const tag = process.env.GITHUB_REF_NAME || `v${semver}`;
const repo = process.env.GITHUB_REPOSITORY || 'OWNER/REPO';

const latest = {
  version: semver,
  notes: `Release ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sig,
      url: `https://github.com/${repo}/releases/download/${tag}/${exe}`,
    },
  },
};

fs.writeFileSync('latest.json', JSON.stringify(latest, null, 2));
console.log(JSON.stringify(latest, null, 2));
