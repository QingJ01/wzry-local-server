#!/usr/bin/env node
// Sign an APK with apksigner without going through an interactive shell.
import { spawnSync } from 'node:child_process';

const JAVA = 'D:\\project\\poxxiao\\tools\\java17\\bin\\java.exe';
const SIGNER = 'D:\\project\\poxxiao\\tools\\android-sdk\\build-tools\\36.1.0\\lib\\apksigner.jar';

const [,, mode, ...rest] = process.argv;
let args;
if (mode === 'sign') {
  const [inputApk, outputApk] = rest;
  args = ['-jar', SIGNER, 'sign',
    '--ks', 'client/keys/wzry-debug.keystore',
    '--ks-key-alias', 'wzry-debug',
    '--ks-pass', 'pass:wzry-local-debug',
    '--key-pass', 'pass:wzry-local-debug',
    '--min-sdk-version', '24',
    '--out', outputApk, inputApk];
} else if (mode === 'verify') {
  const [apk] = rest;
  args = ['-jar', SIGNER, 'verify', '--verbose', '--min-sdk-version', '24', apk];
} else {
  console.error('usage: node sign_apk_direct.mjs sign <in> <out> | verify <apk>');
  process.exit(2);
}
const r = spawnSync(JAVA, args, { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
