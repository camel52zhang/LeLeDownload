#!/usr/bin/env node
/**
 * magnet-probe.mjs — 磁力链接可下载性诊断工具
 *
 * 判定一个 magnet 到底能不能下：走完 librqbit 真实路径的三步
 *   1) BEP5 DHT 迭代 get_peers  → 找 peer
 *   2) BEP3 TCP 握手 + BEP10 扩展握手 → 验证 peer 活着且支持扩展协议
 *   3) BEP9 ut_metadata 请求    → 真正拉一片 metadata 回来
 *
 * ⚠️ 不要用 UDP tracker 的 seeders/leechers 判定死活！
 *    librqbit 默认启用 DHT，peer 主要来自 DHT。实测多个 magnet 在 tracker 上
 *    一律 seeders=0，但其中能正常高速下载的照样存在——tracker 数据无判定价值。
 *
 * 用法:
 *   node scripts/magnet-probe.mjs "magnet:?xt=urn:btih:<hash>"
 *   node scripts/magnet-probe.mjs <40位infohash> [标签]
 */

import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';

// ───────────────────────── bencode ─────────────────────────
function bencode(obj) {
  if (Buffer.isBuffer(obj)) return Buffer.concat([Buffer.from(String(obj.length) + ':'), obj]);
  if (typeof obj === 'string') {
    const b = Buffer.from(obj, 'utf8');
    return Buffer.concat([Buffer.from(String(b.length) + ':'), b]);
  }
  if (typeof obj === 'number') return Buffer.from('i' + Math.trunc(obj) + 'e');
  if (Array.isArray(obj)) return Buffer.concat([Buffer.from('l'), ...obj.map(bencode), Buffer.from('e')]);
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return Buffer.concat([
      Buffer.from('d'),
      ...keys.map((k) => Buffer.concat([bencode(k), bencode(obj[k])])),
      Buffer.from('e'),
    ]);
  }
  throw new Error('bencode: unsupported type');
}

function bdecode(buf) {
  let i = 0;
  function parse() {
    const c = buf[i];
    if (c === 0x69) {
      const e = buf.indexOf(0x65, i);
      const n = parseInt(buf.slice(i + 1, e).toString('latin1'), 10);
      i = e + 1;
      return n;
    }
    if (c === 0x6c) {
      i++;
      const a = [];
      while (i < buf.length && buf[i] !== 0x65) a.push(parse());
      i++;
      return a;
    }
    if (c === 0x64) {
      i++;
      const o = {};
      while (i < buf.length && buf[i] !== 0x65) {
        const k = parse();
        o[Buffer.isBuffer(k) ? k.toString('latin1') : String(k)] = parse();
      }
      i++;
      return o;
    }
    const colon = buf.indexOf(0x3a, i);
    const len = parseInt(buf.slice(i, colon).toString('latin1'), 10);
    const s = colon + 1;
    i = s + len;
    return buf.slice(s, i);
  }
  const value = parse();
  return { value, consumed: i };
}

const xor20 = (a, b) => {
  const o = Buffer.alloc(20);
  for (let k = 0; k < 20; k++) o[k] = a[k] ^ b[k];
  return o;
};

// ───────────────────────── BEP5 DHT ─────────────────────────
const BOOTSTRAP = [
  ['router.bittorrent.com', 6881],
  ['dht.transmissionbt.com', 6881],
  ['router.utorrent.com', 6881],
  ['dht.libtorrent.org', 25401],
];

function dhtGetPeers(infoHash, budgetMs, onLog) {
  return new Promise((resolve) => {
    const myId = crypto.randomBytes(20);
    const sock = dgram.createSocket('udp4');
    const peers = new Map();
    const queried = new Set();
    const seen = new Map();
    let sent = 0, resp = 0, valuesResp = 0, reboot = 0, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(pump);
      clearTimeout(hard);
      try { sock.close(); } catch {}
      resolve({
        peers: [...peers.keys()].map((k) => {
          const i = k.lastIndexOf(':');
          return { ip: k.slice(0, i), port: +k.slice(i + 1) };
        }),
        sent, resp, valuesResp, nodes: seen.size + queried.size,
      });
    };
    const hard = setTimeout(finish, budgetMs);
    sock.on('error', finish);

    sock.on('message', (msg) => {
      let d;
      try { d = bdecode(msg).value; } catch { return; }
      if (!d || typeof d !== 'object') return;
      if ((Buffer.isBuffer(d.y) ? d.y.toString('latin1') : '') !== 'r' || !d.r) return;
      resp++;
      const r = d.r;
      if (r.values) {
        valuesResp++;
        for (const v of Array.isArray(r.values) ? r.values : [r.values]) {
          if (!Buffer.isBuffer(v)) continue;
          for (let o = 0; o + 6 <= v.length; o += 6) {
            const ip = `${v[o]}.${v[o + 1]}.${v[o + 2]}.${v[o + 3]}`;
            const port = v.readUInt16BE(o + 4);
            if (port > 0) peers.set(`${ip}:${port}`, 1);
          }
        }
      }
      if (Buffer.isBuffer(r.nodes)) {
        for (let o = 0; o + 26 <= r.nodes.length; o += 26) {
          const nid = r.nodes.slice(o, o + 20);
          const ip = `${r.nodes[o + 20]}.${r.nodes[o + 21]}.${r.nodes[o + 22]}.${r.nodes[o + 23]}`;
          const port = r.nodes.readUInt16BE(o + 24);
          if (!port || ip.startsWith('0.')) continue;
          const key = `${ip}:${port}`;
          if (!seen.has(key) && !queried.has(key)) seen.set(key, { ip, port, dist: xor20(nid, infoHash) });
        }
      }
    });

    const send = (h, p) => {
      const q = bencode({ t: crypto.randomBytes(2), y: 'q', q: 'get_peers', a: { id: myId, info_hash: infoHash } });
      sent++;
      try { sock.send(q, 0, q.length, p, h, () => {}); } catch {}
    };
    for (const [h, p] of BOOTSTRAP) send(h, p);

    // 迭代查询；路由表被限流清空时自动重新 bootstrap（否则探测会假性归零）
    const pump = setInterval(() => {
      if (done) return;
      if (peers.size >= 80) return finish();
      if (seen.size === 0) {
        if (reboot < 4) {
          reboot++;
          onLog?.(`  [DHT] 路由表空，第 ${reboot} 次重新 bootstrap`);
          for (const [h, p] of BOOTSTRAP) send(h, p);
        }
        return;
      }
      for (const [key, n] of [...seen.entries()].sort((a, b) => Buffer.compare(a[1].dist, b[1].dist)).slice(0, 12)) {
        seen.delete(key);
        queried.add(key);
        send(n.ip, n.port);
      }
    }, 250);
  });
}

// ─────────────── BEP3 握手 + BEP10 扩展 + BEP9 metadata ───────────────
function metaProbe(peer, infoHash, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const peerId = Buffer.concat([Buffer.from('-qB4500-'), crypto.randomBytes(12)]);
    const t0 = Date.now();
    let stage = 'connect', buf = Buffer.alloc(0);
    let handshaked = false, utMetaId = null, metaSize = 0, gotPiece = false;

    const s = net.connect({ host: peer.ip, port: peer.port, timeout: timeoutMs });
    const done = (res) => {
      clearTimeout(timer);
      try { s.destroy(); } catch {}
      resolve({ ...peer, ms: Date.now() - t0, stage, handshaked, metaSize, gotPiece, ...res });
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout@' + stage }), timeoutMs);

    s.on('connect', () => {
      stage = 'bt_handshake';
      const hs = Buffer.alloc(68);
      Buffer.from('\x13BitTorrent protocol', 'latin1').copy(hs, 0);
      hs[25] = 0x10; // BEP10 extension protocol
      infoHash.copy(hs, 28);
      peerId.copy(hs, 48);
      s.write(hs);
    });

    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshaked) {
        if (buf.length < 68) return;
        if (!buf.slice(28, 48).equals(infoHash)) return done({ ok: false, reason: 'wrong_infohash' });
        const supportsExt = (buf[25] & 0x10) !== 0;
        handshaked = true;
        buf = buf.slice(68);
        if (!supportsExt) return done({ ok: false, reason: 'no_bep10' });
        stage = 'ext_handshake';
        const payload = bencode({ m: { ut_metadata: 1 }, v: 'lele-probe/1.0' });
        const msg = Buffer.alloc(6 + payload.length);
        msg.writeUInt32BE(2 + payload.length, 0);
        msg[4] = 20; msg[5] = 0;
        payload.copy(msg, 6);
        s.write(msg);
      }

      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) { buf = buf.slice(4); continue; }
        if (buf.length < 4 + len) return;
        const body = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        if (body[0] !== 20) continue;
        const extId = body[1];
        const rest = body.slice(2);

        if (extId === 0) {
          let d;
          try { d = bdecode(rest).value; } catch { continue; }
          if (d?.m && typeof d.m.ut_metadata === 'number') utMetaId = d.m.ut_metadata;
          if (typeof d?.metadata_size === 'number') metaSize = d.metadata_size;
          if (utMetaId == null) return done({ ok: false, reason: 'peer_no_ut_metadata' });
          if (metaSize <= 0) return done({ ok: false, reason: 'peer_has_no_metadata' });
          stage = 'meta_request';
          const req = bencode({ msg_type: 0, piece: 0 });
          const m2 = Buffer.alloc(6 + req.length);
          m2.writeUInt32BE(2 + req.length, 0);
          m2[4] = 20; m2[5] = utMetaId;
          req.copy(m2, 6);
          s.write(m2);
        } else if (utMetaId != null) {
          let dec;
          try { dec = bdecode(rest); } catch { continue; }
          if (dec.value?.msg_type === 1) {
            gotPiece = true;
            return done({ ok: true, reason: 'metadata_piece_received', dataLen: rest.length - dec.consumed });
          }
          if (dec.value?.msg_type === 2) return done({ ok: false, reason: 'meta_reject' });
        }
      }
    });

    s.on('error', (e) => done({ ok: false, reason: 'tcp_error:' + (e.code || e.message) }));
    s.on('close', () => { if (!gotPiece) done({ ok: false, reason: 'closed@' + stage }); });
  });
}

// ───────────────────────── main ─────────────────────────
const raw = (process.argv[2] || '').trim();
const label = process.argv[3] || '';
const m = raw.match(/([0-9a-fA-F]{40})/);
if (!m) {
  console.log('用法: node scripts/magnet-probe.mjs "magnet:?xt=urn:btih:<hash>" [标签]');
  process.exit(1);
}
const hashHex = m[1].toUpperCase();
const infoHash = Buffer.from(hashHex, 'hex');

console.log('═'.repeat(60));
console.log(`  ${label || 'magnet 可下载性诊断'}`);
console.log(`  infohash: ${hashHex}`);
console.log('═'.repeat(60));

const r = await dhtGetPeers(infoHash, 35000, (s) => console.log(s));
console.log(`[DHT]  get_peers 发出 ${r.sent} / 响应 ${r.resp} / 命中 values ${r.valuesResp} / 路由节点 ${r.nodes}`);
console.log(`[DHT]  去重 peer: ${r.peers.length}`);

if (r.peers.length === 0) {
  console.log('\n[判定] ✗ 不可下载 — DHT 中无任何 peer，metadata 无来源');
  process.exit(0);
}

const sample = r.peers.slice(0, 30);
console.log(`\n[BEP9] 对 ${sample.length} 个 peer 做扩展握手 + metadata 请求...`);
const res = await Promise.all(sample.map((p) => metaProbe(p, infoHash, 12000)));

const btOk = res.filter((x) => x.handshaked);
const withMeta = res.filter((x) => x.metaSize > 0);
const gotData = res.filter((x) => x.gotPiece);

console.log(`  BT 握手成功       : ${btOk.length}/${sample.length}`);
console.log(`  声明持有 metadata : ${withMeta.length}`);
console.log(`  实际交付 metadata : ${gotData.length}`);
for (const x of gotData.slice(0, 6)) {
  console.log(`    ✓ ${x.ip}:${x.port}  metadata_size=${x.metaSize}B  片=${x.dataLen}B  ${x.ms}ms`);
}
for (const x of withMeta.filter((v) => !v.gotPiece).slice(0, 5)) {
  console.log(`    ~ ${x.ip}:${x.port}  声明 size=${x.metaSize} 未交付 (${x.reason})`);
}
const byReason = {};
for (const x of res.filter((v) => !v.gotPiece)) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
console.log('  失败原因分布:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`    × ${k} x${v}`);

console.log('');
if (gotData.length > 0) {
  console.log(`[判定] ✓ 可下载 — ${gotData.length} 个 peer 成功交付 metadata (size=${gotData[0].metaSize}B)`);
} else if (withMeta.length > 0) {
  console.log('[判定] △ 临界 — 有 peer 声明持有 metadata 但拒绝/超时未交付，成功率极低');
} else if (btOk.length > 0) {
  console.log('[判定] ✗ 不可下载 — peer 能握手但都不持有 metadata（同为等待中的下载者，无做种者）');
} else {
  console.log(`[判定] ✗ 不可下载 — DHT 有 ${r.peers.length} 条 peer 记录但 0 个可建立连接（陈旧记录/DHT 污染节点）`);
}
process.exit(0);
