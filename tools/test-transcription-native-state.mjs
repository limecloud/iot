import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url)), ios = path.join(root, 'apps/ios');
const directory = path.join(root, '.dev/transcription-native-state'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}`);
}
await run('swift', ['build'], ios);
await run(path.join(ios, '.build/debug/ClientChecks'), []);
const build = path.join(ios, '.build/debug');
const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/TranscriptionStore.swift', 'Checks/TranscriptionStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-transcription-checks')], ios);
await run(path.join(directory, 'ios-transcription-checks'), []);
await run('swiftc', ['-swift-version', '6', '-typecheck', '-I', path.join(build, 'Modules'), 'App/SecureStore.swift', 'App/FirmwareStore.swift', 'App/MediaStore.swift', 'App/SpeechStore.swift', 'App/TranscriptionStore.swift', 'App/HomeStore.swift'], ios);
await run('swiftc', ['-frontend', '-parse', 'App/TranscriptionViews.swift', 'App/SpeechViews.swift', 'App/MediaViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios);
await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios);
// 装配变更回归媒体选择与有界文件读取，不启动端上环境。
await mkdir(path.join(root, '.dev/media-native-state'), { recursive: true });
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/MediaFile.swift', 'Checks/MediaStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-media-checks')], ios);
await run(path.join(directory, 'ios-media-checks'), []);
await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.TranscriptionClientTest', '--tests', 'run.limeai.iot.core.SpeechClientTest', '--tests', 'run.limeai.iot.core.MediaClientTest', '--tests', 'run.limeai.iot.core.OtaClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.TranscriptionControllerTest', '--tests', 'run.limeai.iot.SpeechControllerTest', '--tests', 'run.limeai.iot.MediaControllerTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
for (const [module, task, names] of [['core', 'test', ['TranscriptionClientTest', 'SpeechClientTest', 'MediaClientTest', 'OtaClientTest']], ['app', 'testDebugUnitTest', ['TranscriptionControllerTest', 'SpeechControllerTest', 'MediaControllerTest']]]) {
  for (const name of names) {
    const file = `TEST-run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}.xml`;
    const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, file), 'utf8');
    await writeFile(path.join(directory, file), xml);
    const expected = { TranscriptionClientTest: 13, TranscriptionControllerTest: 8 }[name];
    if (expected) {
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0]; assert.ok(suite);
      for (const [key, count] of Object.entries({ tests: expected, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${key}="${count}"`));
    }
  }
}
await run(process.execPath, ['--test', '--test-name-pattern=共享', 'tests/transcription-native-contract.test.mjs']);
await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/transcription-native.test.mjs']);
