import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), ios = path.join(root, 'apps/ios');
const directory = path.join(root, '.dev/media-native-state'); await mkdir(directory, { recursive: true });
const artifacts = ['target/debug/limeiot-gateway', 'target/debug/limeiot-model-validator', 'target/debug/limeiot-simulator'];
async function artifactDigests() {
  return Object.fromEntries(await Promise.all(artifacts.map(async name => [name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')])));
}
const before = await artifactDigests();
async function run(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}`);
}
await run('swift', ['build'], ios);
const build = path.join(ios, '.build/debug');
const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
const binary = path.join(directory, 'ios-media-checks');
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/MediaFile.swift', 'Checks/MediaStoreChecks.swift', ...objects, '-o', binary], ios);
await run(binary, [], root);
// 构建先于有时限的真实网关旅程，原生测试复用同一后端夹具与合同校验。
await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.MediaTargetTest', '--tests', 'run.limeai.iot.core.MediaClientTest', '--tests', 'run.limeai.iot.core.OtaClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.MediaControllerTest'], path.join(root, 'apps/android'));
for (const [module, task, names] of [['core', 'test', ['MediaTargetTest', 'MediaClientTest', 'OtaClientTest']], ['app', 'testDebugUnitTest', ['MediaControllerTest']]]) {
  for (const name of names) {
    const file = `TEST-run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}.xml`;
    await writeFile(path.join(directory, file), await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, file)));
  }
}
await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/media-targets.test.mjs', 'tests/media-native.test.mjs'], root, { ...process.env, LIMEIOT_MEDIA_STATE_CHECK: '1' });
const after = await artifactDigests(), unchanged = artifacts.every(name => before[name] === after[name]);
await writeFile(path.join(directory, 'artifacts.json'), JSON.stringify({ passed: unchanged, before, after }, null, 2) + '\n');
if (!unchanged) throw new Error('backend artifacts changed during native state checks');
