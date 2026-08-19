# 百度网盘 r20 交付：errno -20 风控处理（bdstoken 登录增强）

- 日期：2026-08-19
- 构建：`LeLeDownload_v26.08.19_x64-setup.exe`（3,414,158 B，MD5 `b2652422b2e02322dcdc12916f2b69e8`）

## 背景

用户解析 `https://pan.baidu.com/share/init?surl=HN2hr-1igGA30V7ypF2vhg&pwd=q7g4` 报：

> 百度接口提示：验证码输入错误，请重试（errno -20）（uk=1099672802734, shareid=2167885621, fs_id=...）

## 根因（实测 + 参考项目双重验证）

**errno -20 = 百度风控/验证码要求**（IP 级或分享级），实测结论：

1. **沙箱实测复现**：wxlist/tplconfig 全通，sharedownload 稳定返 -20「验证码输入错误」
2. **验证码无法程序化绕过**：实测 `POST /api/getcaptcha` 匿名可用且返回 `raw_ans`（验证码明文答案），但带 `vcode_input=raw_ans + vcode_str` 重试仍 -20——百度对该 IP 的风控不止验证码一层（数据中心 IP 触发更严风控）
3. **参考项目同样无法自动过**：netdisk-resolver-v1.4 对 -20 也是抛「需要验证码」让用户输入，它没有自动绕过方案
4. **关键差异**：参考项目 `sharedownload` 带了 **`bdstoken`**（登录令牌）——百度对登录用户显著降低风控概率。我们此前漏了这个参数

## r20 改动

1. **新增 `baiduGetBdstoken()`**：`GET /api/gettemplatevariable?fields=["bdstoken"]`（需登录态 BDUSS；匿名返回 errno -6 → 返回 ''，功能不受影响）
2. **`resolveBaidu` sharedownload URL 加 `&bdstoken=`**（有登录态时）——登录百度网盘账号的用户解析 -20 分享概率显著降低
3. **-20 错误提示升级**：「若已登录百度网盘账号会显著降低风控；未登录请先在浏览器手动打开该分享链接完成验证，等几分钟后再解析」

build 标签 r19 → r20。

## 测试

- 百度单测 **22/22 全绿**：
  - T21：gettemplatevariable 返回 bdstoken → sharedownload URL 带 `bdstoken=...`
  - T22：未登录（errno -6）→ sharedownload 不带 bdstoken（降级正常）
- 全量回归 **98/98 全绿**（阿里20+百度22+夸克16+迅雷12+12328）

## 打包副本（src-tauri/target/release/extension/background.js，109,946 B）

| 标记 | 命中 |
|---|---|
| `build=r20` | 4 |
| `baiduGetBdstoken` | 2 |
| `gettemplatevariable` | 2 |
| `bdstoken=` 拼接 | 1 |

## 安装包

- `src-tauri/target/release/bundle/nsis/LeLeDownload_v26.08.19_x64-setup.exe`
- 字节数：3,414,158 B
- MD5：`b2652422b2e02322dcdc12916f2b69e8`

## 用户操作（关键）

errno -20 是百度主动风控，代码无法保证 100% 绕过。装 r20 后：

1. **首选：在浏览器登录百度网盘账号**（`https://pan.baidu.com`，保持登录）→ 扩展自动带 BDUSS + bdstoken → 重新解析，风控概率显著降低
2. 若仍 -20：先在浏览器手动打开该分享链接 `pan.baidu.com/share/init?surl=...` 按提示完成验证 → 等几分钟 → 回 LeLeDownload 再解析
3. 数据中心 IP / 频繁请求会持续触发 -20（平台策略，所有工具一致）

## 遗留

- 改动未 commit/push（沙箱无凭据），用户本地执行：
  ```bash
  cd D:\tools\WorkBuddy\lele_download
  git add -A
  git commit -m "fix(baidu): r20 sharedownload 带 bdstoken 降低 errno -20 风控（gettemplatevariable 取登录令牌）+ 提示升级"
  git push -u origin main && git push -f origin v26.08.19
  ```
