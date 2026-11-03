import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, freePort } from '../tools/dev-stack.mjs';
const exec = promisify(execFile);

test('提供方配置Schema与固定模型示例：规则文件必须精确对应', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'providers/sherpa-tts/config.schema.json'), 'utf8'));
  const example = JSON.parse(await readFile(path.join(root, 'providers/sherpa-tts/aishell3.example.json'), 'utf8'));
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  for (const value of [{ ...example, threads: 0 }, { ...example, voices: { local: true } }, { ...example, rule_fsts: [] }, { ...example, files: { ...example.files, '../model': 'a'.repeat(64) } }]) assert.equal(validate(value), false);
});

test('NAS本地语音服务：内部网络、只读模型、无主机端口及凭据挂载', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(root, '.dev/sherpa-compose-'));
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443', '--media-origin', `http://127.0.0.1:${await freePort()}`], { cwd: root, timeout: 30000 });
  let command = ['docker', 'compose']; try { await exec(command[0], [...command.slice(1), 'version']); } catch { command = ['docker-compose']; }
  const args = [...command.slice(1), '--env-file', path.join(directory, 'compose.env'), '-f', 'deploy/nas/compose.yaml', '-f', 'deploy/nas/compose.media.yaml', '-f', 'deploy/nas/compose.sherpa.yaml', 'config', '--format', 'json'];
  const env = { ...process.env, LIMEIOT_TTS_MODEL: 'vits-icefall-zh-aishell3', LIMEIOT_TTS_VOICES: 'mandarin', LIMEIOT_TTS_MODELS_DIR: path.join(directory, 'models'), LIMEIOT_TTS_CONFIG_FILE: path.join(directory, 'provider.json') };
  const rendered = JSON.parse((await exec(command[0], args, { cwd: root, env, timeout: 15000 })).stdout), speech = rendered.services.speech;
  assert.equal(rendered.services.gateway.environment.LIMEIOT_TTS_URL, 'http://speech:8000');
  assert.deepEqual(Object.keys(speech.networks), ['speech']); assert.equal(rendered.networks.speech.internal, true);
  for (const name of ['local', 'media', 'speech']) assert.ok(name in rendered.services.gateway.networks);
  // 模型服务故障不能阻塞网关冷启动或本地控制。
  assert.equal(rendered.services.gateway.depends_on?.speech, undefined);
  assert.equal(speech.read_only, true); assert.deepEqual(speech.cap_drop, ['ALL']); assert.deepEqual(speech.security_opt, ['no-new-privileges:true']);
  assert.equal((speech.ports ?? []).length, 0); assert.equal(speech.pids_limit, 64); assert.ok(speech.mem_limit > 0); assert.ok(speech.cpus > 0);
  assert.deepEqual(speech.volumes.map(v => v.target).sort(), ['/config/provider.json', '/models']);
  assert.equal(speech.volumes.every(v => v.read_only && v.bind.create_host_path === false), true);
  assert.equal(Object.keys(speech.environment).some(key => /TOKEN|PASSWORD|SECRET/.test(key)), false);
  assert.equal(speech.volumes.some(v => /secrets|gateway\.sqlite|docker\.sock/.test(v.source)), false);
  const report = { passed: true, compose_rendered: true, no_gateway_startup_dependency: true, private_network: true, no_published_ports: true, read_only_models_and_config: true, no_device_credentials_or_gateway_storage: true, container_runtime: false, image_built: false, cross_architecture_runtime: false, hardware: false, full_goal_completed: false };
  await writeFile(path.join(directory, 'sherpa-compose-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'sherpa-compose-result.json') }));
});
