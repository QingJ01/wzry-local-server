import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const METADATA_SANITY = 0xfab11baf;
const METADATA_VERSION = 23;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

const HEADER_TABLES = [
  ["stringLiterals", 0x08, 8],
  ["metadataStrings", 0x18, null],
  ["events", 0x20, 12],
  ["properties", 0x28, 24],
  ["methods", 0x30, 56],
  ["parameterDefaultValues", 0x40, 12],
  ["fieldDefaultValues", 0x48, 8],
  ["parameters", 0x58, 16],
  ["fields", 0x60, 16],
  ["genericParameters", 0x68, 4],
  ["genericParameterConstraints", 0x70, 4],
  ["genericContainers", 0x78, 8],
  ["nestedTypes", 0x80, 4],
  ["interfaces", 0x88, 4],
  ["vtableMethods", 0x90, null],
  ["interfaceOffsets", 0x98, 12],
  ["typeDefinitions", 0xa0, 104],
  ["images", 0xb0, 24],
  ["assemblies", 0xb8, 32],
  ["fieldAndParameterDefaultValueData", 0xc8, 1],
  ["virtualAddressMap", 0xf8, 8],
];

const TARGETS = [
  {
    typeIndex: 5594,
    typeName: "CEncryption",
    methodStart: 41640,
    methodCount: 10,
    fieldStart: null,
    fieldCount: null,
    selectedMethods: ["DeEncryptFile", "EncryptFile", "CryptoFileStream", "DeEncryptFileXOR", "EncryptFileXOR", "CryptoFileXOR"],
  },
  {
    typeIndex: 5706,
    typeName: "SgNet.Script.SgConnector",
    methodStart: 42429,
    methodCount: 25,
    fieldStart: 26641,
    fieldCount: 8,
    selectedMethods: ["Init", "Connect", "Disconnect", "SendData", "ReadData"],
  },
  {
    typeIndex: 5719,
    typeName: "SgNet.Script.SgNetMgr",
    methodStart: 42481,
    methodCount: 8,
    fieldStart: 26683,
    fieldCount: 7,
    selectedMethods: ["CreateConnector", "DestroyConnector"],
  },
  {
    typeIndex: 17193,
    typeName: "Assets.Scripts.Framework.FrameSynchr",
    methodStart: 108166,
    methodCount: 36,
    fieldStart: 147688,
    fieldCount: 34,
    selectedMethods: ["SetSynchrConfigure", "SetKeyFrameIndex", "UpdateFrame", "PushFrameCommand", "SetNetAccIPAndPort", "RealPing"],
  },
  {
    typeIndex: 17195,
    typeName: "Assets.Scripts.Framework.FrameWindow",
    methodStart: 108208,
    methodCount: 58,
    fieldStart: 147728,
    fieldCount: 98,
    selectedMethods: ["OnConfigureParams", "OnSvrGameCoreFrapInfo", "UpdateFrame", "FillFrameHoles", "GetNewSendCmdSeqByPlayerId", "SendGameCmd"],
  },
  {
    typeIndex: 18189,
    typeName: "Assets.Scripts.Framework.LobbyConnector",
    methodStart: 112092,
    methodCount: 28,
    fieldStart: 148839,
    fieldCount: 14,
    selectedMethods: ["Init", "PushSendMsg", "HandleSending", "SendPackage", "PostRecvPackage", "RecvPackage", "LookUpDNSOfServerTongcai"],
  },
  {
    typeIndex: 24933,
    typeName: "ApolloHelper",
    methodStart: 147035,
    methodCount: 102,
    fieldStart: 195644,
    fieldCount: 42,
    selectedMethods: ["Login", "AutoLogin", "LoginHandler", "OnLogin", "OnLoginEvent", "OnRefreshAccessTokenEvent", "GetAccountInfo", "InitPay", "Pay", "GetGoodsFriendsPayUrl", "InitPay4Goods", "Pay4Goods"],
  },
  {
    typeIndex: 27146,
    typeName: "CLoginSystem2",
    methodStart: 164775,
    methodCount: 31,
    fieldStart: 208410,
    fieldCount: 16,
    selectedMethods: ["Init", "RegisterNetworkHandler", "OnLoginSuccess", "OnLoginFail", "OnConnectSuccess", "OnConnectFail"],
  },
  {
    typeIndex: 30081,
    typeName: "Assets.Scripts.GameSystem.CShopSystem",
    methodStart: 184538,
    methodCount: 77,
    fieldStart: 225511,
    fieldCount: 23,
    selectedMethods: ["RefreshShop", "OnShop_BuyItem", "OnShop_BuyItemConfirm", "OnShop_ManualRefresh", "OnRequestGoodsRefershShopItems", "OnReceiveShopItems", "ReceiveItemBuy", "ReceiveShopItems"],
  },
  {
    typeIndex: 5683,
    typeName: "IIPSMobileVersionCallBackImplement",
    methodStart: 42303,
    methodCount: 11,
    fieldStart: 26598,
    fieldCount: 5,
    selectedMethods: ["OnGetNewVersionInfo", "OnActionMsg", "OnNoticeNextAction", "OnNoticeInstallApk", "OnSuccess", "OnError"],
  },
  {
    typeIndex: 4787,
    typeName: "IIPSMobile.VersionMgr",
    methodStart: 34755,
    methodCount: 33,
    fieldStart: 20618,
    fieldCount: 1,
    selectedMethods: ["InitVersionMgr", "CheckAppUpdate", "MgrCheckAppUpdate", "SetNextStage", "MgrSetNextStage", "GetCurDataVersion", "InstallApk"],
  },
  {
    typeIndex: 4794,
    typeName: "IIPSMobile.IIPSMobileVersionCallBackInterface",
    methodStart: 34823,
    methodCount: 10,
    fieldStart: null,
    fieldCount: null,
    selectedMethods: ["OnGetNewVersionInfo", "OnActionMsg", "OnNoticeNextAction", "OnNoticeInstallApk", "OnSuccess"],
  },
];

const STRING_QUERY_TERMS = [
  "BeginConnectHost:",
  "SocketConnectState: SocketConnectSuccess",
  "Socket.BeginReceive ReceiveCallback异常",
  "Socket.BeginSend SendCallback异常",
  "server_url.txt",
  "Account Initialize Encode Error",
  "login.smoba.qq.com",
  "smobaopenidhash",
  "Service_Login_GetAccountInfo",
  "System.Security.Cryptography.AesManaged, System.Core, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
  "keyMakingMethod:",
  "frameData",
  "OnFrameUpdate",
  "Frame Replay!",
  "GetGoodsInfo start!",
  "GetGoodsInfo failed!",
  "payItem=",
  "ApolloPayService Pay!",
  "Service_Buydia",
  "Service_Buyprop",
  "https://pay.qq.com/h5/shop.shtml?store_config_env=",
];

function readCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) {
    return "";
  }
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end === -1 ? buffer.length : end).toString("utf8");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function parseMetadataHeader(buffer) {
  if (buffer.length < 0x108) {
    throw new Error("metadata file is too short for v23 header");
  }
  const sanity = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  if (sanity !== METADATA_SANITY) {
    throw new Error(`metadata sanity mismatch: 0x${sanity.toString(16)}`);
  }
  if (version !== METADATA_VERSION) {
    throw new Error(`unsupported metadata version: ${version}`);
  }

  const tables = {};
  for (const [name, offset, entrySize] of HEADER_TABLES) {
    const size = buffer.readUInt32LE(offset + 4);
    tables[name] = {
      name,
      offset: buffer.readUInt32LE(offset),
      size,
      entrySize,
      count: entrySize === null ? null : size / entrySize,
      rawCount: entrySize === null ? null : size / entrySize,
    };
  }
  tables.stringLiteralData = {
    offset: buffer.readUInt32LE(0x10),
    size: buffer.readUInt32LE(0x14),
    entrySize: null,
    count: null,
  };
  return { sanity, version, tables };
}

function requireTable(buffer, table) {
  const end = table.offset + table.size;
  if (table.offset > buffer.length || end > buffer.length) {
    throw new Error("metadata table is out of bounds");
  }
  return end;
}

function parseStringLiteral(buffer, dataOffset, offset, length) {
  const start = dataOffset + offset;
  if (start + length > buffer.length) {
    throw new Error("string literal is out of bounds");
  }
  return buffer.subarray(start, start + length).toString("utf8");
}

function parseMetadata(buffer) {
  const header = parseMetadataHeader(buffer);
  for (const table of Object.values(header.tables)) {
    requireTable(buffer, table);
    if (table.entrySize !== null) {
      table.count = Math.floor(table.size / table.entrySize);
    }
  }
  header.countDiscrepancies = Object.entries(header.tables)
    .filter(([, table]) => table.entrySize !== null && table.size % table.entrySize !== 0)
    .map(([name, table]) => ({
      table: name,
      declaredCount: table.rawCount,
      completeRecordCount: table.count,
      trailingBytes: table.size % table.entrySize,
    }));
  const metadataStrings = buffer.subarray(
    header.tables.metadataStrings.offset,
    requireTable(buffer, header.tables.metadataStrings),
  );
  header.metadataStrings = {
    offset: header.tables.metadataStrings.offset,
    size: header.tables.metadataStrings.size,
  };

  const methodTable = header.tables.methods;
  if (methodTable.count !== 218980) {
    throw new Error(`unexpected method record count: ${methodTable.count}`);
  }
  requireTable(buffer, methodTable);
  const methods = [];
  for (let index = 0; index < methodTable.count; index += 1) {
    const base = methodTable.offset + index * 56;
    methods.push({
      index,
      name: readCString(metadataStrings, buffer.readUInt32LE(base)),
      declaringType: buffer.readInt32LE(base + 4),
      returnType: buffer.readInt32LE(base + 8),
      parameterStart: buffer.readInt32LE(base + 12),
      genericContainerIndex: buffer.readInt32LE(base + 40),
      token: buffer.readUInt32LE(base + 44),
      parameterCount: buffer.readUInt16LE(base + 54),
    });
  }

  const parameterTable = header.tables.parameters;
  requireTable(buffer, parameterTable);
  const parameters = [];
  for (let index = 0; index < parameterTable.count; index += 1) {
    const base = parameterTable.offset + index * 16;
    parameters.push({
      index,
      name: readCString(metadataStrings, buffer.readUInt32LE(base)),
      token: buffer.readUInt32LE(base + 12),
    });
  }

  const fieldTable = header.tables.fields;
  requireTable(buffer, fieldTable);
  const fields = [];
  for (let index = 0; index < fieldTable.count; index += 1) {
    const base = fieldTable.offset + index * 16;
    fields.push({
      index,
      name: readCString(metadataStrings, buffer.readUInt32LE(base)),
      token: buffer.readUInt32LE(base + 12),
    });
  }

  const typeTable = header.tables.typeDefinitions;
  if (typeTable.count !== 33929) {
    throw new Error(`unexpected type record count: ${typeTable.count}`);
  }
  requireTable(buffer, typeTable);
  const types = [];
  for (let index = 0; index < typeTable.count; index += 1) {
    const base = typeTable.offset + index * 104;
    types.push({
      index,
      offset: base,
      name: readCString(metadataStrings, buffer.readUInt32LE(base)),
      namespace: readCString(metadataStrings, buffer.readUInt32LE(base + 4)),
      parentIndex: buffer.readInt32LE(base + 12),
      elementIndex: buffer.readInt32LE(base + 16),
      fieldStart: buffer.readUInt32LE(base + 48),
      methodStart: buffer.readUInt32LE(base + 52),
      flags1: buffer.readUInt32LE(base + 64),
      flags2: buffer.readUInt16LE(base + 68),
      methodCount: buffer.readUInt16LE(base + 80),
      propertyCount: buffer.readUInt16LE(base + 82),
      fieldCount: buffer.readUInt16LE(base + 84),
      eventCount: buffer.readUInt16LE(base + 86),
      nestedTypeCount: buffer.readUInt16LE(base + 88),
      interfacesCount: buffer.readUInt16LE(base + 90),
      vtableCount: buffer.readUInt16LE(base + 92),
      interfaceOffsetsCount: buffer.readUInt16LE(base + 94),
      bitfield: buffer.readUInt16LE(base + 96),
      token: buffer.readUInt32LE(base + 100),
    });
  }
  requireTable(buffer, typeTable);

  const imageTable = header.tables.images;
  requireTable(buffer, imageTable);
  const images = [];
  for (let index = 0; index < imageTable.count; index += 1) {
    const base = imageTable.offset + index * 24;
    images.push({
      index,
      name: readCString(metadataStrings, buffer.readUInt32LE(base)),
      assemblyIndex: buffer.readInt32LE(base + 4),
      typeStart: buffer.readUInt32LE(base + 8),
      typeCount: buffer.readUInt32LE(base + 12),
      entryPoint: buffer.readUInt32LE(base + 20),
      token: buffer.readUInt32LE(base + 16),
    });
  }

  const literalTable = header.tables.stringLiterals;
  const literalData = header.tables.stringLiteralData;
  requireTable(buffer, literalTable);
  requireTable(buffer, literalData);
  const stringLiterals = [];
  for (let index = 0; index < literalTable.count; index += 1) {
    const base = literalTable.offset + index * 8;
    const length = buffer.readUInt32LE(base);
    const offset = buffer.readUInt32LE(base + 4);
    stringLiterals.push({
      index,
      value: parseStringLiteral(buffer, literalData.offset, offset, length),
    });
  }

  return { header, types, methods, fields, parameters, images, stringLiterals };
}

function parseElf(buffer) {
  if (buffer.length < 64) {
    throw new Error("ELF file is too short");
  }
  if (!buffer.subarray(0, 4).equals(ELF_MAGIC)) {
    throw new Error("ELF magic mismatch");
  }
  if (buffer.readUInt8(4) !== 2 || buffer.readUInt8(5) !== 1) {
    throw new Error("expected ELF64 little-endian");
  }

  const type = buffer.readUInt16LE(0x10);
  const machine = buffer.readUInt16LE(0x12);
  const entryPoint = Number(buffer.readBigUInt64LE(0x18));
  const programHeaderTableOffset = buffer.readUInt32LE(0x20);
  const programHeaderEntrySize = buffer.readUInt16LE(0x36);
  const programCount = buffer.readUInt16LE(0x38);
  const sectionHeaderTableOffset = Number(buffer.readBigUInt64LE(0x28));
  const sectionHeaderEntrySize = buffer.readUInt16LE(0x3a);
  const sectionCount = buffer.readUInt16LE(0x3c);
  const sectionStringTableIndex = buffer.readUInt16LE(0x3e);

  const programHeaders = [];
  for (let index = 0; index < programCount; index += 1) {
    const base = programHeaderTableOffset + index * programHeaderEntrySize;
    programHeaders.push({
      index,
      type: buffer.readUInt32LE(base),
      flags: buffer.readUInt32LE(base + 4),
      offset: Number(buffer.readBigUInt64LE(base + 8)),
      virtualAddress: Number(buffer.readBigUInt64LE(base + 16)),
      fileSize: Number(buffer.readBigUInt64LE(base + 32)),
      memorySize: Number(buffer.readBigUInt64LE(base + 40)),
      alignment: Number(buffer.readBigUInt64LE(base + 48)),
    });
  }

  const sectionTableAvailable =
    sectionHeaderTableOffset + sectionCount * sectionHeaderEntrySize <= buffer.length;
  const sections = [];
  if (sectionTableAvailable) {
    for (let index = 0; index < sectionCount; index += 1) {
      const base = sectionHeaderTableOffset + index * sectionHeaderEntrySize;
      sections.push({
        index,
        nameOffset: buffer.readUInt32LE(base),
        type: buffer.readUInt32LE(base + 4),
        address: Number(buffer.readBigUInt64LE(base + 16)),
        offset: Number(buffer.readBigUInt64LE(base + 24)),
        size: Number(buffer.readBigUInt64LE(base + 32)),
        link: buffer.readUInt32LE(base + 40),
        entrySize: Number(buffer.readBigUInt64LE(base + 56)),
      });
    }
    const names = sections[sectionStringTableIndex];
    const nameTable = names
      ? buffer.subarray(names.offset, names.offset + names.size)
      : Buffer.alloc(0);
    for (const section of sections) {
      section.name = readCString(nameTable, section.nameOffset);
    }
  }

  const dynamicSymbols = [];
  const undefinedImports = [];
  let undefinedSymbolCount = 0;
  const dynamicSection = sections.find((section) => section.name === ".dynsym");
  if (dynamicSection) {
    const dynamicStrings = sections.find((section) => section.name === ".dynstr");
    const names = dynamicStrings
      ? buffer.subarray(dynamicStrings.offset, dynamicStrings.offset + dynamicStrings.size)
      : Buffer.alloc(0);
    const count = Math.floor(dynamicSection.size / 24);
    for (let index = 0; index < count; index += 1) {
      const base = dynamicSection.offset + index * 24;
      const symbol = {
        index,
        name: readCString(names, buffer.readUInt32LE(base)),
        value: Number(buffer.readBigUInt64LE(base + 8)),
        size: Number(buffer.readBigUInt64LE(base + 16)),
        info: buffer.readUInt8(base + 4),
        sectionIndex: buffer.readUInt16LE(base + 6),
      };
      dynamicSymbols.push(symbol);
      if (
        symbol.sectionIndex === 0 &&
        symbol.name &&
        symbol.index !== 0
      ) {
        undefinedImports.push(symbol.name);
      }
      if (symbol.sectionIndex === 0) {
        undefinedSymbolCount += 1;
      }
    }
  }

  const buildIdSection = sections.find((section) => section.name === ".note.gnu.build-id");
  let buildId = null;
  if (buildIdSection) {
    const base = buildIdSection.offset;
    if (base + 0x24 <= buffer.length) {
      const nameSize = buffer.readUInt32LE(base);
      const descriptorSize = buffer.readUInt32LE(base + 4);
      const descriptorOffset = base + 12 + nameSize;
      if (
        nameSize === 4 &&
        descriptorSize === 20 &&
        descriptorOffset + descriptorSize <= buffer.length
      ) {
        buildId = buffer.subarray(descriptorOffset, descriptorOffset + descriptorSize).toString("hex");
      }
    }
  }

  return {
    class: 2,
    endian: 1,
    type,
    machine,
    entryPoint,
    programHeaders,
    sectionHeaderTableOffset,
    sectionHeaderEntrySize,
    sectionCount,
    sectionTableAvailable,
    sections,
    buildId,
    dynamicSymbolCount: dynamicSymbols.length,
    definedSymbolCount: dynamicSymbols.length - undefinedSymbolCount,
    undefinedImportCount: undefinedSymbolCount,
    dynamicSymbols,
    undefinedImports,
  };
}

function fullName(type) {
  return type.namespace ? `${type.namespace}.${type.name}` : type.name;
}

function buildTargets(metadata, targets) {
  const typeIndex = new Map(metadata.types.map((type) => [type.index, type]));
  return targets.map((target) => {
    const type = typeIndex.get(target.typeIndex);
    if (!type) {
      throw new Error(`missing target type index ${target.typeIndex}`);
    }
    if (fullName(type) !== target.typeName) {
      throw new Error(`type mismatch: expected ${target.typeName}, found ${fullName(type)}`);
    }
    if (type.methodStart !== target.methodStart || type.methodCount !== target.methodCount) {
      throw new Error(`method range mismatch for ${target.typeName}`);
    }

    const methods = metadata.methods
      .slice(type.methodStart, type.methodStart + type.methodCount)
      .map((method) => {
        const hasParameterRange =
          method.parameterStart >= 0 && method.parameterCount > 0;
        const parameterNames = hasParameterRange
          ? metadata.parameters
              .slice(
                method.parameterStart,
                method.parameterStart + method.parameterCount,
              )
              .map((parameter) => parameter.name)
          : [];
        return {
          index: method.index,
          name: method.name,
          token: method.token,
          parameters: parameterNames,
          selected: target.selectedMethods.includes(method.name),
        };
      });

    let fields = [];
    if (target.fieldStart !== null) {
      if (type.fieldStart !== target.fieldStart || type.fieldCount !== target.fieldCount) {
        throw new Error(`field range mismatch for ${target.typeName}`);
      }
      fields = metadata.fields
        .slice(type.fieldStart, type.fieldStart + type.fieldCount)
        .map((field) => ({
          index: field.index,
          name: field.name,
          token: field.token,
          selected: target.selectedFields?.includes(field.name) ?? false,
        }));
    }

    return {
      typeIndex: type.index,
      typeName: fullName(type),
      typeOffset: type.offset,
      typeToken: type.token,
      methodStart: type.methodStart,
      methodCount: type.methodCount,
      fieldStart: type.fieldStart,
      fieldCount: type.fieldCount,
      methods,
      fields,
    };
  });
}

function searchStrings(stringLiterals, terms) {
  return terms.map((term) => {
    const matches = stringLiterals.filter((literal) => literal.value.includes(term));
    return {
      term,
      matchCount: matches.length,
      matches: matches.slice(0, 10).map((literal) => ({
        index: literal.index,
        value: literal.value,
      })),
    };
  });
}

function toJsonFriendlyMetadata(metadata, targets) {
  return {
    header: metadata.header,
    images: metadata.images.map((image) => ({
      index: image.index,
      name: image.name,
      assemblyIndex: image.assemblyIndex,
      typeStart: image.typeStart,
      typeCount: image.typeCount,
      token: image.token,
      entryPoint: image.entryPoint,
    })),
    targets,
  };
}

function writeTextEvidence(outputDirectory, targets, stringResults) {
  const lines = [];
  for (const target of targets) {
    lines.push(`TARGET ${target.typeIndex} ${target.typeName} TYPE_OFF 0x${target.typeOffset.toString(16)}`);
    for (const method of target.methods) {
      lines.push(
        `METHOD ${method.index} ${method.name} TOKEN 0x${method.token.toString(16)} PARAMS ${method.parameters.join(",")}`,
      );
    }
    for (const field of target.fields) {
      lines.push(`FIELD ${field.index} ${field.name}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(outputDirectory, "target-index.txt"), lines.join("\n"), "utf8");

  const stringLines = [];
  for (const result of stringResults) {
    for (const match of result.matches) {
      stringLines.push(`STRING ${match.index} ${JSON.stringify(match.value)}`);
    }
  }
  fs.writeFileSync(path.join(outputDirectory, "string-hits.txt"), stringLines.join("\n"), "utf8");
}

function main() {
  const [apkPath, metadataPath, libraryPath, outputDirectory] = process.argv.slice(2);
  if (!apkPath || !metadataPath || !libraryPath || !outputDirectory) {
    console.error(
      "usage: node analyze_il2cpp.mjs <3.81.1.8.apk> <global-metadata.dat> <libil2cpp.so> <output-directory>",
    );
    process.exit(1);
  }

  const apkBuffer = fs.readFileSync(apkPath);
  const metadataBuffer = fs.readFileSync(metadataPath);
  const libraryBuffer = fs.readFileSync(libraryPath);
  const metadata = parseMetadata(metadataBuffer);
  const elf = parseElf(libraryBuffer);
  const targets = buildTargets(metadata, TARGETS);
  const stringResults = searchStrings(metadata.stringLiterals, STRING_QUERY_TERMS);

  const runtimeOffsets = Object.fromEntries(
    ["JNI_OnLoad", "il2cpp_init", "il2cpp_method_get_name", "il2cpp_runtime_invoke", "il2cpp_domain_assembly_open"]
      .map((name) => {
        const symbol = elf.dynamicSymbols.find((candidate) => candidate.name === name);
        return [name, symbol ? symbol.value : null];
      }),
  );

  const symbolNames = new Set(elf.dynamicSymbols.map((symbol) => symbol.name));
  const result = {
    apk: { path: apkPath, size: apkBuffer.length, sha256: sha256(apkBuffer) },
    metadata: {
      path: metadataPath,
      size: metadataBuffer.length,
      sha256: sha256(metadataBuffer),
      ...toJsonFriendlyMetadata(metadata, targets),
    },
    library: {
      path: libraryPath,
      size: libraryBuffer.length,
      sha256: sha256(libraryBuffer),
      elf: {
        class: elf.class,
        endian: elf.endian,
        type: elf.type,
        machine: elf.machine,
        entryPoint: elf.entryPoint,
        programCount: elf.programHeaders.length,
        sectionCount: elf.sectionCount,
        sectionTableAvailable: elf.sectionTableAvailable,
        buildId: elf.buildId,
        dynamicSymbolCount: elf.dynamicSymbolCount,
        definedSymbolCount: elf.definedSymbolCount,
        undefinedImportCount: elf.undefinedImportCount,
        sections: elf.sections.map((section) => ({
          name: section.name,
          address: section.address,
          offset: section.offset,
          size: section.size,
        })),
      },
      runtimeOffsets,
      imports: {
        connect: elf.undefinedImports.includes("connect"),
        send: elf.undefinedImports.includes("send"),
        recv: elf.undefinedImports.includes("recv") || elf.undefinedImports.includes("recvfrom"),
      },
      protection: {
        hasCodeRegistrationSymbol: symbolNames.has("g_CodeRegistration"),
        hasMetadataRegistrationSymbol: symbolNames.has("g_MetadataRegistration"),
        hasMscorlibString: libraryBuffer.toString("latin1").includes("mscorlib.dll"),
      },
    },
    stringResults,
    limits: {
      directMetadataMethodOffsetsRecovered: false,
      reason: "CodeRegistration and MetadataRegistration are not statically recoverable from the protected library",
    },
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "il2cpp_analysis.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeTextEvidence(outputDirectory, targets, stringResults);
  console.log(`IL2CPP analysis written to ${path.resolve(outputDirectory)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, "/")}`).href) {
  main();
}
