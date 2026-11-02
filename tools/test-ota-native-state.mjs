import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), ios = path.join(root, 'apps/ios');
const directory = path.join(root, '.dev/ota-native-state'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
await run('swift', ['build'], ios);
const build = path.join(ios, '.build/debug');
const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/FirmwareStore.swift', 'Checks/FirmwareStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-firmware-checks')], ios);
// 编译与联网旅程分开计时，避免首次 Android 构建耗尽网关旅程的时限。
await run('sh', ['gradlew', '--no-daemon', ':core:test', '--tests', 'run.limeai.iot.core.OtaClientTest', ':app:compileDebugUnitTestKotlin'], path.join(root, 'apps/android'));
await run(process.execPath, ['--test', 'tests/ota-native.test.mjs'], root, { ...process.env, LIMEIOT_OTA_STATE_CHECK: '1' });
