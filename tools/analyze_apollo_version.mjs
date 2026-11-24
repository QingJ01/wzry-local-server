import fs from "node:fs";
import path from "node:path";

const [,, libPath, outDir] = process.argv;
const buf = fs.readFileSync(libPath);
const e_shoff = Number(buf.readBigUInt64LE(0x28));
const es = buf.readUInt16LE(0x3a), en = buf.readUInt16LE(0x3c), si = buf.readUInt16LE(0x3e);
const S = [];
for (let i = 0; i < en; i++) {
  const o = e_shoff + i * es;
  S.push({ no: buf.readUInt32LE(o), ty: buf.readUInt32LE(o + 4),
    ad: Number(buf.readBigUInt64LE(o + 16)), of: Number(buf.readBigUInt64LE(o + 24)),
    sz: Number(buf.readBigUInt64LE(o + 32)), li: buf.readUInt32LE(o + 40) });
}
const shOf = Number(S[si].of);
const raw = buf.toString("latin1");
const byName = {};
S.forEach((s) => { const e = raw.indexOf("\0", shOf + s.no); byName[raw.slice(shOf + s.no, e)] = s; });
const rel = byName[".rodata"], t = byName[".text"];
const dy = byName[".dynsym"], ds = byName[".dynstr"];
const names = raw.slice(Number(ds.of), Number(ds.of) + Number(ds.sz));
const rsn = (o) => { let e = o; while (names[e] !== "\0") e++; return names.slice(o, e); };
const symByAddr = new Map();
for (let i = 0; i < Number(dy.sz) / 24; i++) {
  const b = Number(dy.of) + i * 24;
  symByAddr.set(Number(buf.readBigUInt64LE(b + 8)), rsn(buf.readUInt32LE(b)));
}
const v2f = (v) => Number(t.of) + (v - Number(t.ad));
const f2v = (f) => Number(t.ad) + (f - Number(t.of));
function strAtVA(v) {
  const f = rel.of + (v - rel.ad);
  if (f < rel.of || f >= rel.of + rel.sz) return null;
  let e = f; while (buf[e] !== 0 && e < f + 300) e++;
  return buf.toString("latin1", f, e);
}
function adrpTarget(w, pc) {
  if ((w & 0x9f000000) !== 0x90000000) return null;
  const imm = (((w >>> 3) & 0x3ffff) << 2) | ((w >>> 29) & 3);
  const simm = (imm << 14) >> 14;
  return { rd: w & 31, base: (pc & ~0xfff) + simm * 4096 };
}
function scanFunc(va, count) {
  const f0 = v2f(va);
  const regs = {};
  const lines = [];
  for (let i = 0; i < count; i++) {
    const pc = va + i * 4, w = buf.readUInt32LE(f0 + i * 4);
    let note = "";
    const a = adrpTarget(w, pc);
    if (a) { regs[a.rd] = a.base; note = `adrp x${a.rd},0x${a.base.toString(16)}`; }
    else if ((w & 0xff800000) === 0x91000000) {
      const rd = w & 31, rn = (w >>> 5) & 31;
      if (regs[rn] !== undefined) { regs[rd] = regs[rn] + ((w >>> 10) & 0xfff); note = `add x${rd},0x${regs[rd].toString(16)}`; }
    } else if ((w & 0x3b000000) === 0x39000000 || (w & 0x3b000000) === 0x39400000 ||
               (w & 0xffc00000) === 0xf9400000 || (w & 0xffc00000) === 0xb9400000) {
      const rn = (w >>> 5) & 31;
      const is64 = (w & 0xffc00000) === 0xf9400000;
      const sz = (w >>> 30) || (is64 ? 3 : 2);
      const imm = ((w >>> 10) & 0xfff) * sz;
      if (regs[rn] !== undefined) {
        const addr = regs[rn] + imm; const s = strAtVA(addr);
        if (s && /[ -~]{4,}/.test(s)) note = `x${w&31} <- [0x${addr.toString(16)}] ${JSON.stringify(s.slice(0, 80))}`;
      }
    }
    if (note) lines.push(`0x${pc.toString(16)}:  ${w.toString(16).padStart(8, "0")}  ${note}`);
  }
  return lines;
}
function strVAs(s) {
  const out = []; let f = rel.of;
  while (true) { f = raw.indexOf(s, f + 1); if (f < 0 || f >= rel.of + rel.sz) break; out.push(rel.ad + (f - rel.of)); }
  return out;
}
const out = [];
const report = { lib: libPath, symbols: {}, stringRefs: {}, funcDumps: {} };
for (const kw of ["isNeedUpdating", "isForcedUpdating", "isAppUpdating", "OnGetNewVersionInfo",
  "on_get_new_version", "m_custom_str", "AnnouncementUrl", "IncompatibleResourceVersion",
  "downloadAppVersion", "Handle Version"]) {
  report.stringRefs[kw] = strVAs(kw).map((v) => "0x" + v.toString(16));
}
for (const [va, name] of symByAddr) {
  if (/OnGetNewVersionInfo|CheckAppUpdate|CAppCallbackVersionInfo|SaveConfig|OnActionMsgArrive/.test(name)) {
    report.symbols[name] = "0x" + va.toString(16);
  }
}
for (const [name, va, cnt] of [
  ["PluginVersionMgrCallback::OnGetNewVersionInfo", 0x44ba58, 174],
  ["VersionMgrAndroidCallback::OnGetNewVersionInfo", 0x55d02c, 188],
]) {
  report.funcDumps[name] = scanFunc(va, cnt);
}

const xref = [];
const regs = new Map();
const tf0 = Number(t.of), tn = Number(t.sz) / 4;
for (let i = 0; i < tn; i++) {
  const pc = Number(t.ad) + i * 4;
  const w = buf.readUInt32LE(tf0 + i * 4);
  if ((w & 0x9f000000) === 0x90000000) {
    const rd = w & 31;
    const imm = (((w >>> 3) & 0x3ffff) << 2) | ((w >>> 29) & 3);
    const simm = (imm << 14) >> 14;
    regs.set(rd, { base: (pc & ~0xfff) + simm * 4096 });
    continue;
  }
  const rn = (w >>> 5) & 31;
  let imm = 0, kind = null, rd = -1;
  if ((w & 0xff800000) === 0x91000000) { rd = w & 31; imm = (w >>> 10) & 0xfff; kind = "add"; }
  else if ((w & 0xffc00000) === 0xf9400000) { imm = ((w >>> 10) & 0xfff) * 8; kind = "ldr64"; }
  else if ((w & 0xffc00000) === 0xb9400000) { imm = ((w >>> 10) & 0xfff) * 4; kind = "ldr32"; }
  else if ((w & 0x3b000000) === 0x39400000) { imm = (w >>> 10) & 0xfff; kind = "ldrb"; }
  else if ((w & 0x3b000000) === 0x39000000) { imm = (w >>> 10) & 0xfff; kind = "strb"; }
  else if ((w & 0xffc00000) === 0xf9000000) { imm = ((w >>> 10) & 0xfff) * 8; kind = "str64"; }
  if (!kind || !regs.has(rn)) continue;
  const a = regs.get(rn).base + imm;
  const s = strAtVA(a);
  if (s && /[ -~]{6,}/.test(s) && /(Version|version|Update|update|Handle|fileinfo|get_new|custom_str|AppUpdating|NeedUpdat|ForcedUpdat|Announcement|Incompatible|downloadApp)/.test(s)) {
    xref.push(`0x${pc.toString(16)} [${kind}] 0x${a.toString(16)} ${JSON.stringify(s.slice(0, 90))}`);
  }
  if (kind === "add" && rd >= 0) regs.set(rd, { base: a });
}
report.xrefVersionStrings = xref;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "apollo-version-analysis.json"), JSON.stringify(report, null, 1));
console.log("done ->", path.join(outDir, "apollo-version-analysis.json"));
for (const [k, v] of Object.entries(report.symbols)) console.log(k, "=", v);
console.log("xref hits:", xref.length);
for (const h of xref.slice(0, 60)) console.log("  " + h);
