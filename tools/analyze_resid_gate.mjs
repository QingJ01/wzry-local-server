#!/usr/bin/env node
/**
 * analyze_resid_gate.mjs — static analyzer for the sgamx resource-license gate.
 *
 * Evidence chain target:
 *   com.tencent.msdk.tools.ResID.loadIdentifierResource (classes2.dex)
 *     -> Resources.getIdentifier(name, type, pkg)
 *     -> if id == 0: print "Resource %s(type=%s, pkg=%s) is not found" then System.exit(-1)
 *
 * This tool:
 *   1. Parses dex files structurally (header, string ids, type ids, proto/field/method ids, class defs, code items).
 *   2. Locates every class named *ResID* and dumps the smali-level instruction stream of loadIdentifierResource,
 *      with exact file offsets for the System.exit invoke and the const-string instructions.
 *   3. Locates WebViewResID.init which passes "smobawebviewlayout"/"smobawebview_webview".
 *   4. Parses resources.arsc (RES_TABLE_TYPE_SPEC / RES_TABLE_TYPE) and lists every layout/id entry name,
 *      proving whether smobawebview* entries exist at all.
 *   5. Emits workspace/analysis/resid_gate/resid_gate_analysis.json.
 *
 * Pure Node, no dependencies. Read-only against the APK extraction dir.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const sgamxDir = path.join(root, 'workspace', 'analysis', 'sgamx_v3');
const outDir = path.join(root, 'workspace', 'analysis', 'resid_gate');
fs.mkdirSync(outDir, { recursive: true });

function readU16(b, o) { return b.readUInt16LE(o); }
function readS16(b, o) { return b.readInt16LE(o); }
function readU32(b, o) { return b.readUInt32LE(o); }
function readS32(b, o) { return b.readInt32LE(o); }

function uleb128(b, o) {
  let result = 0, shift = 0, pos = o;
  for (;;) {
    const byte = b[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: pos };
}

function readMutf8(b, o) {
  const lenInfo = uleb128(b, o);
  let pos = lenInfo.next;
  const start = pos;
  while (b[pos] !== 0) pos++;
  return { str: b.toString('utf8', start, pos), dataOffset: start, endOffset: pos };
}

function readSleb128(b, o) {
  let result = 0, shift = 0, pos = o, byte;
  do {
    byte = b[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && (byte & 0x40)) result |= -(1 << shift);
  return { value: result | 0, next: pos };
}

const OP_WIDTHS = (() => {
  const t = {};
  for (let op = 0x90; op <= 0xaf; op++) t[op] = 2;
  for (let op = 0xb0; op <= 0xcf; op++) t[op] = 1;
  for (let op = 0xd0; op <= 0xe2; op++) t[op] = 2;
  return t;
})();

function protoSig(p) {
  if (!p) return '()';
  return `ret=${p.returnType}`;
}

function parseDex(file) {
  const buf = fs.readFileSync(file);
  const magic = buf.toString('latin1', 0, 8);
  if (!magic.startsWith('dex\n')) throw new Error(`${file}: not a dex (magic=${magic})`);
  const h = {
    stringIdsSize: readU32(buf, 0x38), stringIdsOff: readU32(buf, 0x3c),
    typeIdsSize: readU32(buf, 0x40), typeIdsOff: readU32(buf, 0x44),
    protoIdsSize: readU32(buf, 0x48), protoIdsOff: readU32(buf, 0x4c),
    fieldIdsSize: readU32(buf, 0x50), fieldIdsOff: readU32(buf, 0x54),
    methodIdsSize: readU32(buf, 0x58), methodIdsOff: readU32(buf, 0x5c),
    classDefsSize: readU32(buf, 0x60), classDefsOff: readU32(buf, 0x64),
  };

  const strings = new Array(h.stringIdsSize);
  for (let i = 0; i < h.stringIdsSize; i++) {
    const dataOff = readU32(buf, h.stringIdsOff + i * 4);
    const { str, endOffset } = readMutf8(buf, dataOff);
    strings[i] = { str, offset: dataOff, endOffset };
  }
  const stringIndexByValue = new Map();
  strings.forEach((s, i) => { if (!stringIndexByValue.has(s.str)) stringIndexByValue.set(s.str, i); });

  const types = new Array(h.typeIdsSize);
  for (let i = 0; i < h.typeIdsSize; i++) types[i] = strings[readU32(buf, h.typeIdsOff + i * 4)].str;

  const protos = new Array(h.protoIdsSize);
  for (let i = 0; i < h.protoIdsSize; i++) {
    const o = h.protoIdsOff + i * 12;
    protos[i] = {
      shorty: strings[readU32(buf, o)].str,
      returnType: types[readU32(buf, o + 4)],
      paramsOff: readU32(buf, o + 8),
    };
  }

  const fields = new Array(h.fieldIdsSize);
  for (let i = 0; i < h.fieldIdsSize; i++) {
    const o = h.fieldIdsOff + i * 8;
    fields[i] = {
      classType: types[readU16(buf, o)],
      type: types[readU16(buf, o + 2)],
      name: strings[readU32(buf, o + 4)].str,
    };
  }

  const methods = new Array(h.methodIdsSize);
  for (let i = 0; i < h.methodIdsSize; i++) {
    const o = h.methodIdsOff + i * 8;
    methods[i] = {
      classType: types[readU16(buf, o)],
      proto: protos[readU16(buf, o + 2)],
      name: strings[readU32(buf, o + 4)].str,
    };
  }

  const classes = [];
  for (let ci = 0; ci < h.classDefsSize; ci++) {
    const o = h.classDefsOff + ci * 32;
    const def = {
      index: ci,
      type: types[readU32(buf, o)],
      accessFlags: readU32(buf, o + 4),
      superclass: readU32(buf, o + 8) === 0xffffffff ? null : types[readU32(buf, o + 8)],
      classDataOff: readU32(buf, o + 24),
      methods: [],
    };
    if (def.classDataOff !== 0) {
      let pos = def.classDataOff;
      const sf = uleb128(buf, pos); pos = sf.next;
      const inf = uleb128(buf, pos); pos = inf.next;
      const dm = uleb128(buf, pos); pos = dm.next;
      const vm = uleb128(buf, pos); pos = vm.next;
      for (let k = 0; k < sf.value + inf.value; k++) {
        const d = uleb128(buf, pos); pos = d.next;
        const a = uleb128(buf, pos); pos = a.next;
      }
      const readMethods = (count, kind) => {
        let mi = 0;
        for (let k = 0; k < count; k++) {
          const d = uleb128(buf, pos); mi += d.value; pos = d.next;
          const a = uleb128(buf, pos); pos = a.next;
          const c = uleb128(buf, pos); pos = c.next;
          def.methods.push({ kind, index: mi, ...methods[mi], accessFlags: a.value, codeOff: c.value });
        }
      };
      readMethods(dm.value, 'direct');
      readMethods(vm.value, 'virtual');
    }
    classes.push(def);
  }

  function decodeCode(codeOff) {
    if (codeOff === 0) return null;
    const insnsSize = readU32(buf, codeOff + 12);
    const insnsOff = codeOff + 16;
    const insns = [];
    let pc = 0;
    while (pc < insnsSize * 2) {
      const abs = insnsOff + pc;
      const op = buf[abs];
      const a = buf[abs + 1];
      const insn = { pc, offset: abs, op, mnemonic: `op${op.toString(16)}`, size: 1 };
      const u16at = (u) => readU16(buf, abs + u * 2);
      switch (op) {
        case 0x00: insn.mnemonic = 'nop'; break;
        case 0x0a: insn.mnemonic = `move-result v${a}`; break;
        case 0x0b: insn.mnemonic = 'move-result-wide'; break;
        case 0x0c: insn.mnemonic = `move-result-object v${a}`; break;
        case 0x0e: insn.mnemonic = 'return-void'; break;
        case 0x0f: insn.mnemonic = `return v${a}`; break;
        case 0x10: insn.mnemonic = 'return-wide'; break;
        case 0x11: insn.mnemonic = `return-object v${a}`; break;
        case 0x12: insn.mnemonic = `const/4 v${a & 0xf}, #${(a << 28) >> 28 >> 4}`; break;
        case 0x13: insn.mnemonic = `const/16 v${a}, #${readS16(buf, abs + 2)}`; insn.size = 2; break;
        case 0x14: insn.mnemonic = `const v${a}, #${readS32(buf, abs + 2)}`; insn.size = 3; break;
        case 0x15: insn.mnemonic = 'const/high16'; insn.size = 2; break;
        case 0x16: insn.mnemonic = 'const-wide/16'; insn.size = 2; break;
        case 0x17: insn.mnemonic = 'const-wide/32'; insn.size = 3; break;
        case 0x18: insn.mnemonic = 'const-wide'; insn.size = 5; break;
        case 0x19: insn.mnemonic = 'const-wide/high16'; insn.size = 2; break;
        case 0x1a: {
          const si = u16at(1);
          insn.mnemonic = `const-string v${a}, "${strings[si]?.str}"`;
          insn.size = 2; insn.stringIndex = si;
          break;
        }
        case 0x1b: {
          const si = readU32(buf, abs + 2);
          insn.mnemonic = `const-string/jumbo v${a}, "${strings[si]?.str}"`;
          insn.size = 3; insn.stringIndex = si;
          break;
        }
        case 0x1c: insn.mnemonic = `const-class v${a}, ${types[u16at(1)]}`; insn.size = 2; break;
        case 0x1d: insn.mnemonic = 'monitor-enter'; break;
        case 0x1e: insn.mnemonic = 'monitor-exit'; break;
        case 0x1f: insn.mnemonic = 'check-cast'; insn.size = 2; break;
        case 0x20: insn.mnemonic = 'instance-of'; insn.size = 2; break;
        case 0x21: insn.mnemonic = 'array-length'; break;
        case 0x22: insn.mnemonic = `new-instance v${a}, ${types[u16at(1)]}`; insn.size = 2; break;
        case 0x23: insn.mnemonic = 'new-array'; insn.size = 2; break;
        case 0x24: insn.mnemonic = 'filled-new-array'; insn.size = 3; break;
        case 0x25: insn.mnemonic = 'filled-new-array/range'; insn.size = 3; break;
        case 0x26: insn.mnemonic = 'fill-array-data'; insn.size = 3; break;
        case 0x27: insn.mnemonic = `throw v${a}`; break;
        case 0x28: insn.mnemonic = `goto +${(buf[abs + 1] << 24) >> 24}`; break;
        case 0x29: insn.mnemonic = `goto/16 +${readS16(buf, abs + 2)}`; insn.size = 2; break;
        case 0x2a: insn.mnemonic = 'goto/32'; insn.size = 3; break;
        case 0x2b: insn.mnemonic = 'packed-switch'; insn.size = 3; break;
        case 0x2c: insn.mnemonic = 'sparse-switch'; insn.size = 3; break;
        case 0x2d: case 0x2e: case 0x2f: case 0x30: case 0x31:
          insn.mnemonic = 'cmp'; insn.size = 2; break;
        case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: {
          const names = ['if-eq', 'if-ne', 'if-lt', 'if-ge', 'if-gt', 'if-le'];
          insn.mnemonic = `${names[op - 0x32]} v${a & 0xf}, v${(a >> 4) & 0xf}, +${readS16(buf, abs + 2)}`;
          insn.size = 2; insn.branchOffset = readS16(buf, abs + 2);
          break;
        }
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: {
          const names = ['if-eqz', 'if-nez', 'if-ltz', 'if-gez', 'if-gtz', 'if-lez'];
          insn.mnemonic = `${names[op - 0x38]} v${a}, +${readS16(buf, abs + 2)}`;
          insn.size = 2; insn.branchOffset = readS16(buf, abs + 2);
          break;
        }
        case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58:
        case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
          const f = fields[u16at(1)];
          insn.mnemonic = `iget/iput ${f?.classType}->${f?.name}`;
          insn.size = 2; break;
        }
        case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66:
        case 0x67: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: {
          const f = fields[u16at(1)];
          const sops = ['sget', 'sget-wide', 'sget-object', 'sget-boolean', 'sget-byte', 'sget-char', 'sget-short', 'sput', 'sput-wide', 'sput-object', 'sput-boolean', 'sput-byte', 'sput-char', 'sput-short'];
          insn.mnemonic = `${sops[op - 0x60]} v${a}, ${f?.classType}->${f?.name}`;
          insn.size = 2; break;
        }
        case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72: {
          const m = methods[u16at(1)];
          const kinds = ['invoke-virtual', 'invoke-super', 'invoke-direct', 'invoke-static', 'invoke-interface'];
          const count = a;
          const regs = [];
          const c = readU16(buf, abs + 4);
          for (let r = 0; r < count; r++) regs.push((c >> (r * 4)) & 0xf);
          insn.mnemonic = `${kinds[op - 0x6e]} {${regs.map(r => 'v' + r).join(',')}}, ${m?.classType}->${m?.name}(${protoSig(m?.proto)})`;
          insn.size = 3; insn.methodIndex = u16at(1);
          insn.methodRef = m ? `${m.classType}->${m.name}` : null;
          break;
        }
        case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: {
          const m = methods[u16at(1)];
          const kinds = ['invoke-virtual/range', 'invoke-super/range', 'invoke-direct/range', 'invoke-static/range', 'invoke-interface/range'];
          insn.mnemonic = `${kinds[op - 0x74]} {range}, ${m?.classType}->${m?.name}`;
          insn.size = 3; insn.methodIndex = u16at(1);
          insn.methodRef = m ? `${m.classType}->${m.name}` : null;
          break;
        }
        case 0x01: insn.mnemonic = `move v${a & 0xf}, v${(a >> 4) & 0xf}`; break;
        case 0x02: insn.mnemonic = `move/from16 v${a}, v${u16at(1)}`; insn.size = 2; break;
        case 0x03: insn.mnemonic = 'move/16'; insn.size = 3; break;
        case 0x04: case 0x05: case 0x06: insn.mnemonic = 'move-wide'; insn.size = op === 0x04 ? 1 : op === 0x05 ? 2 : 3; break;
        case 0x07: case 0x08: case 0x09: insn.mnemonic = 'move-object'; insn.size = op === 0x07 ? 1 : op === 0x08 ? 2 : 3; break;
        case 0x0d: insn.mnemonic = 'move-exception'; break;
        default: {
          insn.size = OP_WIDTHS[op] ?? 1;
          break;
        }
      }
      insns.push(insn);
      pc += insn.size * 2;
    }
    return { insnsOff, insnsSize, insns };
  }

  return { file, buf, header: h, strings, types, protos, fields, methods, classes, decodeCode, stringIndexByValue };
}

function parseStringPoolAt(buf, off) {
  const type = readU16(buf, off);
  if (type !== 0x0001) return null;
  const headerSize = readU16(buf, off + 2);
  const size = readU32(buf, off + 4);
  const stringCount = readU32(buf, off + 8);
  const flags = readU32(buf, off + 16);
  const stringsStart = readU32(buf, off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const entries = [];
  for (let i = 0; i < stringCount; i++) {
    const rel = readU32(buf, off + headerSize + i * 4);
    const abs = off + stringsStart + rel;
    let str;
    if (utf8) {
      let p = abs;
      if (buf[p] & 0x80) p += 2; else p += 1;
      let blen;
      if (buf[p] & 0x80) { blen = ((buf[p] & 0x7f) << 8) | buf[p + 1]; p += 2; } else { blen = buf[p]; p += 1; }
      str = buf.toString('utf8', p, p + blen);
    } else {
      let len = readU16(buf, abs);
      let p = abs + 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | readU16(buf, p); p += 2; }
      str = buf.toString('utf16le', p, p + len * 2);
    }
    entries.push({ index: i, str, offset: abs });
  }
  return { entries, end: off + size, utf8, size };
}

function parseArsc(file) {
  const buf = fs.readFileSync(file);
  const result = { file, packages: [], globalStrings: [] };
  if (readU16(buf, 0) !== 0x0002) throw new Error('not RES_TABLE_TYPE');
  let pos = readU16(buf, 2);
  const end = buf.length;
  while (pos < end) {
    const type = readU16(buf, pos);
    const size = readU32(buf, pos + 4);
    if (size === 0) break;
    if (type === 0x0001) {
      const sp = parseStringPoolAt(buf, pos);
      if (sp) result.globalStrings = sp.entries;
    } else if (type === 0x0200) {
      const pkgOff = pos;
      const id = readU32(buf, pkgOff + 8);
      const name = buf.toString('utf16le', pkgOff + 12, pkgOff + 12 + 256).replace(/\0.*$/s, '');
      // In modern arsc the typeStrings/keyStrings header fields may be zero;
      // the two string pools simply sit right after the fixed package header.
      // Walk chunks in order: first string-pool = type names, second = key names.
      const headerSize = readU16(buf, pkgOff + 2);
      let p = pkgOff + headerSize;
      const pkgEnd = pkgOff + size;
      const pools = [];
      while (p < pkgEnd && pools.length < 2) {
        const ctype = readU16(buf, p);
        if (ctype !== 0x0001) break;
        pools.push(parseStringPoolAt(buf, p));
        p += readU32(buf, p + 4);
      }
      const typePool = pools[0];
      const keyPool = pools[1];
      if (!typePool || !keyPool) throw new Error('arsc package missing type/key string pools');
      const pkg = {
        id: '0x' + id.toString(16), name,
        typeNames: typePool.entries.map(e => e.str),
        keyNames: keyPool.entries.map(e => e.str),
        types: [],
      };
      while (p < pkgEnd) {
        const ctype = readU16(buf, p);
        const csize = readU32(buf, p + 4);
        if (csize === 0) break;
        if (ctype === 0x0202) {
          const specId = buf[p + 8];
          const entryCount = readU32(buf, p + 0x0c);
          pkg.types.push({ kind: 'spec', typeId: specId, typeName: pkg.typeNames[specId - 1] ?? null, entryCount, offset: p });
        } else if (ctype === 0x0201) {
          const typeId = buf[p + 8];
          const entryCount = readU32(buf, p + 0x0c);
          const entriesStart = readU32(buf, p + 0x10);
          const headerSizeT = readU16(buf, p + 2);
          const entries = [];
          for (let e = 0; e < entryCount; e++) {
            const relOff = readU32(buf, p + headerSizeT + e * 4);
            if (relOff === 0xffffffff) { entries.push(null); continue; }
            const eAbs = p + entriesStart + relOff;
            const keyIndex = readU32(buf, eAbs + 4);
            entries.push({
              entry: e,
              keyIndex,
              name: keyPool.entries[keyIndex]?.str ?? null,
              resId: `0x${id.toString(16).padStart(2, '0')}${typeId.toString(16).padStart(2, '0')}${e.toString(16).padStart(4, '0')}`,
            });
          }
          pkg.types.push({ kind: 'type', typeId, typeName: pkg.typeNames[typeId - 1] ?? null, entryCount, entries, offset: p });
        }
        p += csize;
      }
      result.packages.push(pkg);
    }
    pos += size;
  }
  return result;
}

const report = {
  generatedAt: new Date().toISOString(),
  dexes: {},
  residClasses: [],
  webviewResId: null,
  keyStrings: {},
  arsc: null,
};

for (const dexName of ['classes.dex', 'classes2.dex', 'classes3.dex']) {
  const fp = path.join(sgamxDir, dexName);
  if (!fs.existsSync(fp)) continue;
  const dex = parseDex(fp);
  const info = { file: fp, stringCount: dex.header.stringIdsSize, methodCount: dex.header.methodIdsSize };

  for (const needle of ['Resource %s(type=%s, pkg=%s) is not found', 'smobawebviewlayout', 'smobawebview_webview', 'com.tencent.tmgp.sgame', 'com.tencent.tmgp.sgamx']) {
    const idx = dex.stringIndexByValue.get(needle);
    if (idx !== undefined) {
      report.keyStrings[`${dexName}: "${needle}"`] = {
        stringIndex: idx,
        headerOffset: dex.header.stringIdsOff + idx * 4,
        dataOffset: dex.strings[idx].offset,
      };
    }
  }

  for (const cls of dex.classes) {
    if (/ResID;/.test(cls.type)) {
      const rec = { dex: dexName, classType: cls.type, methods: [] };
      for (const m of cls.methods) {
        if (m.name === 'loadIdentifierResource' || m.name === 'init') {
          const code = dex.decodeCode(m.codeOff);
          rec.methods.push({
            name: m.name,
            kind: m.kind,
            proto: `${m.proto.returnType}`,
            codeOff: m.codeOff,
            insns: code ? code.insns.map(i => ({
              pc: i.pc,
              fileOffset: i.offset,
              mnemonic: i.mnemonic,
              ...(i.methodRef ? { methodRef: i.methodRef } : {}),
              ...(i.stringIndex !== undefined ? { stringIndex: i.stringIndex } : {}),
            })) : null,
          });
        }
      }
      if (rec.methods.length) report.residClasses.push(rec);
    }
    if (cls.type === 'Lcom/smoba/webview/WebViewResID;') {
      const codeMethods = [];
      for (const m of cls.methods) {
        const code = dex.decodeCode(m.codeOff);
        codeMethods.push({
          name: m.name, kind: m.kind, codeOff: m.codeOff,
          insns: code ? code.insns.map(i => ({
            pc: i.pc,
            fileOffset: i.offset,
            mnemonic: i.mnemonic,
            ...(i.methodRef ? { methodRef: i.methodRef } : {}),
            ...(i.stringIndex !== undefined ? { stringIndex: i.stringIndex } : {}),
          })) : null,
        });
      }
      report.webviewResId = { dex: dexName, classType: cls.type, methods: codeMethods };
    }
  }

  const exitMethods = [];
  dex.methods.forEach((m, i) => {
    if (m.classType === 'Ljava/lang/System;' && m.name === 'exit') exitMethods.push(i);
  });
  info.systemExitMethodIndexes = exitMethods;
  report.dexes[dexName] = info;
}

const arscPath = path.join(sgamxDir, 'resources.arsc');
const arsc = parseArsc(arscPath);
const pkg0 = arsc.packages[0];
const layoutTypes = pkg0 ? pkg0.types.filter(t => t.kind === 'type' && t.typeName === 'layout') : [];
const idTypes = pkg0 ? pkg0.types.filter(t => t.kind === 'type' && t.typeName === 'id') : [];
const layoutEntries = [...new Set(layoutTypes.flatMap(t => t.entries.filter(Boolean).map(e => e.name)))];
const idEntries = [...new Set(idTypes.flatMap(t => t.entries.filter(Boolean).map(e => e.name)))];
const entriesOfType = (tn) => {
  if (!pkg0) return [];
  return [...new Set(pkg0.types.filter(t => t.kind === 'type' && t.typeName === tn).flatMap(t => t.entries.filter(Boolean).map(e => e.name)))];
};
const rawEntries = entriesOfType('raw');
const stringEntries = entriesOfType('string');
const drawableEntries = entriesOfType('drawable');

// every resource queried by com.tencent.tmgp.Common.WebViewResID.init (from jadx + dex evidence)
const tmgpQueries = [
  ['license', 'layout'], ['no', 'id'], ['yes', 'id'], ['title', 'id'], ['privacy', 'id'],
  ['childText', 'id'], ['sdkText', 'id'], ['license', 'id'],
  ['permissions', 'layout'], ['button', 'id'], ['web', 'id'], ['webView', 'id'], ['back', 'id'],
  ['permission_location', 'drawable'], ['permission_device', 'drawable'], ['permission_file', 'drawable'],
  ['permission_calendar', 'drawable'], ['permission_sms', 'drawable'], ['permission_record', 'drawable'],
  ['permission_camera', 'drawable'],
  ['items', 'id'], ['icon', 'id'], ['description', 'id'], ['name', 'id'], ['glow', 'id'],
  ['videoview', 'layout'], ['videoView', 'id'], ['videosplash', 'raw'],
  ['Permmsion_Locating_Name', 'string'], ['Permmsion_Locating_Desc', 'string'],
  ['Permmsion_SaveFile_Name', 'string'], ['Permmsion_SaveFile_Desc', 'string'],
  ['Permmsion_calendar_Name', 'string'], ['Permmsion_calendar_Desc', 'string'],
  ['Permmsion_Mic_Name', 'string'], ['Permmsion_Mic_Desc', 'string'],
  ['Permmsion_Camera_Name', 'string'], ['Permmsion_Camera_Desc', 'string'],
];
const tables = { layout: layoutEntries, id: idEntries, raw: rawEntries, string: stringEntries, drawable: drawableEntries };
const queryMatrix = tmgpQueries.map(([name, type]) => ({
  name, type,
  presentInArsc: (tables[type] ?? []).includes(name),
}));
const missing = queryMatrix.filter(q => !q.presentInArsc);

report.arsc = {
  file: arscPath,
  packageName: pkg0?.name,
  packageId: pkg0?.id,
  typeNames: pkg0?.typeNames,
  layoutEntryCount: layoutEntries.length,
  layoutEntries,
  idEntryCount: idEntries.length,
  rawEntries,
  stringEntryCount: stringEntries.length,
  drawableEntryCount: drawableEntries.length,
  smobawebviewlayoutPresent: layoutEntries.includes('smobawebviewlayout'),
  smobawebviewWebviewPresent: idEntries.includes('smobawebview_webview'),
  licenseLayoutPresent: layoutEntries.includes('license'),
  tmgpQueryMatrix: queryMatrix,
  tmgpMissingInArsc: missing,
  typeSpecs: pkg0 ? pkg0.types.filter(t => t.kind === 'spec').map(t => ({ typeId: t.typeId, typeName: t.typeName, entryCount: t.entryCount, offset: t.offset })) : [],
};

fs.writeFileSync(path.join(outDir, 'resid_gate_analysis.json'), JSON.stringify(report, null, 2));

console.log('== ResID classes ==');
for (const rc of report.residClasses) {
  console.log(`${rc.dex} ${rc.classType}`);
  for (const m of rc.methods) {
    console.log(`  ${m.kind} ${m.name} codeOff=0x${m.codeOff.toString(16)}`);
    if (m.insns) for (const i of m.insns) {
      console.log(`    +0x${i.pc.toString(16).padStart(4, '0')} @file 0x${i.fileOffset.toString(16)}  ${i.mnemonic}`);
    }
  }
}
console.log('== WebViewResID ==');
if (report.webviewResId) {
  for (const m of report.webviewResId.methods) {
    console.log(`  ${m.kind} ${m.name} codeOff=0x${m.codeOff?.toString(16)}`);
    if (m.insns) for (const i of m.insns) {
      console.log(`    +0x${i.pc.toString(16).padStart(4, '0')} @file 0x${i.fileOffset.toString(16)}  ${i.mnemonic}`);
    }
  }
}
console.log('== key strings ==');
for (const [k, v] of Object.entries(report.keyStrings)) {
  console.log(`${k} -> stringIndex=${v.stringIndex} dataOff=0x${v.dataOffset.toString(16)}`);
}
console.log('== arsc ==');
console.log(`package=${report.arsc.packageName} id=${report.arsc.packageId}`);
console.log(`layout entries=${report.arsc.layoutEntryCount} id entries=${report.arsc.idEntryCount}`);
console.log(`smobawebviewlayout present in arsc layout table: ${report.arsc.smobawebviewlayoutPresent}`);
console.log(`smobawebview_webview present in arsc id table: ${report.arsc.smobawebviewWebviewPresent}`);
console.log(`license layout present: ${report.arsc.licenseLayoutPresent}`);
console.log('layout entries:', layoutEntries.join(', '));
console.log('== tmgp Common WebViewResID.init query matrix ==');
for (const q of queryMatrix) {
  console.log(`  ${q.presentInArsc ? 'OK ' : 'MISS'} ${q.type}/${q.name}`);
}
console.log(`missing in arsc: ${missing.length === 0 ? 'NONE — all queried resources exist in the table' : missing.map(m => `${m.type}/${m.name}`).join(', ')}`);
console.log('analysis json ->', path.join(outDir, 'resid_gate_analysis.json'));
