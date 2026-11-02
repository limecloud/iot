import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
import { actionState, base, startActionStack } from './helpers/actions.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile);
for (const target of ['ios', 'android']) for (const modelName of ['android-tv', 'android-tv-remote']) test(`${target}/${modelName}动作客户端：真实HTTP/MQTT、模型发现、回执范围和丢响应只查原键`, { timeout: 180000 }, async t => {
  const stack = await startActionStack({ modelPath: path.join(root, 'contracts/models', modelName + '.json') }); t.after(() => stack.close());
  const command = target === 'ios' ? 'swift' : 'sh';
  const args = target === 'ios' ? ['run', 'ClientChecks'] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--rerun-tasks'];
  let result;
  try {
    result = await exec(command, args, { cwd: path.join(root, 'apps', target), env: { ...stack.env, LIMEIOT_ACTION_CHECK: '1' }, timeout: 160000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    await writeFile(path.join(stack.directory, target + '.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  await writeFile(path.join(stack.directory, target + '.log'), result.stdout + result.stderr);
  const state = await actionState(stack);
  assert.equal(state.action_log.length, 2, 'lost response must not duplicate an action');
  const commands = (await stack.request(base + '/commands')).value.items;
  assert.equal(commands.length, 2);
  assert.deepEqual(new Set(commands.map(item => item.request.operation.path)), new Set(['remote.press', 'apps.launch']));
  for (const command of commands) {
    assert.equal(command.status, 'confirmed'); assert.equal(command.evidence.type, 'action_result'); assert.equal(command.evidence.completion, 'submitted');
    assert.equal(command.evidence.input_digest, await documentDigest(command.request.operation.value));
  }
  if (modelName === 'android-tv-remote') assert.deepEqual(state.reported, {});
  await writeFile(path.join(stack.directory, 'actions-native-result.json'), JSON.stringify({ passed: true, target, model: modelName, empty_properties_model: modelName === 'android-tv-remote', real_http: true, real_mqtt: true, typed_model: true, response_loss: true, original_key_only: true, remote_commands: false, native_app_runtime: false, hardware: false }));
});
