#!/usr/bin/env node
// Rebuild an APK applying equal-length native byte patches, preserving source
// entry order and writing true ZIP methods: Stored (0) for lib/*, assets/*,
// resources.arsc; Deflate (8) for everything else. Pure Node (zlib only).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const sourceApk = arg('--source');
const manifestPath = arg('--manifest');
const outputApk = arg('--out');
if (!sourceApk || !manifestPath || !outputApk) {
  console.error('usage: node build_native_patch_apk.mjs --source <apk> --manifest <json> --out <apk>');
  process.exit(2);
}

const STORED = (name) => name === 'resources.arsc' || name.startsWith('lib/') || name.startsWith('assets/');

const fd = fs.openSync(sourceApk, 'r');
const stat = fs.fstatSync(fd);
const fileSize = stat.size;
// Locate EOCD (scan last 64KB+22).
const tail = Buffer.alloc(Math.min(fileSize, 66000));
fs.readSync(fd, tail, 0, tail.length, fileSize - tail.length);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('EOCD not found'); process.exit(1); }
const cdCount = tail.readUInt16LE(eocd + 10);
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOff = tail.readUInt32LE(eocd + 16);
const cdBuf = Buffer.alloc(cdSize);
fs.readSync(fd, cdBuf, 0, cdSize, cdOff);

// Parse central directory (preserve order).
const entries = [];
let p = 0;
while (p + 46 <= cdBuf.length && entries.length < cdCount) {
  if (cdBuf.readUInt32LE(p) !== 0x02014b50) break;
  const method = cdBuf.readUInt16LE(p + 10);
  const comp = cdBuf.readUInt32LE(p + 20);
  const unc = cdBuf.readUInt32LE(p + 24);
  const nl = cdBuf.readUInt16LE(p + 28);
  const el = cdBuf.readUInt16LE(p + 30);
  const cl = cdBuf.readUInt16LE(p + 32);
  const lho = cdBuf.readUInt32LE(p + 42);
  const name = cdBuf.subarray(p + 46, p + 46 + nl).toString('utf8');
  entries.push({ name, method, comp, unc, lho });
  p += 46 + nl + el + cl;
}

// Read + decompress an entry payload.
function readEntry(e) {
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, e.lho);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header @${e.lho} ${e.name}`);
  const nl = lh.readUInt16LE(26), el = lh.readUInt16LE(28);
  const dataOff = e.lho + 30 + nl + el;
  const comp = Buffer.alloc(e.comp);
  fs.readSync(fd, comp, 0, e.comp, dataOff);
  return e.method === 0 ? comp : zlib.inflateRawSync(comp);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const patches = manifest.nativePatches || manifest.patches || [];
const patchByEntry = new Map();
for (const sp of patches) {
  if (!patchByEntry.has(sp.entryPath)) patchByEntry.set(sp.entryPath, []);
  patchByEntry.get(sp.entryPath).push(sp);
}

const out = fs.createWriteStream(outputApk);
const centrals = [];
let outOff = 0;
const results = [];

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

for (const e of entries) {
  let data = readEntry(e);
  const origSha = crypto.createHash('sha256').update(data).digest('hex');
  const specs = patchByEntry.get(e.name);
  if (specs) {
    for (const sp of specs) {
      const ob = Buffer.from(sp.originalBytesHex.replace(/\s/g, ''), 'hex');
      const rb = Buffer.from(sp.replacementBytesHex.replace(/\s/g, ''), 'hex');
      if (ob.length !== rb.length) throw new Error(`length mismatch ${sp.entryPath}`);
      const off = Number(sp.offset);
      if (!data.subarray(off, off + ob.length).equals(ob)) throw new Error(`original bytes mismatch @${off} ${e.name}`);
      rb.copy(data, off);
    }
  }
  const store = STORED(e.name);
  const outMethod = store ? 0 : 8;
  const payload = store ? data : zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const nameBuf = Buffer.from(e.name, 'utf8');
  // local header (no data descriptor: crc/sizes set in header)
  const lh = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(outMethod), u16(0), u16(0),
    u32(crc), u32(payload.length), u32(data.length), u16(nameBuf.length), u16(0),
  ]);
  out.write(lh); out.write(nameBuf); out.write(payload);
  centrals.push({ name: nameBuf, method: outMethod, crc, comp: payload.length, unc: data.length, lho: outOff });
  outOff += lh.length + nameBuf.length + payload.length;
  const patchSha = crypto.createHash('sha256').update(data).digest('hex');
  results.push({ name: e.name, method: outMethod, origSha, patchSha, changed: !!specs });
}

const cdStart = outOff;
for (const c of centrals) {
  const cd = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(c.method), u16(0), u16(0),
    u32(c.crc), u32(c.comp), u32(c.unc), u16(c.name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(c.lho),
  ]);
  out.write(cd); out.write(c.name); outOff += cd.length + c.name.length;
}
const cdLen = outOff - cdStart;
out.write(Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
  u32(cdLen), u32(cdStart), u16(0),
]));
out.end(() => {
  fs.closeSync(fd);
  const changed = results.filter(r => r.changed);
  console.log(`wrote ${outputApk} entries=${results.length} patched=${changed.length}`);
  for (const c of changed) console.log(`  ${c.name} orig=${c.origSha.slice(0,16)} patched=${c.patchSha.slice(0,16)}`);
});
