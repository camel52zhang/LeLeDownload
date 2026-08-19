# 迅雷解析修复交付报告（第 11 轮 · build=r11）

**日期**：2026-08-19
**包名**：`LeLeDownload_v26.08.19_x64-setup.exe`
**字节数**：3,407,359 B
**MD5**：`fadd1f501c159d6105e11795f30e7929`
**构建耗时**：4m39s（仅末尾签名缺私钥退码 1，属预期，已手动 post-build 重命名）

---

## 一、用户报错的真实根因

最终报错（截图）：

```
迅雷解析失败(download)：文件[影视仓（26年最新版）/配置教程]
取直链失败：无直链字段
{"kind":"drive#file","id":"VP-NnZTP_7N7KwIUia2J1TuHA1",...}
```

**根因链**：
1. 旧 r8 模型把迅雷当成「夸克模型」——folder 分享**整份转存**进用户网盘 + `listOwnDir` 列自有网盘取直链。
2. 取直链用 `GET /files/{id}?usage=CONSUME` —— 该参数会屏蔽 `web_content_link` 字段，导致「无直链字段」。
3. 整份转存既污染用户网盘、又啰嗦，且 folder 内部文件链路脆弱。

**关键转折**：用户建议参考本地项目 `D:\tools\NetDiskResolver\netdisk-resolver-v1.4`。读取其 `app/providers/xunlei/api.py` + 抓包 `xunlei_dl_probe.json` / `xunlei_fileinfo_capture.json`，确认了迅雷 web 端的**权威真端点**，替代了 r8 的 wgx0307 整份转存假设。

---

## 二、参考项目实证的三条关键事实

| # | 事实 | 旧实现（r8 错在哪） | 新实现（r11 正确） |
|---|------|---------------------|---------------------|
| 1 | folder 内部列子目录用 `GET /drive/v1/share/detail?parent_id=<folderId>` | 用 `/share?parent_id=` → 只回 self-ref，拿不到内部文件 | 子目录走 `/share/detail` |
| 2 | 取直链有 fast path `GET /share/file_info?share_id=&file_id=&pass_code_token=` | 无此路径，只能转存后取 | `/share/file_info` 返回 `file_info.web_content_link` 或 `file_info.medias[].link.url` |
| 3 | `GET /files/{id}` **不带 `usage=CONSUME`** 才返回 `web_content_link` | 带 `usage=CONSUME` → 字段被屏蔽 →「无直链字段」 | `/files/{id}?space=`（无 usage） |

**零副作用**：fast path `/share/file_info` 不写任何文件进用户网盘，彻底消除「整份转存污染网盘」的副作用。

---

## 三、代码改动（`extension/background.js` · `xunleiApiFetch`，build=r11）

### 3.1 删除（整份转存模型）
- `listOwnDir` / `restoreAndCollect` / `extractOwnFiles` —— 已根除，grep `listOwnDir`/`restoreAndCollect` 打包副本均为 **0 命中**。

### 3.2 新增 `listShareDir(parentId, dirPath, depth, useExistingData)`
- **root**：用 `/share`（复用 step1 的 `sd` 省一次请求，通过 `useExistingData` 参数传入，`calls.share=1` 不重复请求）。
- **子目录**：`/share/detail?parent_id=<folderId>`，递归下钻。
- files 在 `j.files` 顶层或 `j.data.files`（双兜底）。
- `passCodeToken` 由 `const` 改 `let`，`listShareDir` 内遇 `j.pass_code_token` 实时更新。

### 3.3 取直链两步模型
```js
// ① fast path（零副作用）
const fiResp = await fetch(API + '/share/file_info' + fiQs, {method:'GET', headers:authHeaders, credentials:'include'});
const fileInfo = fij.file_info || fij;
durl = fileInfo.web_content_link || '';
// 回退 medias[].link.url
if (!durl && Array.isArray(fileInfo.medias)) {
  for (const m of fileInfo.medias) {
    if (m && m.link && m.link.url) { durl = m.link.url; break; }
  }
}
// ② 失败回退：单文件转存 + /files/{id} 取直链（不带 usage=CONSUME）
if (!durl) {
  const restoreResp = await fetch(API + '/share/restore', {method:'POST', ..., body: JSON.stringify({
    share_id, pass_code_token, file_ids:[fid], folder_type:'NORMAL', specify_parent_id:true, parent_id:''
  })});
  // 轮询 GET /tasks/{taskId} → progress==100 取 params.trace_file_ids
  const dlResp = await fetch(API + '/files/' + encodeURIComponent(newFileId) + '?space=', {method:'GET', ...});
  const dd = dlJson.data || dlJson;
  durl = dd.web_content_link
      || (dd.links && dd.links['application/octet-stream'] && dd.links['application/octet-stream'].url)
      || dd.url || '';
}
```

### 3.4 诊断标记升级
错误体标签：`build=r11，参考 netdisk-resolver 改用 /share + /share/detail`。

---

## 四、测试（消灭镜像漂移）

`test-xunlei.mjs` 改为**从 `background.js` 用括号匹配抽取真实 `xunleiApiFetch` eval 执行**，不再手维护镜像副本，杜绝漂移。重写 X1–X12：

| 用例 | 覆盖场景 |
|------|----------|
| X1 | 根目录单文件 → `file_info` fast path 取直链 |
| X2 | 根 folder → `/share/detail` 下钻 → `file_info` |
| X3 | `file_info` 空 → 回退 restore + `/files` |
| X4 | `file_info` 404 → 回退 restore |
| X5 | 嵌套 folder 递归 |
| X6 | 提取码 PASS_CODE_EMPTY |
| X7 | 分享失效 NOT_FOUND/EXPIRED |
| X8 | 401 未登录 |
| X9 | 无登录态不崩 |
| X10 | `/share` 顶层翻页（page_token） |
| X11 | 嵌套 > 10 层 → 截断但不丢浅层文件 |
| X12 | folder 内纯文件 → 一次 `file_info` 即取直链 |

**测试结果**：
- 迅雷 `test-xunlei.mjs`：**12/12 全绿**
- 全量 `node --test extension/test-{aliyun,baidu,quark,xunlei}.mjs`：**65/65 全绿**（阿里17 + 百度20 + 夸克16 + 迅雷12）

---

## 五、打包副本校验（`src-tauri/target/release/extension/background.js`，86287 B）

| 标记 | 期望 | 实测 |
|------|------|------|
| `build=r11` | ≥1 | ✅ 1 |
| `/share/detail` | ≥1 | ✅ 8 |
| `/share/file_info` | ≥1 | ✅ 5 |
| `usage=CONSUME` 实际查询参数 | 0 | ✅ 0（4 处命中**全在注释**，实际 `/files/{id}` 仅 `?space=`） |
| `listOwnDir` 残留 | 0 | ✅ 0 |
| `restoreAndCollect` 残留 | 0 | ✅ 0 |

---

## 六、安装与验证建议

1. **彻底卸载旧版** → 删除 `D:\Program Files\LeLeDownload\extension` → 安装 `LeLeDownload_v26.08.19_x64-setup.exe`。
2. 若浏览器手动加载扩展，reload 新目录（确认扩展诊断体含 `build=r11`）。
3. 复测原报错分享：`https://pan.xunlei.com/s/VOsigHJZZXqL9Bu_unnFoeTlA1?pwd=pmue`（影视仓 folder 分享），应能在 **不污染网盘** 的前提下取到「配置教程」等内部文件直链。
4. 如仍失败，回贴 SW console 诊断（含 `build=r11` 标签）以便精确定位 live 字段名偏差。

---

## 七、待用户本地执行（commit/push，沙箱无凭据）

```bash
cd D:\tools\WorkBuddy\lele_download
git add -A
git commit -m "fix(xunlei): r11 参考 netdisk-resolver-v1.4 重做取直链（/share/detail 列子目录 + /share/file_info fast path，零副作用）+ 根除整份转存污染网盘"
git push -u origin main
git push -f origin v26.08.19
```
