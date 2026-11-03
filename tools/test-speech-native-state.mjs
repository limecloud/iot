import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), ios = path.join(root, 'apps/ios');
const directory = path.join(root, '.dev/speech-native-state'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}`);
}
await run('swift', ['build'], ios);
await run(path.join(ios, '.build/debug/ClientChecks'), []);
const build = path.join(ios, '.build/debug');
const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/SpeechStore.swift', 'Checks/SpeechStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-speech-checks')], ios);
await run(path.join(directory, 'ios-speech-checks'), []);
await run('swiftc', ['-swift-version', '6', '-typecheck', '-I', path.join(build, 'Modules'), 'App/SecureStore.swift', 'App/FirmwareStore.swift', 'App/MediaStore.swift', 'App/SpeechStore.swift', 'App/TranscriptionStore.swift', 'App/HomeStore.swift'], ios);
await run('swiftc', ['-frontend', '-parse', 'App/SpeechViews.swift', 'App/MediaViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios);
await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios);
// 媒体选择改动回归已有状态与有界文件读取，不启动旧的端上环境。
await mkdir(path.join(root, '.dev/media-native-state'), { recursive: true });
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/MediaFile.swift', 'Checks/MediaStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-media-checks')], ios);
await run(path.join(directory, 'ios-media-checks'), []);
await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.SpeechClientTest', '--tests', 'run.limeai.iot.core.MediaClientTest', '--tests', 'run.limeai.iot.core.OtaClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.SpeechControllerTest', '--tests', 'run.limeai.iot.MediaControllerTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
for (const [module, task, names] of [['core', 'test', ['SpeechClientTest', 'MediaClientTest', 'OtaClientTest']], ['app', 'testDebugUnitTest', ['SpeechControllerTest', 'MediaControllerTest']]]) {
  for (const name of names) {
    const file = `TEST-run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}.xml`;
    await writeFile(path.join(directory, file), await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, file)));
  }
}
await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/speech-native.test.mjs']);
