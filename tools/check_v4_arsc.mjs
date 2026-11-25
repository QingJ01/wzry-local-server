#!/usr/bin/env node
// Verify arsc package group name inside an APK (random access, no full extraction).
import fs from 'node:fs';

const apk = process.argv[2];
const fd = fs.openSync(apk, 'r');
const sz = fs.fstatSync(fd).size;
const tail = Buffer.alloc(Math.min(sz, 66000));
fs.readSync(fd, tail, 0, tail.length, sz - tail.length);
let eo = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
}
const cs = tail.readUInt32LE(eo + 12);
const co = tail.readUInt32LE(eo + 16);
const cd = Buffer.alloc(cs);
fs.readSync(fd, cd, 0, cs, co);
let p = 0, t = null;
while (p < cd.length - 46) {
  if (cd.readUInt32LE(p) !== 0x02014b50) break;
  const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
  const nm = cd.toString('utf8', p + 46, p + 46 + nl);
  if (nm === 'resources.arsc') {
    t = { comp: cd.readUInt32LE(p + 20), lho: cd.readUInt32LE(p + 42) };
    break;
  }
  p += 46 + nl + el + cl;
}
const lh = Buffer.alloc(30);
fs.readSync(fd, lh, 0, 30, t.lho);
const dOff = t.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
const buf = Buffer.alloc(t.comp);
fs.readSync(fd, buf, 0, t.comp, dOff);
fs.closeSync(fd);

const tableHeaderSize = buf.readUInt16LE(2);
// After ResTable_header comes the global string pool chunk; package chunk follows it.
const poolOff = tableHeaderSize;
const poolSize = buf.readUInt32LE(poolOff + 4);
const pkgOff = poolOff + poolSize;
const chunkType = buf.readUInt16LE(pkgOff);
const id = buf.readUInt32LE(pkgOff + 8);
let name = '';
for (let i = 0; i < 128; i++) {
  const ch = buf.readUInt16LE(pkgOff + 12 + i * 2);
  if (ch === 0) break;
  name += String.fromCharCode(ch);
}
console.log('package chunk type=0x' + chunkType.toString(16) +
  ' id=0x' + id.toString(16) +
  ' name=[' + name + ']');
console.log('bytes@0xCBC6=' + buf.subarray(52166, 52168).toString('hex'));
