import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseElf, dynamicSymbols, extractStrings } from "./analyze_gamecore.mjs";

const TARGET_IMPORTS = [
  "kill",
  "abort",
  "_exit",
  "exit",
  "raise",
  "tgkill",
  "pthread_kill",
  "syscall",
  "signal",
  "ptrace",
];
const PLT_HEADER_BYTES = 32;
const PLT_STUB_BYTES = 16;
const AARCH64_NOP_HEX = "1f2003d5";
const AARCH64_RET_HEX = "c0035fd6";
const STRING_KEYWORDS = ["ApkAbort", "mtcj", "apk_path", "Digital Signature"];

function sectionByName(elf, name) {
  return elf.sectionHeaders.find((section) => section.name === name);
}

function sectionData(buffer, section) {
  return buffer.subarray(section.offset, section.offset + section.size);
}

function decodeRelaPlt(buffer, elf, symbols) {
  const relaSection = sectionByName(elf, ".rela.plt");
  if (!relaSection) {
    throw new Error("missing .rela.plt section");
  }
  const dynsymSection = sectionByName(elf, ".dynsym");
  if (!dynsymSection) {
    throw new Error("missing .dynsym section");
  }
  const entries = [];
  for (let index = 0; index * 24 < relaSection.size; index += 1) {
    const offset = relaSection.offset + index * 24;
    const rOffset = Number(buffer.readBigUInt64LE(offset));
    const rInfo = buffer.readBigUInt64LE(offset + 8);
    const symbolIndex = Number(rInfo >> 32n);
    const type = Number(rInfo & 0xffffffffn);
    const addend = Number(buffer.readBigInt64LE(offset + 16));
    const symbol = symbols[symbolIndex];
    entries.push({
      index,
      rOffset,
      type,
      addend,
      symbolIndex,
      name: symbol ? symbol.name : "",
    });
  }
  return entries;
}

function pltStubAddress(pltSection, relocIndex) {
  return pltSection.address + PLT_HEADER_BYTES + relocIndex * PLT_STUB_BYTES;
}

function scanBlXrefs(codeBuffer, codeBase, targets) {
  const byTarget = new Map(targets.map((target) => [target.pltAddress, []]));
  const branchMap = new Map();
  for (let offset = 0; offset + 4 <= codeBuffer.length; offset += 4) {
    const insn = codeBuffer.readUInt32LE(offset);
    const op = insn & 0xfc000000;
    if (op !== 0x94000000 && op !== 0x14000000) continue;
    let imm26 = insn & 0x03ffffff;
    if (imm26 & 0x02000000) imm26 -= 0x04000000;
    const pc = codeBase + offset;
    branchMap.set(pc, pc + imm26 * 4);
  }
  for (let offset = 0; offset + 4 <= codeBuffer.length; offset += 4) {
    const insn = codeBuffer.readUInt32LE(offset);
    const op = insn & 0xfc000000;
    if (op !== 0x94000000 && op !== 0x14000000) continue;
    let imm26 = insn & 0x03ffffff;
    if (imm26 & 0x02000000) imm26 -= 0x04000000;
    const pc = codeBase + offset;
    const target = pc + imm26 * 4;
    const bucket = byTarget.get(target);
    if (bucket) {
      bucket.push({ codeOffset: offset, vaddr: pc, insn, kind: op === 0x94000000 ? "BL" : "B", indirect: false });
    }
  }
  // Resolve thunk indirection: a B whose target is itself a B-to-PLT thunk counts as an indirect call site.
  for (const target of targets) {
    const bucket = byTarget.get(target.pltAddress);
    const thunks = bucket.filter((site) => site.kind === "B").map((site) => site.vaddr);
    for (const thunkVa of thunks) {
      for (const [from, to] of branchMap) {
        if (to === thunkVa) {
          bucket.push({ codeOffset: from - codeBase, vaddr: from, insn: codeBuffer.readUInt32LE(from - codeBase), kind: "B->thunk", indirect: true, thunk: thunkVa });
        }
      }
    }
  }
  return byTarget;
}

function disasmContext(buffer, fileOffset, count = 4) {
  const start = Math.max(0, fileOffset - count * 4);
  const insns = [];
  for (let offset = start; offset <= fileOffset + count * 4 && offset + 4 <= buffer.length; offset += 4) {
    insns.push(buffer.readUInt32LE(offset).toString(16).padStart(8, "0"));
  }
  return {
    start,
    bytesHex: buffer.subarray(start, Math.min(buffer.length, fileOffset + (count + 1) * 4)).toString("hex"),
    insns,
  };
}

function fileOffsetToVaddr(elf, fileOffset) {
  const header = elf.programHeaders.find(
    (candidate) =>
      candidate.type === 1 &&
      fileOffset >= candidate.offset &&
      fileOffset < candidate.offset + candidate.fileSize,
  );
  if (!header) return null;
  return header.virtualAddress + (fileOffset - header.offset);
}

function findStringXrefs(buffer, elf, strings) {
  const matches = strings.filter((item) =>
    STRING_KEYWORDS.some((keyword) => item.value.includes(keyword)),
  );
  const text = sectionByName(elf, ".text");
  const code = sectionData(buffer, text);
  const results = [];
  for (const item of matches) {
    const vaddr = fileOffsetToVaddr(elf, item.offset);
    const refs = [];
    if (vaddr != null) {
      for (let offset = 0; offset + 4 <= code.length; offset += 4) {
        const insn = code.readUInt32LE(offset);
        const pc = text.address + offset;
        if ((insn & 0x9f000000) !== 0x90000000) continue;
        let imm = ((insn >> 5) & 0x7ffff) << 12;
        imm |= ((insn >> 29) & 0x3) << 21;
        if (imm & 0x1000000) imm -= 0x2000000;
        const page = (pc - (pc % 0x1000)) + imm;
        for (let look = offset + 4; look <= offset + 24 && look + 4 <= code.length; look += 4) {
          const next = code.readUInt32LE(look);
          const isAdd64 = (next & 0xff000000) === 0x91000000;
          const isLdr64 = (next & 0xffc00000) === 0xf9400000;
          if (!isAdd64 && !isLdr64) continue;
          const imm12raw = (next >> 10) & 0xfff;
          const scale = isLdr64 ? 3 : 0;
          const target = page + (imm12raw << scale);
          if (target === vaddr || (target >= vaddr && target < vaddr + 64)) {
            refs.push({ adrpOff: offset, adrpVaddr: pc, consumerOff: look, target });
            break;
          }
        }
      }
    }
    results.push({ fileOffset: item.offset, vaddr, value: item.value.slice(0, 200), refs });
  }
  return results;
}

function suggestReplacement(targetName) {
  if (targetName === "kill") {
    return {
      strategy: "patch BL kill call sites to NOP only if the branch is a proven self-terminate path",
      opcode: AARCH64_NOP_HEX,
      precondition: "evidence that the call kills own pid on integrity failure; do not NOP kill calls that terminate helper processes intentionally",
    };
  }
  if (targetName === "abort") {
    return {
      strategy: "return-early or NOP abort call sites once the ApkAbort path is attributed",
      opcode: AARCH64_NOP_HEX,
      precondition: "caller function must be identified and the abort must be reachable only from integrity-failure branches",
    };
  }
  return {
    strategy: "defer",
    opcode: null,
    precondition: "insufficient evidence",
  };
}

export function analyzeTersafe(inputPath, outputDirectory) {
  const buffer = fs.readFileSync(inputPath);
  const elf = parseElf(buffer);
  const symbols = dynamicSymbols(buffer, elf);
  const relocations = decodeRelaPlt(buffer, elf, symbols);
  const plt = sectionByName(elf, ".plt");
  const text = sectionByName(elf, ".text");
  if (!plt || !text) {
    throw new Error("expected .plt and .text sections");
  }
  // libtersafe puts thunk stubs in the executable gap between .plt and .text
  // (0x239xxx < text). Scan the full executable range .plt.end -> .text.end.
  const codeStart = plt.offset + plt.size;
  const codeEnd = text.offset + text.size;
  const codeBase = plt.address + plt.size;
  const code = buffer.subarray(codeStart, codeEnd);
  const strings = extractStrings(buffer);

  const targets = relocations
    .filter((entry) => TARGET_IMPORTS.includes(entry.name))
    .map((entry) => ({
      name: entry.name,
      relocIndex: entry.index,
      gotAddress: entry.rOffset,
      pltAddress: pltStubAddress(plt, entry.index),
      pltFileOffset: plt.offset + PLT_HEADER_BYTES + entry.index * PLT_STUB_BYTES,
      type: entry.type,
    }));

  const xrefs = scanBlXrefs(code, codeBase, targets);
  for (const target of targets) {
    const sites = xrefs.get(target.pltAddress) || [];
    target.callSites = sites.map((site) => ({
      fileOffset: codeStart + site.codeOffset,
      vaddr: site.vaddr,
      kind: site.kind,
      indirect: site.indirect,
      thunk: site.thunk ? `0x${site.thunk.toString(16)}` : null,
      insnHex: site.insn.toString(16).padStart(8, "0"),
      context: disasmContext(buffer, codeStart + site.codeOffset),
    }));
    target.suggestion = suggestReplacement(target.name);
  }

  const stringRefs = findStringXrefs(buffer, elf, strings);
  const directSvc = [];
  for (let offset = 0; offset + 4 <= code.length; offset += 4) {
    const insn = code.readUInt32LE(offset);
    if ((insn & 0xffe0001f) !== 0xd4000001) continue;
    const imm16 = (insn >> 5) & 0xffff;
    const pc = codeBase + offset;
    const prevMov = [];
    for (let look = Math.max(0, offset - 24); look < offset; look += 4) {
      const candidate = code.readUInt32LE(look);
      if ((candidate & 0xffe0001f) === 0xd2800000 || (candidate & 0xffe0001f) === 0x52800000) {
        prevMov.push({ fileOffset: codeStart + look, vaddr: codeBase + look, insnHex: candidate.toString(16).padStart(8, "0") });
      }
    }
    directSvc.push({ fileOffset: codeStart + offset, vaddr: pc, svc: imm16, prevMov });
  }

  const summary = {
    input: path.resolve(inputPath),
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    elf: {
      machine: elf.machine,
      type: elf.type,
      entryPoint: elf.entryPoint,
    },
    sections: {
      plt: { address: plt.address, offset: plt.offset, size: plt.size },
      text: { address: text.address, offset: text.offset, size: text.size },
    },
    relaPltEntries: relocations.length,
    targets,
    stringRefs: stringRefs.filter((item) => item.refs.length > 0),
    unmatchedStrings: stringRefs.filter((item) => item.refs.length === 0).map((item) => ({
      fileOffset: item.fileOffset,
      value: item.value.slice(0, 120),
    })),
    directSvc,
    notes: [
      "PLT stub addresses derived from .rela.plt order: plt = .plt + 32 + index*16.",
      "BL xrefs are AArch64 fixed 4-byte instructions scanned over .text.",
      "ADRP string xrefs use page + imm12 matching against string virtual addresses.",
      "This tool is analysis-only; no bytes are modified.",
    ],
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  const write = (name, contents) => fs.writeFileSync(path.join(outputDirectory, name), contents, "utf8");
  write("tersafe_call_analysis.json", `${JSON.stringify(summary, null, 2)}\n`);
  write(
    "call_sites.txt",
    targets
      .flatMap((target) =>
        target.callSites.map((site) => `${target.name}\t${site.kind}\tva:0x${site.vaddr.toString(16)}\tfile:0x${site.fileOffset.toString(16)}\tinsn:${site.insnHex}`),
      )
      .join("\n") + "\n",
  );
  write(
    "string_xrefs.txt",
    stringRefs
      .flatMap((item) =>
        item.refs.map((ref) => `${item.value.slice(0, 80)}\t@0x${item.fileOffset.toString(16)}\tadrpVa:0x${ref.adrpVaddr.toString(16)}\ttarget:0x${ref.target.toString(16)}`),
      )
      .join("\n") + "\n",
  );
  return summary;
}

function main() {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory) {
    throw new Error("usage: node analyze_tersafe_calls.mjs <libtersafe.so> <output-directory>");
  }
  const summary = analyzeTersafe(inputPath, outputDirectory);
  console.log(JSON.stringify({
    sha256: summary.sha256,
    targets: summary.targets.map((target) => ({ name: target.name, plt: `0x${target.pltAddress.toString(16)}`, sites: target.callSites.length })),
    stringRefs: summary.stringRefs.length,
    directSvc: summary.directSvc.length,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
