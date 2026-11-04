import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceStack, base } from '../tests/helpers/voice-turns.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const selected = process.argv[2];
if (selected && !['fixture', 'ios', 'android'].includes(selected)) throw new Error('select fixture, ios or android');
const directory = path.join(root, '.dev/voice-turn-native');
await mkdir(directory, { recursive: true });
const fixturePath = path.join(directory, 'fixture.json');
const env = { ...process.env, LIMEIOT_VOICE_TURN_FIXTURE: fixturePath, LIMEIOT_VOICE_TEST_CLASSPATH: path.join(directory, 'android-classpath.txt') };
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}

// 从真实Rust网关捕获合成提供方任务，供三个SDK比较；不导出会话或凭据。
async function capture() {
  const cleanup = [];
  try {
    const s = await voiceStack({ after: work => cleanup.push(work) });
    const now = Date.now(), records = [];
    const journal = { load: s.journal.load, async save(previous, next) { await s.journal.save(previous, next); records.push(structuredClone(next)); } };
    const c = s.client({ origin: 'https://nas.local', now: () => now, journal });
    const input = s.input('native-shared');
    const capabilities = await s.request(base + '/capabilities');
    const media = await s.request(base + '/media');
    await c.start(input); const view = await s.complete(c);
    assert.equal(view.phase, 'succeeded'); assert.deepEqual(s.calls, ['transcription', 'text', 'speech']);
    const tasks = {};
    for (const [kind, family] of Object.entries({ transcription: 'audio-transcriptions', text: 'text-generations', speech: 'speech-syntheses' })) {
      tasks[kind] = await s.request(`${base}/${family}/by-key/${input.turn_id}-${kind}`);
    }
    const succeeded = JSON.parse(s.memory.raw);
    await c.stop(); const stopped = JSON.parse(s.memory.raw);
    const clearedText = await s.request(`${base}/text-generations/by-key/${input.turn_id}-text`);
    assert.deepEqual(s.errors, []); assert.equal(s.fixture.effects.length, 0);
    const prepared = records.find(v => v.jobs.transcription?.observation === null);
    const ready = records.find(v => v.jobs.transcription?.observation?.status === 'succeeded' && v.jobs.text === null);
    assert.ok(prepared && ready);
    const fixture = { now, input, capabilities, media, tasks, succeeded, stopped, cleared_text: clearedText, prepared, ready };
    await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
  } finally { for (const work of cleanup.reverse()) await work(); }
}

const report = { passed: false, real_gateway_fixture: false, swift_sdk_and_state: false, swift_home_state: false, swiftui_parse: false, android_sdk: false, android_state: false, android_home_state: false, android_apk: false, android_lint: false, synthetic_providers: true, native_app_runtime: false, hardware: false, full_goal_completed: false };
try {
  await capture(); report.real_gateway_fixture = true;
  if (selected === 'fixture') { report.passed = true; }
  else {
    if (!selected || selected === 'ios') {
      const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
      await run('swift', ['build'], ios);
      const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
      const executable = path.join(directory, 'ios-voice-turn-checks');
      await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/VoiceTurnStore.swift', 'Checks/VoiceTurnChecks.swift', 'Checks/VoiceTurnLiveChecks.swift', ...objects, '-o', executable], ios);
      await run(executable, []); report.swift_sdk_and_state = true;
      const stores = ['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'];
      const home = path.join(directory, 'ios-home-checks');
      await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...stores.map(n => `App/${n}.swift`), 'Checks/HomeStoreChecks.swift', ...objects, '-o', home], ios);
      await run(home, []); report.swift_home_state = true;
      await run('swiftc', ['-frontend', '-parse', 'App/VoiceTurnViews.swift', 'App/MediaViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios);
      await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_parse = true;
    }
    if (!selected || selected === 'android') {
      await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', '--init-script', path.join(root, 'tools/voice-turn-native.gradle'), ':core:test', '--rerun', '--tests', 'run.limeai.iot.core.VoiceTurnClientTest', ':app:testDebugUnitTest', '--rerun', '--tests', 'run.limeai.iot.VoiceTurnControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
      for (const [module, task, name, count] of [['core', 'test', 'run.limeai.iot.core.VoiceTurnClientTest', 5], ['app', 'testDebugUnitTest', 'run.limeai.iot.VoiceTurnControllerTest', 2], ['app', 'testDebugUnitTest', 'run.limeai.iot.HomeViewModelTest', 6]]) {
        const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, `TEST-${name}.xml`), 'utf8');
        const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
        assert.match(suite, new RegExp(`\\btests="${count}"`));
        for (const key of ['failures', 'errors', 'skipped']) assert.match(suite, new RegExp(`\\b${key}="0"`));
        await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
      }
      report.android_sdk = report.android_state = report.android_home_state = report.android_apk = report.android_lint = true;
    }
    report.passed = true;
  }
} finally { await writeFile(path.join(directory, selected ? `${selected}-report.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
