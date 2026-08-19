#!/usr/bin/env bash
set -u
export PATH="/c/Users/kfar-z/mingw64/mingw64/bin:/c/Users/kfar-z/.cargo/bin:$PATH"
export NODE_OPTIONS=""
cd /d/tools/WorkBuddy/lele_download
echo "=== tauri:build (前端 UI 改动 → vite 重 build 嵌入 webview2) ==="
npm run tauri:build > /tmp/lele-build-xunlei-frontend-inner.log 2>&1
echo "BUILD_EXIT=$?"
echo "=== post-build rename (签名退码1属预期) ==="
node scripts/post-build.mjs
echo "POST_BUILD_EXIT=$?"
echo "=== verify 迅雷 在 src-tauri 前端打包内 ==="
node -e "const fs=require('fs');const p=['src-tauri/dist','src-tauri/ui'];for(const d of p){const f=d+'/_next/static';if(fs.existsSync(d)){console.log(d,'exists');}}"
ls -la src-tauri/target/release/bundle/nsis/ | grep -E "setup" | tail -2
