import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import frida from 'frida';

const logPath = process.argv[2];
const captureSeconds = Number(process.argv[3] || 60);
const attachMode = process.argv[4] === 'attach';
const packageId = 'com.tencent.tmgp.sgame';
const adbPath = 'D:\\project\\poxxiao\\tools\\android-sdk\\platform-tools\\adb.exe';
const scriptPath = path.resolve(import.meta.dirname, 'wzry-network.js');

if (!logPath || !Number.isFinite(captureSeconds) || captureSeconds <= 0) {
  console.error('Usage: node tools/frida/run-network-capture.mjs <log-path> <seconds>');
  process.exit(2);
}

const resolvedLogPath = path.resolve(logPath);
const outputDirectory = path.dirname(resolvedLogPath);
mkdirSync(outputDirectory, { recursive: true });
const metadataPath = `${resolvedLogPath}.metadata.json`;
let metadataWritten = false;
const writeFailure = error => {
  appendFileSync(metadataPath, `${JSON.stringify({
    failedAt: new Date().toISOString(),
    error: String(error?.stack || error)
  }, null, 2)}\n`);
  process.exit(1);
};

const log = (value) => {
  appendFileSync(resolvedLogPath, `${JSON.stringify(value)}\n`);
};
process.on('uncaughtException', error => {
  writeFailure(error);
});
process.on('unhandledRejection', error => {
  writeFailure(error);
});

const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
let processId = null;
let spawnedProcess = null;
if (attachMode) {
  execFileSync(adbPath, [
    '-s', '192.168.5.102:5555',
    'shell',
    'am', 'start', '-n', `${packageId}/.SGameActivity`
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      processId = Number(execFileSync(adbPath, [
        '-s', '192.168.5.102:5555',
        'shell',
        'pidof', packageId
      ], { encoding: 'utf8' }).trim());
      if (Number.isInteger(processId) && processId > 0) {
        break;
      }
    } catch {
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!(Number.isInteger(processId) && processId > 0)) {
    throw new Error(`Could not find ${packageId} process for attach mode`);
  }
} else {
  spawnedProcess = await device.spawn(packageId);
  processId = spawnedProcess;
}

const session = await device.attach(processId);
const script = await session.createScript(await import('node:fs').then(fs => fs.readFileSync(scriptPath, 'utf8')));
script.message.connect((message, data) => {
  log({ timestamp: new Date().toISOString(), message, data: data ? data.toString('hex') : null });
});
await script.load();
if (spawnedProcess !== null) {
  await device.resume(spawnedProcess);
}

appendFileSync(metadataPath, `${JSON.stringify({
  startedAt: new Date().toISOString(),
  packageId,
  pid: processId,
  attachMode,
  remoteDevice: '127.0.0.1:27042',
  scriptPath,
  captureSeconds,
  logPath: resolvedLogPath,
}, null, 2)}\n`);
metadataWritten = true;

await new Promise(resolve => setTimeout(resolve, captureSeconds * 1000));
try {
  await session.detach();
} catch {
  await session.destroy();
}
appendFileSync(metadataPath, `${JSON.stringify({ stoppedAt: new Date().toISOString() }, null, 2)}\n`);
if (!attachMode) {
  execFile(adbPath, ['-s', '192.168.5.102:5555', 'shell', 'am', 'force-stop', packageId], () => {});
}
