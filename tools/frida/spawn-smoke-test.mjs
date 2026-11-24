import frida from 'frida';

const packageId = process.argv[2] || 'com.tencent.tmgp.sgame';
const device = await frida.getDeviceManager().addRemoteDevice('127.0.0.1:27042');
const spawnedProcess = await device.spawn(packageId);
console.log(JSON.stringify({ pid: spawnedProcess }));
await device.resume(spawnedProcess);
await new Promise(resolve => setTimeout(resolve, 3000));
console.log(JSON.stringify({ stoppedAt: new Date().toISOString() }));
await device.kill(spawnedProcess);
