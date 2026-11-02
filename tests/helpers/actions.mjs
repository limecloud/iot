import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { root, startStack, until } from '../../tools/dev-stack.mjs';

const exec = promisify(execFile);
export const base = '/api/v1/spaces/space-demo';
export const post = (body, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
export async function startActionStack(options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(root, '.dev/actions-'));
  const modelPath = options.modelPath ?? path.join(root, 'contracts/models/android-tv.json');
  const result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], {
    cwd: root, env: { ...process.env, LIMEIOT_MODEL_VALIDATOR: path.join(root, 'target/debug/limeiot-model-validator') }, timeout: 5000,
  });
  const report = JSON.parse(result.stdout); assert.equal(report.valid, true);
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
  config.models[0] = report.normalized_model;
  config.devices[0].model_revision = report.model_revision;
  const configPath = path.join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  return startStack({ ...options, directory, modelPaths: { lamp: modelPath }, gatewayEnv: { ...options.gatewayEnv, LIMEIOT_CONFIG: configPath } });
}
export async function actionInput(stack, path = 'remote.press', value = { key: 'home' }, lifetime = 5000) {
  const device = (await stack.request(base + '/devices/device-lamp')).value;
  return { device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + lifetime).toISOString(), operation: { type: 'action.invoke', path, value } };
}
export async function commandResult(stack, id, status = 'confirmed') {
  return until(async () => {
    const result = await stack.request(base + '/commands/' + id);
    assert.equal(result.status, 200);
    if (result.value.status === 'failed') throw new Error(JSON.stringify(result.value));
    return result.value.status === status && result.value;
  });
}
export async function actionState(stack) {
  return JSON.parse(await readFile(path.join(stack.directory, 'lamp.json'), 'utf8'));
}
