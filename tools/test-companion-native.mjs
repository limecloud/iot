import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanionClient } from '../packages/protocol/companion.mjs';
import { voiceStack, transcript, answer, base } from '../tests/helpers/voice-turns.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const selected = process.argv[2];
if (selected && !['fixture', 'ios', 'android'].includes(selected)) throw new Error('select fixture, ios or android');
const directory = path.join(root, '.dev/companion-native-20261104');
await mkdir(directory, { recursive: true });
const fixturePath = selected && selected !== 'fixture' ? path.join(root, 'tests/fixtures/companions/contract.json') : path.join(directory, 'fixture.json');
const env = { ...process.env, LIMEIOT_COMPANION_FIXTURE: fixturePath, LIMEIOT_VOICE_TEST_CLASSPATH: path.join(directory, 'android-classpath.txt') };
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
async function capture() {
  const cleanup = [];
  try {
    const policy = { schema_version: 1, policy_id: 'block-puppy', version: '1.0.0', name: '积木小狗豆豆', instructions: '你是积木小狗豆豆。用简短中文陪用户搭积木，不调用工具。', language: 'zh', voice: 'local', max_turns: 2, max_seconds: 300 };
    const s = await voiceStack({ after: work => cleanup.push(work) }, { inspectText(input, index) {
      assert.equal(input.messages[1].content, policy.instructions);
      assert.deepEqual(input.messages.slice(2), index === 0 ? [{ role: 'user', content: transcript }] : [{ role: 'user', content: transcript }, { role: 'assistant', content: answer }, { role: 'user', content: transcript }]);
    } });
    const now = Date.now(), records = [];
    const journal = { load: s.journal.load, async save(previous, next) { await s.journal.save(previous, next); records.push(structuredClone(next)); } };
    const client = new CompanionClient({ origin: 'https://nas.local', space: 'space-demo', journal, request: s.request, policy, now: () => now });
    const capabilities = await s.request(base + '/capabilities'), media = await s.request(base + '/media');
    const started = (await client.start('native-companion')).record;
    await client.reply(s.media.media_id); const first = (await s.complete(client)).record;
    await client.reply(s.media.media_id); const second = (await s.complete(client)).record;
    const tasks = {};
    for (let i = 1; i <= 2; i++) {
      tasks[i] = {};
      for (const [kind, family] of Object.entries({ transcription: 'audio-transcriptions', text: 'text-generations', speech: 'speech-syntheses' })) tasks[i][kind] = await s.request(`${base}/${family}/by-key/native-companion_t${i}-${kind}`);
    }
    const stopped = (await client.stop()).record, cleared = {};
    for (let i = 1; i <= 2; i++) cleared[i] = await s.request(`${base}/text-generations/by-key/native-companion_t${i}-text`);
    assert.equal(s.calls.length, 6); assert.deepEqual(s.errors, []); assert.equal(s.fixture.effects.length, 0);
    const preparedSlot = records.find(v => v.turns.length === 1 && v.turns[0].record === null);
    const prepared = records.find(v => v.turns[0]?.record?.jobs.transcription?.observation === null);
    const ready = records.find(v => v.turns[0]?.record?.jobs.transcription?.observation?.status === 'succeeded' && v.turns[0].record.jobs.text === null);
    assert.ok(preparedSlot && prepared && ready);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, JSON.stringify({ now, policy, capabilities, media, started, first, second, stopped, tasks, cleared, prepared_slot: preparedSlot, prepared, ready }, null, 2) + '\n');
  } finally { for (const work of cleanup.reverse()) await work(); }
}
const report = { passed: false, real_gateway_fixture: false, swift_sdk: false, swift_state: false, swift_home_state: false, swiftui_parse: false, android_sdk: false, android_state: false, android_apk: false, android_lint: false, synthetic_providers: true, native_app_runtime: false, hardware: false, full_goal_completed: false };
try {
  // 只在明确生成时更新共享夹具；平台复验使用同一份固定输入。
  if (!selected || selected === 'fixture') { await capture(); report.real_gateway_fixture = true; }
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    const executable = path.join(directory, 'ios-companion-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/CompanionStore.swift', 'Checks/CompanionChecks.swift', 'Checks/CompanionLiveChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, []); report.swift_sdk = report.swift_state = true;
    const home = path.join(directory, 'ios-home-checks'), stores = ['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'];
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...stores.map(name => `App/${name}.swift`), 'Checks/HomeStoreChecks.swift', ...objects, '-o', home], ios);
    await run(home, []); report.swift_home_state = true;
    await run('swiftc', ['-frontend', '-parse', 'App/CompanionViews.swift', 'App/MediaViews.swift', 'App/LimeIoTApp.swift'], ios);
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_parse = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':core:test', '--rerun', '--tests', 'run.limeai.iot.core.CompanionClientTest', '--tests', 'run.limeai.iot.core.VoiceTurnClientTest'], path.join(root, 'apps/android'));
    for (const [name, count] of [['CompanionClientTest', 5], ['VoiceTurnClientTest', 5]]) {
      const xml = await readFile(path.join(root, `apps/android/core/build/test-results/test/TEST-run.limeai.iot.core.${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      assert.match(suite, new RegExp(`\\btests="${count}"`));
      for (const key of ['failures', 'errors', 'skipped']) assert.match(suite, new RegExp(`\\b${key}="0"`));
      await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
    }
    report.android_sdk = true;
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', '--init-script', path.join(root, 'tools/voice-turn-native.gradle'), ':app:testDebugUnitTest', '--rerun', '--tests', 'run.limeai.iot.CompanionControllerTest', '--tests', 'run.limeai.iot.VoiceTurnControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
    for (const [name, count] of [['CompanionControllerTest', 2], ['VoiceTurnControllerTest', 2], ['HomeViewModelTest', 6]]) {
      const xml = await readFile(path.join(root, `apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      assert.match(suite, new RegExp(`\\btests="${count}"`));
      for (const key of ['failures', 'errors', 'skipped']) assert.match(suite, new RegExp(`\\b${key}="0"`));
      await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
    }
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
    report.android_state = report.android_apk = report.android_lint = true;
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, `${selected ?? 'all'}-report.json`), JSON.stringify(report, null, 2) + '\n'); }
