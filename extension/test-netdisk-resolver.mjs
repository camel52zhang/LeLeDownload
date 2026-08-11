// 回归测试：网盘解析的两个纯函数（从 background.js 照搬同款实现）
//
// 目的：
//   1) detectNetdiskPlatform —— 保证分享链接被路由到正确的解析器。路由错了整条链路直接失败，
//      且错误信息会误导用户（例如把阿里链接当百度处理，提示"请登录百度网盘"）。
//      重点覆盖阿里的新旧双域名（alipan.com / aliyundrive.com）和 123 云盘的多个马甲域名。
//   2) bytesToSize —— 各平台返回的 size 字段类型不统一（number / 字符串数字 / undefined / null），
//      直接 Number(undefined) 会渲染出 "NaN B"，这里锁死降级为空串的行为。
//
// 运行： node --test extension/test-netdisk-resolver.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 以下实现与 extension/background.js 中同名函数完全一致
// ---------------------------------------------------------------------------
function detectNetdiskPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('baidu')) return 'baidu';
    if (h.includes('aliyun') || h.includes('alipan')) return 'aliyun';
    if (h.includes('quark')) return 'quark';
    if (h.includes('123pan') || h.includes('123912') || h.includes('123685') || h.includes('123959')) return 'pan123';
    if (h.includes('cloud.189') || h.includes('189.cn')) return 'tianyi';
  } catch (_) { /* ignore */ }
  return null;
}

function bytesToSize(n) {
  if (n === undefined || n === null || n === '') return '';
  n = Number(n);
  if (isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(2) + ' ' + u[i];
}

// ---------------------------------------------------------------------------
// detectNetdiskPlatform
// ---------------------------------------------------------------------------
test('百度网盘分享链接识别为 baidu', () => {
  assert.equal(detectNetdiskPlatform('https://pan.baidu.com/s/1AbCdEfG'), 'baidu');
  assert.equal(detectNetdiskPlatform('https://yun.baidu.com/s/1AbCdEfG'), 'baidu');
});

test('阿里云盘新旧双域名都识别为 aliyun', () => {
  // 2023 年改名 alipan.com，老链接 aliyundrive.com 仍在流通，两者都必须命中
  assert.equal(detectNetdiskPlatform('https://www.alipan.com/s/xY9zQ'), 'aliyun');
  assert.equal(detectNetdiskPlatform('https://www.aliyundrive.com/s/xY9zQ'), 'aliyun');
});

test('夸克网盘识别为 quark', () => {
  assert.equal(detectNetdiskPlatform('https://pan.quark.cn/s/abcd1234'), 'quark');
});

test('123 云盘的多个马甲域名都识别为 pan123', () => {
  assert.equal(detectNetdiskPlatform('https://www.123pan.com/s/abcd-1234'), 'pan123');
  assert.equal(detectNetdiskPlatform('https://www.123912.com/s/abcd-1234'), 'pan123');
  assert.equal(detectNetdiskPlatform('https://www.123685.com/s/abcd-1234'), 'pan123');
});

test('天翼云盘识别为 tianyi', () => {
  assert.equal(detectNetdiskPlatform('https://cloud.189.cn/t/abcdef'), 'tianyi');
  assert.equal(detectNetdiskPlatform('https://h5.cloud.189.cn/share.html#/t/abc'), 'tianyi');
});

test('非网盘域名与非法输入返回 null（不会误进任何解析器）', () => {
  assert.equal(detectNetdiskPlatform('https://github.com/foo/bar'), null);
  assert.equal(detectNetdiskPlatform('https://example.com/s/abcd'), null);
  assert.equal(detectNetdiskPlatform('not a url'), null);
  assert.equal(detectNetdiskPlatform(''), null);
});

// ---------------------------------------------------------------------------
// bytesToSize
// ---------------------------------------------------------------------------
test('字节数按 1024 进制换算并保留两位小数', () => {
  assert.equal(bytesToSize(0), '0.00 B');
  assert.equal(bytesToSize(512), '512.00 B');
  assert.equal(bytesToSize(1024), '1.00 KB');
  assert.equal(bytesToSize(1536), '1.50 KB');
  assert.equal(bytesToSize(1024 * 1024), '1.00 MB');
  assert.equal(bytesToSize(1024 * 1024 * 1024 * 3), '3.00 GB');
});

test('字符串数字（部分网盘 API 返回字符串）同样能换算', () => {
  assert.equal(bytesToSize('2048'), '2.00 KB');
});

test('缺失或非法的 size 降级为空串，绝不渲染 NaN', () => {
  assert.equal(bytesToSize(undefined), '');
  assert.equal(bytesToSize(null), '');
  assert.equal(bytesToSize(''), '');
  assert.equal(bytesToSize('未知'), '');
});

test('超过 TB 时封顶在 TB 单位，不会越界读到 undefined', () => {
  assert.equal(bytesToSize(Math.pow(1024, 5)), '1024.00 TB');
});
