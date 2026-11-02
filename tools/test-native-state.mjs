import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev', 'native-state-checks');
await mkdir(directory, { recursive: true });
const report = { passed: false, swift_state: false, android_state: false, android_apk: false, native_app_runtime: false, hardware: false };
async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps', 'ios');
    await run('swift', ['build'], ios);
    const build = path.join(ios, '.build', 'debug');
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
    const executable = path.join(directory, 'ios-state-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/SecureStore.swift', 'App/CloudStore.swift', 'Checks/CloudStoreChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, [], root);
    report.swift_state = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', ':core:test', ':app:testDebugUnitTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps', 'android'));
    report.android_state = true; report.android_apk = true;
  }
  report.passed = true;
} finally {
  await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
