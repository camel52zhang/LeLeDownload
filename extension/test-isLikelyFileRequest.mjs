// 回归测试：isLikelyFileRequest（从改完的 content-script.js 照搬同款实现）
//
// 目的：验证 WeTransfer 2026 真实文件域名（*-files.wetransfer.net）被正确识别为文件请求，
//       同时 API / 预览域名（ekstrom / bsp-proxy / preview-eu 等 *.wetransfer.net）不再被误判，
//       以免破坏页面下载初始化流程（即主理人实证的「真实文件请求根本发不出去」根因）。
//
// 注意：原函数在内容脚本里用 location.href 作为 new URL 的 base；本测试所有 URL 均为绝对地址，
//       故用常量 BASE 替代（base 对绝对 URL 无影响），保持纯函数逻辑一致。
//
// 运行： node --test extension/test-isLikelyFileRequest.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/content-script.js 中 isLikelyFileRequest 完全一致（仅 base 替换）
// ---------------------------------------------------------------------------
function isLikelyFileRequest(url, method) {
  const BASE = 'https://we.tl/';
  const m = (method || 'GET').toUpperCase();
  if (m !== 'GET') return false; // 下载一律 GET
  let u;
  try {
    u = new URL(url, BASE);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const query = u.search.toLowerCase();

  // 常见文件扩展名（命中即视为文件请求；刻意排除静态资源/API 后缀 js/json/css/html 等）。
  const FILE_EXT = /\.(zip|tar|tgz|gz|rar|7z|mp4|mov|avi|mkv|m4v|m2ts|webm|m4a|aac|mp3|wav|flac|ogg|opus|pdf|docx?|xlsx?|pptx?|epub|azw|psd|ai|dwg|dxf|png|jpe?g|gif|webp|bmp|heic|tif|sql|db|zst|exe|msi|dmg|iso|img|bin|dat|csv|txt|apk|deb|rpm|jar|war|torrent)$/i;

  // --- Google Drive 实际文件内容（带 confirm token 的 CDN）---
  if (host.endsWith('googleusercontent.com')) return true;
  if (host === 'drive.usercontent.google.com') return true;
  if (host.endsWith('google.com') && (query.includes('export=download') || query.includes('export=view'))) return true;
  // GD 大文件二次确认：*.drive.google.com/uc?export=download&confirm=xxx
  if (host.endsWith('drive.google.com') && (path.includes('/uc') || query.includes('export='))) return true;

  // --- WeTransfer 文件 CDN（区别于 web API 域名）---
  if (host === 'download.wetransfer.com') return true;
  if (host === 'filedownload.wetransfer.com') return true;
  if (host === 'transfer.wetransfer.com') return true;
  // 2026 实际文件域名为 *-files.wetransfer.net（如 eu-west-1-files.wetransfer.net，CloudFront/S3 签名 URL）
  if (host.endsWith('files.wetransfer.net')) return true;

  // --- 兜底：CloudFront / 通用签名 URL（含 signature + expires 即视为文件请求）---
  //     仅对「非 wetransfer 域」生效，wetransfer 各子域由上方精确白名单处理。
  if (!host.includes('wetransfer') && query.includes('signature=') && query.includes('expires=')) {
    return true;
  }

  // --- 其他网盘 CDN（best-effort；仅在带明确文件扩展名时命中）---
  if ((host === 'dl.dropboxusercontent.com' || host.endsWith('.dropboxusercontent.com') || host.endsWith('.mega.nz')) && FILE_EXT.test(path)) {
    return true;
  }

  // --- 通用安全排除：API / 静态资源（绝不当作文件下载）---
  if (path.includes('/api/')) return false;
  if (/\.(json|js|css|html?|map|woff2?|ttf|eot|svg|webmanifest|xml)$/.test(path)) return false;

  // --- 通用启发：路径含常见文件扩展名（wetransfer 域已由白名单处理，不在此命中）---
  if (!host.includes('wetransfer') && FILE_EXT.test(path)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// 1) 2026 真实文件域名：*-files.wetransfer.net 签名 URL → true
test('真实文件域名为 eu-west-1-files.wetransfer.net 应识别为文件请求', () => {
  const url = 'https://eu-west-1-files.wetransfer.net/files/abc?Expires=1&Signature=xyz';
  assert.equal(isLikelyFileRequest(url, 'GET'), true);
});

// 2) download.wetransfer.com → true
test('download.wetransfer.com 应识别为文件请求', () => {
  assert.equal(isLikelyFileRequest('https://download.wetransfer.com/foo/bar.zip', 'GET'), true);
});

// 3) filedownload / transfer 子域 → true
test('filedownload.wetransfer.com 与 transfer.wetransfer.com 应识别为文件请求', () => {
  assert.equal(isLikelyFileRequest('https://filedownload.wetransfer.com/abc', 'GET'), true);
  assert.equal(isLikelyFileRequest('https://transfer.wetransfer.com/abc', 'GET'), true);
});

// 4) 之前被误判的 API 域名 ekstrom.wetransfer.net → false（修复核心）
test('ekstrom.wetransfer.net API 请求不应被误判为文件请求', () => {
  const url = 'https://ekstrom.wetransfer.net/v1/customizations/transfers/xxx';
  assert.equal(isLikelyFileRequest(url, 'GET'), false);
});

// 5) bsp-proxy.wetransfer.net → false
test('bsp-proxy.wetransfer.net 不应被误判为文件请求', () => {
  const url = 'https://bsp-proxy.wetransfer.net/orion/v3/identity/settings';
  assert.equal(isLikelyFileRequest(url, 'GET'), false);
});

// 6) preview-eu.wetransfer.net 预览 PDF（带 signature= + expires=）应被精确白名单隔离 → false
//    （通用 CloudFront 兜底已排除 wetransfer 域，预览 PDF 不再被误抓）
test('preview-eu.wetransfer.net 预览 PDF 签名 URL 不应被误判（false）', () => {
  const url = 'https://preview-eu.wetransfer.net/transfer/xxx/preview.pdf?Expires=1&Key-Pair-Id=K&Signature=zzz';
  assert.equal(isLikelyFileRequest(url, 'GET'), false);
});

// 7) Google Drive 规则保持不变 → true
test('Google Drive 文件 URL 应仍为 true', () => {
  assert.equal(isLikelyFileRequest('https://drive.usercontent.google.com/download?id=1', 'GET'), true);
  assert.equal(isLikelyFileRequest('https://doc-0c-0k-docs.googleusercontent.com/docs/abc', 'GET'), true);
  assert.equal(isLikelyFileRequest('https://drive.google.com/uc?export=download&confirm=xxx', 'GET'), true);
});

// 8) 非 GET（如 prepare-download 的 POST）→ false（绝不拦截 API 写请求）
test('POST 请求不应被识别为文件请求', () => {
  assert.equal(isLikelyFileRequest('https://we.tl/api/v4/transfers/id/prepare-download', 'POST'), false);
});

// 9) 普通页面静态资源 /api 路径 → false
test('带 /api/ 路径的 wetransfer 请求应为 false', () => {
  const url = 'https://ekstrom.wetransfer.net/api/v4/transfers/t-FcwxddGsw8aNmQeh/prepare-download';
  assert.equal(isLikelyFileRequest(url, 'GET'), false);
});

// 10) 修复第二项：preview-eu.wetransfer.net 预览 PDF 不应被通用兜底误抓（应 false，由精确白名单单独处理）
test('preview-eu.wetransfer.net 预览 PDF 不应被通用 CloudFront 兜底误判为文件请求', () => {
  const url = 'https://preview-eu.wetransfer.net/transfer/f5740af0/hl-75498925703/default/preview.pdf?Expires=1786097654&Key-Pair-Id=K2SVF85QSYV5SB&Signature=VDseUIw3';
  assert.equal(isLikelyFileRequest(url, 'GET'), false);
});
