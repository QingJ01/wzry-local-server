import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const archivePath = path.resolve("3.81.1.67.zip");
const outputDirectory = path.resolve("workspace/apk");
const outputFileName = "3.81.1.8.apk";
const outputFilePath = path.join(outputDirectory, outputFileName);
const temporaryFilePath = `${outputFilePath}.extracting`;

const expectedArchiveSha256 = "D6E5215CA4FEBDC37DA7BF1C93A27C5FCB7725138459834A2380078F36EAD5FA";
const expectedApkEntryName = "安装包/3.81.1.8.apk";
const expectedApkSha256 = "A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D";
const expectedApkSize = 460_348_136;
const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const localFileSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const chunkSize = 16 * 1024 * 1024;

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(chunkSize);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex").toUpperCase();
};

function findApkEntry(fileDescriptor, archiveSize) {
  let chunkLength = 16 * 1024 * 1024;
  while (chunkLength <= archiveSize) {
    const chunkOffset = archiveSize - chunkLength;
    const chunk = Buffer.alloc(chunkLength);
    fs.readSync(fileDescriptor, chunk, 0, chunkLength, chunkOffset);
    let signatureIndex = -1;
    while ((signatureIndex = chunk.indexOf(centralDirectorySignature, signatureIndex + 1)) >= 0) {
      const record = chunk.subarray(signatureIndex);
      if (record.length < 46) continue;
      const nameLength = record.readUInt16LE(28);
      if (record.length < 46 + nameLength) continue;
      const entryName = record.subarray(46, 46 + nameLength).toString("utf8");
      if (entryName !== expectedApkEntryName) continue;
      const compressionMethod = record.readUInt16LE(10);
      const compressedSize = record.readUInt32LE(20);
      const uncompressedSize = record.readUInt32LE(24);
      const localHeaderOffset = record.readUInt32LE(42);
      return {
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
    }
    chunkLength *= 4;
  }
  throw new Error(`APK entry not found: ${expectedApkEntryName}`);
}

function validateLocalHeader(fileDescriptor, centralEntry) {
  const localHeader = Buffer.alloc(30);
  fs.readSync(fileDescriptor, localHeader, 0, 30, centralEntry.localHeaderOffset);
  if (!localHeader.subarray(0, 4).equals(localFileSignature)) {
    throw new Error(`Invalid local header signature at ${centralEntry.localHeaderOffset}`);
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const compressionMethod = localHeader.readUInt16LE(8);
  const compressedSize = localHeader.readUInt32LE(18);
  const uncompressedSize = localHeader.readUInt32LE(22);
  if (compressionMethod !== 0) throw new Error(`APK entry must be stored, got method ${compressionMethod}`);
  if (compressedSize !== expectedApkSize || uncompressedSize !== expectedApkSize) {
    throw new Error(`APK size mismatch: compressed=${compressedSize}, uncompressed=${uncompressedSize}`);
  }
  return centralEntry.localHeaderOffset + 30 + nameLength + extraLength;
}

function extractApk(fileDescriptor, dataOffset) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(temporaryFilePath, { force: true });
  const outputDescriptor = fs.openSync(temporaryFilePath, "wx");
  const buffer = Buffer.alloc(chunkSize);
  try {
    let remaining = expectedApkSize;
    let position = dataOffset;
    while (remaining > 0) {
      const bytesToRead = Math.min(buffer.length, remaining);
      const bytesRead = fs.readSync(fileDescriptor, buffer, 0, bytesToRead, position);
      if (bytesRead !== bytesToRead) throw new Error(`Short read at ${position}`);
      fs.writeSync(outputDescriptor, buffer, 0, bytesRead);
      remaining -= bytesRead;
      position += bytesRead;
    }
  } finally {
    fs.closeSync(outputDescriptor);
  }
}

if (sha256File(archivePath) !== expectedArchiveSha256) {
  throw new Error("Source archive SHA-256 mismatch");
}
if (fs.existsSync(outputFilePath)) {
  throw new Error(`Output already exists: ${outputFilePath}`);
}

const archiveDescriptor = fs.openSync(archivePath, "r");
try {
  const archiveSize = fs.fstatSync(archiveDescriptor).size;
  const centralEntry = findApkEntry(archiveDescriptor, archiveSize);
  if (centralEntry.compressionMethod !== 0) throw new Error("APK entry is not stored");
  if (centralEntry.compressedSize !== expectedApkSize || centralEntry.uncompressedSize !== expectedApkSize) {
    throw new Error(`Central directory APK size mismatch: ${centralEntry.compressedSize}/${centralEntry.uncompressedSize}`);
  }
  const dataOffset = validateLocalHeader(archiveDescriptor, centralEntry);
  if (dataOffset + expectedApkSize > archiveSize) throw new Error("APK data exceeds archive bounds");
  extractApk(archiveDescriptor, dataOffset);
} finally {
  fs.closeSync(archiveDescriptor);
}

const actualSha256 = sha256File(temporaryFilePath);
if (actualSha256 !== expectedApkSha256) {
  fs.rmSync(temporaryFilePath, { force: true });
  throw new Error(`Extracted APK SHA-256 mismatch: ${actualSha256}`);
}
fs.renameSync(temporaryFilePath, outputFilePath);

console.log(JSON.stringify({
  archive: archivePath,
  archiveSha256: expectedArchiveSha256,
  apkEntry: expectedApkEntryName,
  output: outputFilePath,
  apkSize: expectedApkSize,
  apkSha256: actualSha256,
}, null, 2));
