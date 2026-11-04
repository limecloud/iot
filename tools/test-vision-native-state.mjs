import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url)), ios = path.join(root, 'apps/ios');
const directory = path.join(root, '.dev/vision-native-state'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code ?? result.signal}`);
}
await run('swift', ['build'], ios);
await run(path.join(ios, '.build/debug/ClientChecks'), []);
const build = path.join(ios, '.build/debug');
const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/VisionStore.swift', 'App/MediaFile.swift', 'Checks/VisionStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-vision-checks')], ios);
await run(path.join(directory, 'ios-vision-checks'), []);
await run('swiftc', ['-swift-version', '6', '-typecheck', '-I', path.join(build, 'Modules'), 'App/SecureStore.swift', 'App/FirmwareStore.swift', 'App/MediaStore.swift', 'App/SpeechStore.swift', 'App/TranscriptionStore.swift', 'App/VisionStore.swift', 'App/TextGenerationStore.swift', 'App/VoiceTurnStore.swift', 'App/CompanionStore.swift', 'App/ObservationStore.swift', 'App/ZigbeeStore.swift', 'App/HomeStore.swift'], ios);
await run('swiftc', ['-frontend', '-parse', 'App/VisionViews.swift', 'App/TranscriptionViews.swift', 'App/SpeechViews.swift', 'App/MediaViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios);
await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios);
// 共享有界读取器保留音频默认上限；端上系统选择器另行验收。
await mkdir(path.join(root, '.dev/media-native-state'), { recursive: true });
await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/MediaFile.swift', 'Checks/MediaStoreChecks.swift', ...objects, '-o', path.join(directory, 'ios-media-checks')], ios);
await run(path.join(directory, 'ios-media-checks'), []);
const suites = [
  ['core', 'test', { VisionClientTest: 13, SpeechClientTest: 10, TranscriptionClientTest: 13, MediaClientTest: 9, OtaClientTest: 7 }],
  ['app', 'testDebugUnitTest', { VisionControllerTest: 9, SpeechControllerTest: 7, TranscriptionControllerTest: 8, MediaControllerTest: 6 }],
];
const gradle = ['gradlew', '--no-daemon', '--configure-on-demand'];
for (const [module, task, names] of suites) {
  gradle.push(`:${module}:${task}`);
  for (const name of Object.keys(names)) gradle.push('--tests', `run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}`);
}
gradle.push(':app:assembleDebug', ':app:lintDebug');
await run('sh', gradle, path.join(root, 'apps/android'));
for (const [module, task, names] of suites) {
  for (const [name, expected] of Object.entries(names)) {
    const file = `TEST-run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}.xml`;
    const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, file), 'utf8');
    await writeFile(path.join(directory, file), xml);
    const suite = xml.match(/<testsuite\b[^>]*>/)?.[0]; assert.ok(suite);
    // 既有媒体端到端方法只在专用媒体环境启用，单列且不计通过；其余方法不得跳过。
    const expectedSkipped = name === 'MediaControllerTest' ? ['originalRecoveryPlaybackAndProcessRestart'] : [];
    const skippedCases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
      .filter(match => /<skipped\b/.test(match[2] ?? '')).map(match => match[1].match(/\bname="([^"]+)"/)?.[1]);
    assert.deepEqual(skippedCases, expectedSkipped);
    for (const [key, count] of Object.entries({ tests: expected, failures: 0, errors: 0, skipped: expectedSkipped.length })) assert.match(suite, new RegExp(`\\b${key}="${count}"`));
    if (expectedSkipped.length) console.log(JSON.stringify({ known_media_journey_skipped_not_counted: expectedSkipped }));
  }
}
await run(process.execPath, ['--test', '--test-name-pattern=共享', 'tests/vision-native-contract.test.mjs']);
await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/vision-native.test.mjs'], root, { ...process.env, LIMEIOT_VISION_STATE_CHECK: '1' });
