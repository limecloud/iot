import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
let command = ['docker', 'compose'];
try { await exec(command[0], [...command.slice(1), 'version']); }
catch { command = ['docker-compose']; }
const env = { ...process.env, LIMEIOT_UID: '10001', LIMEIOT_GID: '10001',
  LIMEIOT_STATE_DIR: path.join(root, '.dev/nas-config-only'), LIMEIOT_PUBLIC_ORIGIN: 'https://nas.example.test:8443',
  LIMEIOT_HTTPS_PORT: '8443', LIMEIOT_OLLAMA_MODEL: 'qwen3:0.6b',
  LIMEIOT_OLLAMA_MODELS_DIR: path.join(root, '.dev/nas-config-models') };
for (const name of ['LIMEIOT_OLLAMA_IMAGE', 'LIMEIOT_OLLAMA_URL', 'LIMEIOT_OLLAMA_CA_FILE',
  'LIMEIOT_OLLAMA_CPUS', 'LIMEIOT_OLLAMA_MEMORY_LIMIT']) delete env[name];
async function config(files, overrides = {}) {
  const next = { ...env, ...overrides };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  const args = files.flatMap(file => ['-f', path.join(root, 'deploy/nas', file)]);
  const result = await exec(command[0], [...command.slice(1), ...args, 'config', '--format', 'json'], { cwd: root, env: next });
  return JSON.parse(result.stdout);
}

test('可选模型覆盖保留网关与控制面网络，模型没有公开端口或设备材料', async () => {
  const base = await config(['compose.yaml']);
  assert.equal(base.services.ollama, undefined);
  for (const files of [['compose.yaml', 'compose.ollama.yaml'], ['compose.yaml', 'compose.platform.yaml', 'compose.ollama.yaml']]) {
    const value = await config(files), { gateway, ollama } = value.services;
    assert.ok(Object.hasOwn(gateway.networks, 'local') && Object.hasOwn(gateway.networks, 'inference'));
    if (files.includes('compose.platform.yaml')) {
      assert.ok(Object.hasOwn(gateway.networks, 'platform-link'));
      assert.equal(gateway.environment.LIMEIOT_CONTROL_CA_FILE, '/config/control-ca.crt');
      assert.equal(gateway.environment.LIMEIOT_CONTROL_RELAY_ENABLED, '1');
      assert.ok(!Object.hasOwn(value.services.control.networks, 'inference'));
    }
    assert.equal(gateway.environment.LIMEIOT_OLLAMA_URL, 'http://ollama:11434');
    assert.ok(!gateway.depends_on?.ollama, '推理故障不能阻止本地控制启动');
    assert.equal(value.networks.inference.internal, true);
    assert.deepEqual(Object.keys(ollama.networks), ['inference']);
    assert.ok(!ollama.ports?.length);
    assert.equal(ollama.read_only, true); assert.notEqual(ollama.user.split(':')[0], '0');
    assert.deepEqual(ollama.cap_drop, ['ALL']);
    assert.equal(ollama.volumes.length, 1);
    assert.equal(ollama.volumes[0].target, '/models');
    assert.equal(ollama.volumes[0].bind.create_host_path, false);
    assert.ok(ollama.mem_limit > 0 && Number(ollama.cpus) > 0);
    assert.ok(!Object.keys(ollama.environment).some(key => /TOKEN|PASSWORD|MQTT|LIMEIOT/.test(key)));
  }
});

test('缺少明确模型或缓存路径时拒绝启用，外部模型覆盖保持独立', async () => {
  for (const key of ['LIMEIOT_OLLAMA_MODEL', 'LIMEIOT_OLLAMA_MODELS_DIR']) {
    await assert.rejects(config(['compose.yaml', 'compose.ollama.yaml'], { [key]: undefined }));
  }
  const external = await config(['compose.yaml', 'compose.inference.yaml'], { LIMEIOT_OLLAMA_URL: 'http://192.168.1.30:11434' });
  assert.equal(external.services.ollama, undefined);
  assert.equal(external.services.gateway.environment.LIMEIOT_OLLAMA_URL, 'http://192.168.1.30:11434');
});
