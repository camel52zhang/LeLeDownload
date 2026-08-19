#!/usr/bin/env bash
set -u
export PATH="/c/Users/kfar-z/mingw64/mingw64/bin:/c/Users/kfar-z/.cargo/bin:$PATH"
export NODE_OPTIONS=""
cd /d/tools/WorkBuddy/lele_download
echo "=== tauri:build ==="
npm run tauri:build > /tmp/lele-build-pwd-inner.log 2>&1
echo "BUILD_EXIT=$?"
echo "=== post-build rename ==="
node scripts/post-build.mjs
echo "POST_BUILD_EXIT=$?"
echo "=== verify extractPwdFromUrl in bundle ==="
grep -l "extractPwdFromUrl\|pwd=password" dist/assets/*.js 2>/dev/null
echo "=== installer ==="
ls -la src-tauri/target/release/bundle/nsis/ | grep setup | tail -2
