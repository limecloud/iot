import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createTranscriptionOriginal, parseTranscriptionInput, verifyTranscriptionCapabilities, verifyTranscriptionTask } from '../packages/protocol/transcription.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile);
await mkdir(path.join(root, '.dev'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.dev/transcription-native-contract-'));
async function native(command, args, target) {
  try {
    const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(directory, target + '.log'), result.stdout + result.stderr);
    return result.stdout;
  } catch (error) {
    await writeFile(path.join(directory, target + '.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
}
test('原生语音共享Unicode、时区和任务向量符合正式JS及Schema合同', async () => {
  const vector = JSON.parse(await readFile(path.join(root, 'tests/fixtures/transcription/contract.json'), 'utf8'));
  assert.deepEqual(parseTranscriptionInput(JSON.stringify(vector.input)), vector.normalized);
  assert.equal(vector.normalized.expires_at, '2026-11-03T00:01:25.123Z');
  assert.deepEqual(await createTranscriptionOriginal('https://nas.local', 'space-demo', 'original', vector.input), vector.original);
  verifyTranscriptionCapabilities(vector.capabilities);
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/transcription.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv); ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id + '#/$defs/task');
  for (const task of Object.values(vector.tasks)) {
    await verifyTranscriptionTask(task, 'space-demo', 'original', vector.original);
    assert.equal(validate(task), true, JSON.stringify(validate.errors));
  }
  for (const [name, task] of Object.entries(vector.invalid_tasks)) await assert.rejects(verifyTranscriptionTask(task, 'space-demo', 'original', vector.original), /invalid_transcription_response/, name);
});
test('Swift语音库的耐久意图、未知恢复、响应漂移及取消检查', { timeout: 190000 }, async () => {
  const output = await native('swift', ['run', 'ClientChecks'], 'ios');
  assert.match(output, /"transcription_contract_checks":13/);
  await writeFile(path.join(directory, 'ios-result.json'), JSON.stringify({ passed: true, groups: 13, host_library: true, swiftui: false, native_app_runtime: false, real_gateway: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});
test('Kotlin语音库的耐久意图、未知恢复、响应漂移及取消检查', { timeout: 190000 }, async () => {
  await native('sh', ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.TranscriptionClientTest'], 'android');
  const xml = await readFile(path.join(root, 'apps/android/core/build/test-results/test/TEST-run.limeai.iot.core.TranscriptionClientTest.xml'), 'utf8');
  const suite = xml.match(/<testsuite\b[^>]*>/)?.[0];
  assert.ok(suite); for (const [name, count] of Object.entries({ tests: 13, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${name}="${count}"`));
  await writeFile(path.join(directory, 'android-tests.xml'), xml);
  await writeFile(path.join(directory, 'android-result.json'), JSON.stringify({ passed: true, tests: 13, host_library: true, compose_ui: false, native_app_runtime: false, real_gateway: false, hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false }, null, 2) + '\n');
});
test.after(() => console.log(JSON.stringify({ transcription_native_contract_evidence: directory })));
