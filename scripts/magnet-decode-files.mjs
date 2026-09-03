#!/usr/bin/env node
/**
 * magnet-decode-files.mjs — 取回磁力原始 metadata 并解码文件清单
 *
 * 与 magnet-probe.mjs 同源（BEP5 DHT + BEP3 握手 + BEP10 + BEP9 ut_metadata），
 * 但目标是把真实的 info dict 取回来 bencode 解码，打印完整文件清单，
 * 并标出哪个文件名含路径分隔符（触发 librqbit `suspicious separator in filename` 拒解析）。
 *
 * 用法:
 *   node scripts/magnet-decode-files.mjs "magnet:?xt=urn:btih:<hash>" [标签]
 *   node scripts/magnet-decode-files.mjs <40位infohash> [标签]
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

// bdecode：字节串一律以 Buffer 返回，显示时再转 utf8
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

const buf2str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b));

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

// ─────────────── BEP3 握手 + BEP10 扩展 + BEP9 metadata（取回原始字节）───────────────
function metaFetch(peer, infoHash, timeoutMs = 15000) {
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
        const payload = bencode({ m: { ut_metadata: 1 }, v: 'lele-decode/1.0' });
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
            const data = rest.slice(dec.consumed);
            return done({ ok: true, reason: 'metadata_piece_received', metadata: data });
          }
          if (dec.value?.msg_type === 2) return done({ ok: false, reason: 'meta_reject' });
        }
      }
    });

    s.on('error', (e) => done({ ok: false, reason: 'tcp_error:' + (e.code || e.message) }));
    s.on('close', () => { if (!gotPiece) done({ ok: false, reason: 'closed@' + stage }); });
  });
}

// ───────────────────────── 解码文件清单 ─────────────────────────
function decodeFileList(info) {
  const name = buf2str(info.name);
  const files = [];
  if (Array.isArray(info.files)) {
    // 多文件：每个 entry 有 length + path（组件数组）
    for (const f of info.files) {
      const comps = (f.path || []).map(buf2str);
      files.push({ length: Number(f.length), components: comps });
    }
  } else {
    // 单文件
    files.push({ length: Number(info.length), components: [] });
  }
  return { name, files };
}

function sepFlag(comps) {
  return comps.some((c) => c.includes('/') || c.includes('\\'));
}

// ───────────────────────── main ─────────────────────────
const raw = (process.argv[2] || '').trim();
const label = process.argv[3] || '';
const m = raw.match(/([0-9a-fA-F]{40})/);
if (!m) {
  console.log('用法: node scripts/magnet-decode-files.mjs "magnet:?xt=urn:btih:<hash>" [标签]');
  process.exit(1);
}
const hashHex = m[1].toUpperCase();
const infoHash = Buffer.from(hashHex, 'hex');

console.log('═'.repeat(64));
console.log(`  ${label || 'magnet 文件清单解码'}`);
console.log(`  infohash: ${hashHex}`);
console.log('═'.repeat(64));

const r = await dhtGetPeers(infoHash, 35000, (s) => console.log(s));
console.log(`[DHT] 去重 peer: ${r.peers.length}`);
if (r.peers.length === 0) {
  console.log('\n[结果] ✗ 无 peer，取不到 metadata');
  process.exit(1);
}

console.log(`[BEP9] 依次向 peer 请求 metadata（取到即停）...`);
let meta = null, who = null;
for (const p of r.peers.slice(0, 30)) {
  const res = await metaFetch(p, infoHash, 15000);
  if (res.ok && res.metadata) {
    meta = res.metadata; who = `${res.ip}:${res.port} (${res.ms}ms)`;
    break;
  }
}
if (!meta) {
  console.log('\n[结果] ✗ 30 个 peer 均未成功交付 metadata');
  process.exit(1);
}

const info = bdecode(meta).value;
const { name, files } = decodeFileList(info);
const total = files.reduce((a, f) => a + f.length, 0);
const flagged = files.map((f) => sepFlag(f.components));
const badCount = flagged.filter(Boolean).length;

console.log(`\n来源 peer     : ${who}`);
console.log(`种子名        : ${name}`);
console.log(`info_hash     : ${hashHex}`);
console.log(`metadata 字节 : ${meta.length}B`);
console.log(`文件数        : ${files.length}`);
console.log(`总大小        : ${(total / 1024 / 1024).toFixed(2)} MiB (${total} B)`);
console.log(`含分隔符文件  : ${badCount} 个 ${badCount > 0 ? '← librqbit 会因此拒解析' : ''}`);
console.log('\n文件清单:');
files.forEach((f, idx) => {
  const pathStr = files.length === 1 ? name : [name, ...f.components].join('/');
  const flag = flagged[idx] ? '  ⚠ 含路径分隔符 → 触发 suspicious separator' : '';
  console.log(`  #${idx}  ${(f.length / 1024).toFixed(2)} KiB  ${pathStr}${flag}`);
});

if (badCount > 0) {
  console.log('\n[结论] 该磁力因含分隔符的文件名被 librqbit 安全校验拒解析，LeLeDownload 不可用。');
  console.log('       若要做"落盘时洗路径"让这类种子可用，需独立小项目（保持 info_hash 不变）。');
} else {
  console.log('\n[结论] 未发现含分隔符的文件名，理论上 librqbit 可解析。');
}

// 把原始 metadata 也落盘，方便复算/复用
import { writeFileSync } from 'node:fs';
const outName = `/tmp/meta_${hashHex}.bin`;
try { writeFileSync(outName, meta); console.log(`\n[debug] 原始 metadata 已存: ${outName}`); } catch {}
process.exit(0);
