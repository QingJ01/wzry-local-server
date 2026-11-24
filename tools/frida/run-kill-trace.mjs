import { execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import frida from 'frida';

const logPath = process.argv[2];
const captureSeconds = Number(process.argv[3] || 120);
const launchApp = process.argv[4] !== 'nolaunch';
const packageId = 'com.tencent.tmgp.sgame';
const adbPath = 'D:\\project\\poxxiao\\tools\\android-sdk\\platform-tools\\adb.exe';
const serial = '192.168.5.102:5555';
const scriptPath = path.resolve(import.meta.dirname, 'wzry-kill-trace.js');

if (!logPath || !Number.isFinite(captureSeconds) || captureSeconds <= 0) {
  console.error('Usage: node tools/frida/run-kill-trace.mjs <log-path> <seconds> [nolaunch]');
  process.exit(2);
}

const resolvedLogPath = path.resolve(logPath);
mkdirSync(path.dirname(resolvedLogPath), { recursive: true });
const metadataPath = `${resolvedLogPath}.metadata.json`;

const log = (value) => {
  appendFileSync(resolvedLogPath, `${JSON.stringify(value)}\n`);
};
const fail = (error) => {
  appendFileSync(metadataPath, `${JSON.stringify({ failedAt: new Date().toISOString(), error: String(error?.stack || error) }, null, 2)}\n`);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');

let processId = null;
if (launchApp) {
  execFileSync(adbPath, ['-s', serial, 'shell', 'am', 'start', '-n', `${packageId}/.SGameActivity`], { stdio: 'ignore' });
}
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    processId = Number(execFileSync(adbPath, ['-s', serial, 'shell', 'pidof', packageId], { encoding: 'utf8' }).trim());
    if (Number.isInteger(processId) && processId > 0) break;
  } catch {}
  await new Promise(r => setTimeout(r, 250));
}
if (!(Number.isInteger(processId) && processId > 0)) {
  throw new Error(`Could not find ${packageId} process to attach`);
}

const session = await device.attach(processId);
const script = await session.createScript(readFileSync(scriptPath, 'utf8'));
script.message.connect((message, data) => {
  log({ timestamp: new Date().toISOString(), message, data: data ? data.toString('hex') : null });
});
await script.load();

appendFileSync(metadataPath, `${JSON.stringify({
  startedAt: new Date().toISOString(),
  packageId,
  pid: processId,
  attachMode: true,
  launchApp,
  remoteDevice: '127.0.0.1:27042',
  scriptPath,
  captureSeconds,
  logPath: resolvedLogPath,
}, null, 2)}\n`);

// Keep attached; if the process dies, the device session emits 'detached'.
let detached = false;
session.detached.connect(() => {
  detached = true;
  log({ timestamp: new Date().toISOString(), event: 'session-detached', pid: processId });
});

const deadline = Date.now() + captureSeconds * 1000;
while (Date.now() < deadline && !detached) {
  await new Promise(r => setTimeout(r, 250));
}
if (!detached) {
  try { await session.detach(); } catch { await session.destroy(); }
}
appendFileSync(metadataPath, `${JSON.stringify({ stoppedAt: new Date().toISOString(), detached }, null, 2)}\n`);
