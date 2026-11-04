import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRecordedPcm } from '../packages/protocol/pcm-recording.mjs';
import { verifyPcmWav } from '../packages/protocol/media.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev/recording-native'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
const report = { passed: false, target: selected ?? 'both', swift_recording_state: false, swift_media_regression: false, apple_adapter_macos_typecheck: false, swiftui_parse: false, android_recording_state: false, android_media_regression: false, android_apk: false, android_lint: false, native_app_runtime: false, system_microphone: false, hardware: false, published: false, full_goal_completed: false };
async function checkPcm(file) {
  const bytes = await readFile(file); const format = verifyPcmWav(bytes);
  assert.equal(format.sample_rate, 16000); assert.equal(format.channels, 1); assert.equal(format.frames, 5);
  assert.deepEqual(bytes, Buffer.from(encodeRecordedPcm(new Int16Array([-32768, -1, 0, 1, 32767]))));
}
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    const executable = path.join(directory, 'ios-recording-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/RecordingStore.swift', 'App/AppleRecordingInput.swift', 'App/MediaStore.swift', 'Checks/RecordingStoreChecks.swift', 'Checks/RecordingLiveChecks.swift', ...objects, '-o', executable], ios);
    const pcm = path.join(directory, 'swift-recording.wav');
    await run(executable, [], root, { ...process.env, LIMEIOT_RECORDING_PCM_OUTPUT: pcm }); await checkPcm(pcm);
    report.swift_recording_state = report.apple_adapter_macos_typecheck = true;
    await mkdir(path.join(root, '.dev/media-native-state'), { recursive: true });
    const media = path.join(directory, 'ios-media-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/MediaStore.swift', 'App/MediaFile.swift', 'Checks/MediaStoreChecks.swift', ...objects, '-o', media], ios);
    await run(media, []); report.swift_media_regression = true;
    await run('swiftc', ['-frontend', '-parse', 'App/MediaViews.swift', 'App/RecordingStore.swift', 'App/AppleRecordingInput.swift'], ios);
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_parse = true;
  }
  if (!selected || selected === 'android') {
    const pcm = path.join(directory, 'android-recording.wav');
    const mediaTests = ['recordedSelectionIsOwnedAndClearedWithoutRemovingManualFile', 'localSelectionApprovalAndCancelledDeletionNeverWrite', 'invalidLocalFilePreservesManagementAndOfflineClearsTransientState', 'readFailureKeepsLastObservationAnd401ReachesHome', 'cancelledSavedIntentRemainsUnknownAndNeverPosts', 'boundedReaderStopsAtLimitAndHonorsCancellation'];
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':core:test', '--rerun', '--tests', 'run.limeai.iot.core.PcmRecordingTest', '--tests', 'run.limeai.iot.core.MediaClientTest', '--tests', 'run.limeai.iot.core.MediaTargetTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.RecordingControllerTest', ...mediaTests.flatMap(n => ['--tests', 'run.limeai.iot.MediaControllerTest.' + n]), ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'), { ...process.env, LIMEIOT_RECORDING_PCM_OUTPUT: pcm });
    for (const [module, task, name, count] of [['core', 'test', 'core.PcmRecordingTest', 2], ['core', 'test', 'core.MediaClientTest', 9], ['core', 'test', 'core.MediaTargetTest', 4], ['app', 'testDebugUnitTest', 'RecordingControllerTest', 7], ['app', 'testDebugUnitTest', 'MediaControllerTest', 6]]) {
      const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, `TEST-run.limeai.iot.${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      for (const [key, value] of Object.entries({ tests: count, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, `TEST-run.limeai.iot.${name}.xml`), xml);
    }
    await checkPcm(pcm); report.android_recording_state = report.android_media_regression = report.android_apk = report.android_lint = true;
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
