/*
 * scan_apk_component_refs.mjs
 *
 * Static scanner answering one narrow question with byte-level evidence:
 *
 *   Does a given APK contain any reference to a target package / component /
 *   string token (e.g. "com.tencent.xfight", "com.shenyi.local.BootActivity",
 *   "shenyi", "xfight") anywhere in its zip entries?
 *
 * It scans every zip entry (STORED or DEFLATED), including all classesN.dex,
 * resources.arsc, AndroidManifest.xml, embedded assets, and embedded APKs'
 * raw bytes. It does not recurse into nested zips, but reports their presence
 * so a human can re-run the tool against them after extraction.
 *
 * Output: JSON report with per-target hits, file offsets and printable
 * context windows, plus scan coverage statistics so an empty result is
 * meaningful (i.e. you can prove the scan covered N/M bytes).
 *
 * Usage:
 *   node tools/scan_apk_component_refs.mjs <apk> [--target string ...]
 *       [--max-entry-mb N] [--out report.json]
 *
 * Read-only. No device access. Exit code 0 unless usage/IO error.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

function usage(exitCode) {
  console.error('usage: node scan_apk_component_refs.mjs <apk> [--target s ...] [--max-entry-mb N] [--out report.json]');
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.length === 0) usage(2);

const apkPath = path.resolve(args[0]);
const targets = [];
let maxEntryMb = 512;
let outPath = null;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--target' && i + 1 < args.length) {
    targets.push(args[++i]);
  } else if (a === '--max-entry-mb' && i + 1 < args.length) {
    maxEntryMb = Number(args[++i]);
  } else if (a === '--out' && i + 1 < args.length) {
    outPath = path.resolve(args[++i]);
  } else {
    console.error('unknown/incomplete arg:', a);
    usage(2);
  }
}

if (targets.length === 0) {
  targets.push('com.tencent.xfight', 'xfight', 'shenyi', 'com.shenyi.local');
}

if (!fs.existsSync(apkPath)) {
  console.error('apk not found:', apkPath);
  process.exit(2);
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const OVERLAP = 256;

function parseCentralDirectory(fd, fileSize) {
  const tailSize = Math.min(fileSize, 1024 * 1024);
  const tail = Buffer.alloc(tailSize);
  fs.readSync(fd, tail, 0, tailSize, fileSize - tailSize, 0);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found - not a zip/apk?');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff, 0);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== CD_SIG) throw new Error(`bad central-dir sig at entry ${i}`);
    entries.push({
      name: cd.slice(p + 46, p + 46 + cd.readUInt16LE(p + 28)).toString(),
      method: cd.readUInt16LE(p + 10),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      lho: cd.readUInt32LE(p + 42),
    });
    p += 46 + cd.readUInt16LE(p + 28) + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  return entries;
}

function entryDataOffset(fd, lho) {
  const lh = Buffer.alloc(30);
  fs.readSync(fd, lh, 0, 30, lho, 0);
  return lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
}

function printable(buf) {
  return buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
}

function scanBuffer(raw, needleBufs, capPerEntry = 40) {
  const hits = [];
  for (const [label, needle] of needleBufs) {
    let idx = raw.indexOf(needle);
    while (idx >= 0 && hits.length < capPerEntry) {
      const ctx = printable(raw.slice(Math.max(0, idx - 60), idx + needle.length + 120));
      hits.push({ target: label, offset: '0x' + idx.toString(16), context: ctx });
      idx = raw.indexOf(needle, idx + 1);
    }
  }
  return hits;
}

function scanStoredChunked(fd, dataOff, csize, needleBufs, capPerEntry = 40) {
  const hits = [];
  const CH = 4 * 1024 * 1024;
  let pos = 0;
  let carry = Buffer.alloc(0);
  while (pos < csize && hits.length < capPerEntry) {
    const len = Math.min(CH, csize - pos);
    const buf = Buffer.alloc(carry.length + len);
    carry.copy(buf, 0);
    fs.readSync(fd, buf, carry.length, len, dataOff + pos, 0);
    const baseOffset = pos - carry.length;
    for (const [label, needle] of needleBufs) {
      let idx = buf.indexOf(needle);
      while (idx >= 0 && hits.length < capPerEntry) {
        const ctx = printable(buf.slice(Math.max(0, idx - 60), idx + needle.length + 120));
        hits.push({ target: label, offset: '0x' + (baseOffset + idx).toString(16), context: ctx });
        idx = buf.indexOf(needle, idx + 1);
      }
    }
    carry = buf.slice(Math.max(0, buf.length - OVERLAP));
    pos += len;
  }
  return hits;
}

async function main() {
  const fd = fs.openSync(apkPath, 'r');
  const fileSize = fs.fstatSync(fd).size;
  const entries = parseCentralDirectory(fd, fileSize);
  const needleBufs = targets.map((t) => [t, Buffer.from(t, 'utf8')]);
  const maxEntryBytes = maxEntryMb * 1024 * 1024;

  const report = {
    apk: apkPath,
    sha256: null,
    fileSize,
    entryCount: entries.length,
    targets,
    coverage: {
      entriesScanned: 0,
      entriesSkipped: [],
      bytesScannedCompressed: 0,
      nestedZipsNotRecursed: [],
    },
    hits: [],
    verdict: null,
  };

  const skipped = [];
  for (const e of entries) {
    if (/\.(apk|zip)$/i.test(e.name)) report.coverage.nestedZipsNotRecursed.push(e.name);
    if (e.csize > maxEntryBytes) {
      skipped.push({ name: e.name, csize: e.csize, reason: `exceeds --max-entry-mb ${maxEntryMb}` });
      continue;
    }
    const dataOff = entryDataOffset(fd, e.lho);
    let entryHits = [];
    if (e.method === 0) {
      if (e.csize > 64 * 1024 * 1024) {
        entryHits = scanStoredChunked(fd, dataOff, e.csize, needleBufs);
      } else {
        const raw = Buffer.alloc(e.csize);
        fs.readSync(fd, raw, 0, e.csize, dataOff, 0);
        entryHits = scanBuffer(raw, needleBufs);
      }
    } else if (e.method === 8) {
      const cbuf = Buffer.alloc(e.csize);
      fs.readSync(fd, cbuf, 0, e.csize, dataOff, 0);
      try {
        const raw = zlib.inflateRawSync(cbuf);
        entryHits = scanBuffer(raw, needleBufs);
      } catch {
        skipped.push({ name: e.name, csize: e.csize, reason: 'inflate failure' });
        continue;
      }
    } else {
      skipped.push({ name: e.name, csize: e.csize, reason: `unknown method ${e.method}` });
      continue;
    }
    report.coverage.entriesScanned++;
    report.coverage.bytesScannedCompressed += e.csize;
    for (const h of entryHits) report.hits.push({ entry: e.name, ...h });
  }
  report.coverage.entriesSkipped = skipped;
  fs.closeSync(fd);

  const crypto = await import('node:crypto');
  report.sha256 = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(apkPath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex').toUpperCase()));
    s.on('error', reject);
  });

  report.verdict = report.hits.length === 0
    ? `NO_MATCH: none of the ${targets.length} target strings appear in any of the ${report.coverage.entriesScanned} scanned entries`
    : `MATCH: ${report.hits.length} hit(s) across entries`;

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, json);
    console.log('written:', outPath);
  } else {
    console.log(json);
  }
  console.error(report.verdict);
}

main().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
