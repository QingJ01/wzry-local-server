#!/usr/bin/env node
// In-place single-dword patch of resources.arsc inside a signed-source APK copy.
// Rewrites UTF-16LE bytes at a fixed arsc offset, recomputes the STORED entry
// CRC-32 in both local file header and central directory record, then exits.
// Everything else in the file is byte-identical to the input copy.
// The APK must be re-signed afterwards (v2/v3 digest covers resources.arsc).
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const [,, apkPath, entryName, offsetStr, origHex, replHex] = process.argv;
if (!apkPath || !entryName || !offsetStr || !origHex || !replHex) {
  console.error('usage: node patch_arsc_inplace.mjs <apk> <entry> <offset> <origHex> <replHex>');
  process.exit(2);
}
const patchOffset = Number(offsetStr);
const orig = Buffer.from(origHex, 'hex');
const repl = Buffer.from(replHex, 'hex');
if (orig.length !== repl.length) throw new Error('length mismatch');

const fd = fs.openSync(apkPath, 'r+');
const stat = fs.fstatSync(fd);
const fileSize = stat.size;

// Locate EOCD.
const tail = Buffer.alloc(Math.min(fileSize, 66000));
fs.readSync(fd, tail, 0, tail.length, fileSize - tail.length);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('EOCD not found');
const cdCount = tail.readUInt16LE(eocd + 10);
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOff = tail.readUInt32LE(eocd + 16);
const cdBuf = Buffer.alloc(cdSize);
fs.readSync(fd, cdBuf, 0, cdSize, cdOff);

// Find central directory record for the target entry.
let p = 0;
let found = null;
for (let k = 0; k < cdCount; k++) {
  if (cdBuf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad CD sig at rec ${k}`);
  const nl = cdBuf.readUInt16LE(p + 28);
  const el = cdBuf.readUInt16LE(p + 30);
  const cl = cdBuf.readUInt16LE(p + 32);
  const name = cdBuf.toString('utf8', p + 46, p + 46 + nl);
  if (name === entryName) {
    found = {
      cdFileOff: cdOff + p,
      method: cdBuf.readUInt16LE(p + 10),
      comp: cdBuf.readUInt32LE(p + 20),
      unc: cdBuf.readUInt32LE(p + 24),
      oldCrc: cdBuf.readUInt32LE(p + 16),
      lho: cdBuf.readUInt32LE(p + 42),
    };
    break;
  }
  p += 46 + nl + el + cl;
}
if (!found) throw new Error(`entry not found: ${entryName}`);
if (found.method !== 0) throw new Error(`entry not STORED: method=${found.method}`);
if (found.comp !== found.unc) throw new Error('stored size mismatch');

// Parse local header, compute data start.
const lh = Buffer.alloc(30);
fs.readSync(fd, lh, 0, 30, found.lho);
if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header sig');
const dataOff = found.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
const lfhCrc = lh.readUInt32LE(14);
if (lfhCrc !== found.oldCrc) throw new Error(`lfh/cd crc mismatch ${lfhCrc} vs ${found.oldCrc}`);

// Verify original bytes at patch site.
const probe = Buffer.alloc(orig.length);
fs.readSync(fd, probe, 0, orig.length, dataOff + patchOffset);
if (!probe.equals(orig)) {
  throw new Error(`original bytes mismatch at arsc+0x${patchOffset.toString(16)}: got ${probe.toString('hex')}`);
}

// Stream full entry, apply patch in memory region, compute CRC-32.
let crc = 0xffffffff;
const CHUNK = 4 * 1024 * 1024;
const chunk = Buffer.alloc(CHUNK);
let pos = 0;
let patchedBytes = null;
while (pos < found.unc) {
  const want = Math.min(CHUNK, found.unc - pos);
  fs.readSync(fd, chunk, 0, want, dataOff + pos);
  const rel = patchOffset - pos;
  if (rel >= 0 && rel < want) {
    repl.copy(chunk, rel);
    patchedBytes = Buffer.from(chunk.subarray(rel, rel + repl.length));
  }
  for (let i = 0; i < want; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  pos += want;
}
crc = (crc ^ 0xffffffff) >>> 0;
if (!patchedBytes || !patchedBytes.equals(repl)) throw new Error('patch application failed in stream');

// Write patched bytes at patch site.
fs.writeSync(fd, repl, 0, repl.length, dataOff + patchOffset);

// Write new CRC into local file header (+14) and central directory record (+16).
const crcBuf = Buffer.alloc(4);
crcBuf.writeUInt32LE(crc >>> 0);
fs.writeSync(fd, crcBuf, 0, 4, found.lho + 14);
fs.writeSync(fd, crcBuf, 0, 4, found.cdFileOff + 16);

fs.closeSync(fd);
console.log(JSON.stringify({
  entry: entryName,
  patchOffset,
  dataOff,
  absPatchOff: dataOff + patchOffset,
  oldCrc: found.oldCrc.toString(16),
  newCrc: crc.toString(16),
  cdFileOff: found.cdFileOff,
}));
