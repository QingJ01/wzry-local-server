import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export function parseElf(buffer) {
  if (buffer.length < 64) {
    throw new Error("file is too short for ELF64");
  }
  if (!buffer.subarray(0, 4).equals(ELF_MAGIC)) {
    throw new Error("ELF magic mismatch");
  }
  if (buffer.readUInt8(4) !== 2 || buffer.readUInt8(5) !== 1) {
    throw new Error("expected ELF64 little-endian");
  }

  const sectionHeaderTableOffset = Number(buffer.readBigUInt64LE(0x28));
  const sectionHeaderEntrySize = buffer.readUInt16LE(0x3a);
  const sectionCount = buffer.readUInt16LE(0x3c);
  const sectionStringTableIndex = buffer.readUInt16LE(0x3e);
  const programHeaderTableOffset = buffer.readUInt32LE(0x20);
  const programHeaderEntrySize = buffer.readUInt16LE(0x36);
  const programCount = buffer.readUInt16LE(0x38);

  const sectionTableAvailable =
    sectionHeaderTableOffset + sectionCount * sectionHeaderEntrySize <= buffer.length;
  const sectionHeaders = [];
  if (sectionTableAvailable) {
    for (let index = 0; index < sectionCount; index += 1) {
      const offset = sectionHeaderTableOffset + index * sectionHeaderEntrySize;
      sectionHeaders.push({
        index,
        nameOffset: buffer.readUInt32LE(offset),
        type: buffer.readUInt32LE(offset + 4),
        flags: Number(buffer.readBigUInt64LE(offset + 8)),
        address: Number(buffer.readBigUInt64LE(offset + 16)),
        offset: Number(buffer.readBigUInt64LE(offset + 24)),
        size: Number(buffer.readBigUInt64LE(offset + 32)),
        link: buffer.readUInt32LE(offset + 40),
        info: buffer.readUInt32LE(offset + 44),
        alignment: Number(buffer.readBigUInt64LE(offset + 48)),
        entrySize: Number(buffer.readBigUInt64LE(offset + 56)),
      });
    }
  const shstrtab = sectionHeaders[sectionStringTableIndex];
    const stringTableBuffer = shstrtab
      ? buffer.subarray(shstrtab.offset, shstrtab.offset + shstrtab.size)
      : Buffer.alloc(0);
    for (const section of sectionHeaders) {
      section.name = readCString(stringTableBuffer, section.nameOffset);
    }
  }

  const programHeaders = [];
  for (let index = 0; index < programCount; index += 1) {
    const offset = programHeaderTableOffset + index * programHeaderEntrySize;
    if (offset + programHeaderEntrySize > buffer.length) break;
    programHeaders.push({
      index,
      type: buffer.readUInt32LE(offset),
      flags: buffer.readUInt32LE(offset + 4),
      offset: Number(buffer.readBigUInt64LE(offset + 8)),
      virtualAddress: Number(buffer.readBigUInt64LE(offset + 16)),
      physicalAddress: Number(buffer.readBigUInt64LE(offset + 24)),
      fileSize: Number(buffer.readBigUInt64LE(offset + 32)),
      memorySize: Number(buffer.readBigUInt64LE(offset + 40)),
      alignment: Number(buffer.readBigUInt64LE(offset + 48)),
    });
  }

  return {
    class: 2,
    endian: 1,
    machine: buffer.readUInt16LE(0x12),
    type: buffer.readUInt16LE(0x10),
    entryPoint: Number(buffer.readBigUInt64LE(0x18)),
    programHeaderTableOffset,
    programHeaderEntrySize,
    programCount,
    sectionHeaderTableOffset,
    sectionHeaderEntrySize,
    sectionCount,
    sectionStringTableIndex,
    sectionTableAvailable,
    sectionHeaders,
    programHeaders,
  };
}

export function readCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return "";
  const end = buffer.indexOf(0, offset);
  const stop = end === -1 ? buffer.length : end;
  return buffer.subarray(offset, stop).toString("utf8");
}

export function dynamicSymbols(buffer, elf) {
  const dynamic = elf.programHeaders.find((header) => header.type === 2);
  if (!dynamic) return [];
  const tags = [];
  for (let offset = dynamic.offset; offset + 16 <= dynamic.offset + dynamic.fileSize; offset += 16) {
    const tag = Number(buffer.readBigUInt64LE(offset));
    const value = Number(buffer.readBigUInt64LE(offset + 8));
    if (tag === 0) break;
    tags.push({ tag, value });
  }
  elf.dynamicTags = tags;
  const dynsymSection = elf.sectionHeaders.find((section) => section.type === 11);
  let dynsym;
  let strings;
  if (dynsymSection && dynsymSection.entrySize === 24) {
    dynsym = buffer.subarray(dynsymSection.offset, dynsymSection.offset + dynsymSection.size);
    const dynstrSection = elf.sectionHeaders[dynsymSection.link];
    strings = dynstrSection
      ? buffer.subarray(dynstrSection.offset, dynstrSection.offset + dynstrSection.size)
      : Buffer.alloc(0);
  } else {
    const strszTag = tags.find((tag) => tag.tag === 10);
    const symtabTag = tags.find((tag) => tag.tag === 6);
    const symentTag = tags.find((tag) => tag.tag === 11);
    if (!strszTag || !symtabTag || !symentTag || symentTag.value !== 24) return [];
    const dynstrVirtualAddress = symtabTag.value + strszTag.value;
    strings = virtualToSlice(buffer, elf, dynstrVirtualAddress, strszTag.value);
    const symbolCount = Math.floor((strszTag.value - symtabTag.value) / 24);
    dynsym = virtualToSlice(buffer, elf, symtabTag.value, symbolCount * 24);
  }
  const symbols = [];
  const dynsymOffset = dynsymSection ? dynsymSection.offset : 0;
  for (let sliceOffset = 0; sliceOffset + 24 <= dynsym.length; sliceOffset += 24) {
    const offset = dynsymOffset + sliceOffset;
    const nameOffset = buffer.readUInt32LE(offset);
    const info = buffer.readUInt8(offset + 4);
    const other = buffer.readUInt8(offset + 5);
    const sectionIndex = buffer.readUInt16LE(offset + 6);
    const value = Number(buffer.readBigUInt64LE(offset + 8));
    const size = Number(buffer.readBigUInt64LE(offset + 16));
    symbols.push({
      name: readCString(strings, nameOffset),
      info,
      binding: info >> 4,
      type: info & 0xf,
      other,
      sectionIndex,
      value,
      size,
      defined: sectionIndex !== 0,
    });
  }
  return symbols;
}

export function virtualToSlice(buffer, elf, virtualAddress, size) {
  const header = elf.programHeaders.find(
    (candidate) =>
      candidate.type === 1 &&
      virtualAddress >= candidate.virtualAddress &&
      virtualAddress + size <= candidate.virtualAddress + candidate.fileSize,
  );
  if (!header) return Buffer.alloc(0);
  const fileOffset = header.offset + virtualAddress - header.virtualAddress;
  return buffer.subarray(fileOffset, fileOffset + size);
}

export function extractStrings(buffer, minimumLength = 5) {
  const strings = [];
  let start = -1;
  for (let index = 0; index <= buffer.length; index += 1) {
    const byte = index === buffer.length ? 0 : buffer[index];
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable && start === -1) start = index;
    if (!printable && start !== -1) {
      if (index - start >= minimumLength) {
        strings.push({ offset: start, value: buffer.subarray(start, index).toString("utf8") });
      }
      start = -1;
    }
  }
  return strings;
}

const keywordGroups = {
  network: [
    "socket", "connect", "send", "recv", "sendto", "recvfrom", "gethostbyname",
    "getaddrinfo", "select", "poll", "epoll", "http", "https", "tcp", "udp", "kcp",
  ],
  protocol: [
    "protobuf", "proto", "message", "packet", "frame", "method", "cmd", "request", "response",
    "gateway", "route", "dispatch", "serialize", "deserialize", "encode", "decode",
  ],
  crypto: [
    "aes", "rsa", "sha1", "sha256", "md5", "encrypt", "decrypt", "cipher", "tea", "xxtea",
    "hmac", "random",
  ],
  account: ["account", "login", "auth", "token", "session", "user", "password"],
  battle: ["battle", "room", "match", "frame", "hero", "camp", "team", "settle", "score"],
  shop: ["shop", "store", "goods", "item", "purchase", "order", "currency", "gold", "diamond"],
};

export function classifyStrings(strings) {
  const groups = {};
  for (const [group, keywords] of Object.entries(keywordGroups)) {
    groups[group] = [];
    for (const item of strings) {
      const lower = item.value.toLowerCase();
      if (keywords.some((keyword) => lower.includes(keyword))) {
        groups[group].push(item);
      }
    }
  }
  return groups;
}

export function analyze(inputPath, outputDirectory) {
  const buffer = fs.readFileSync(inputPath);
  const elf = parseElf(buffer);
  const symbols = dynamicSymbols(buffer, elf);
  const strings = extractStrings(buffer);
  const groups = classifyStrings(strings);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const writeFile = (name, contents) =>
    fs.writeFileSync(path.join(outputDirectory, name), contents, "utf8");

  const summary = {
    input: path.resolve(inputPath),
    size: buffer.length,
    sha256: hashBuffer(buffer),
    elf: {
      class: "ELF64",
      endian: "little",
      machine: elf.machine,
      type: elf.type,
      entryPoint: elf.entryPoint,
      sectionHeaderTableOffset: elf.sectionHeaderTableOffset,
      sectionTableAvailable: elf.sectionTableAvailable,
      programHeaders: elf.programHeaders,
      sections: elf.sectionHeaders.map((section) => ({
        index: section.index,
        name: section.name,
        type: section.type,
        flags: section.flags,
        address: section.address,
        offset: section.offset,
        size: section.size,
        link: section.link,
        alignment: section.alignment,
      })),
    },
    dynamicTags: elf.dynamicTags || [],
    symbolCounts: {
      total: symbols.length,
      defined: symbols.filter((symbol) => symbol.defined).length,
      undefined: symbols.filter((symbol) => !symbol.defined).length,
    },
    stringCount: strings.length,
    keywordCounts: Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, items.length])),
    findings: {
      hasGameCoreInfoExports: symbols.some((symbol) => symbol.name === "GameCoreInfo_CoreHash"),
      hasPackBufferExports: symbols.some((symbol) => symbol.name === "PushCsBuffer"),
      hasSettleDataExport: symbols.some((symbol) => symbol.name === "SGC_GetPlayerSettleData"),
      hasIl2CppBridgeStrings: strings.some((item) => item.value.includes("ELF_HOOK_BRIDGE_il2cpp_init")),
      hasNetworkImports: ["socket", "connect", "send", "recv"].every((name) =>
        symbols.some((symbol) => !symbol.defined && symbol.name === name),
      ),
      hasProtectionBridgeImports: symbols.some((symbol) =>
        ["g_tprt_pfn_array", "g_tprt_ori_array"].includes(symbol.name),
      ),
    },
  };

  writeFile("gamecore_analysis.json", `${JSON.stringify(summary, null, 2)}\n`);
  writeFile(
    "dynamic_symbols.txt",
    symbols
      .map((symbol) => `${symbol.defined ? "D" : "U"}\t${symbol.value.toString(16)}\t${symbol.name}`.trimEnd())
      .join("\n") + "\n",
  );
  writeFile(
    "strings_filtered.txt",
    strings.map((item) => `${item.offset.toString(16)}\t${item.value}`).join("\n") + "\n",
  );
  writeFile(
    "keyword_hits.json",
    `${JSON.stringify(groups, null, 2)}\n`,
  );
  writeFile(
    "undefined_imports.txt",
    symbols.filter((symbol) => !symbol.defined).map((symbol) => symbol.name.trimEnd()).join("\n") + "\n",
  );

  return summary;
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function main() {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory) {
    throw new Error("usage: node analyze_gamecore.mjs <libGameCore.so> <output-directory>");
  }
  const summary = analyze(inputPath, outputDirectory);
  console.log(JSON.stringify({
    size: summary.size,
    machine: summary.elf.machine,
    sections: summary.elf.sections.length,
    symbols: summary.symbolCounts,
    strings: summary.stringCount,
    keywordCounts: summary.keywordCounts,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
