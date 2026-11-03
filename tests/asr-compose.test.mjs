import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root, freePort } from '../tools/dev-stack.mjs';
const exec = promisify(execFile);

test('ASR固定模型配置Schema：拒绝引擎、线程、路径和字段漂移', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'providers/sherpa-asr/config.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  for (const file of ['whisper-tiny.example.json', 'paraformer-small.example.json']) {
    const example = JSON.parse(await readFile(path.join(root, 'providers/sherpa-asr', file), 'utf8'));
    assert.equal(validate(example), true, JSON.stringify(validate.errors));
    for (const value of [{ ...example, threads: 0 }, { ...example, threads: true }, { ...example, engine: 'other' }, { ...example, engine: file.startsWith('whisper') ? 'paraformer-small-int8' : 'whisper-tiny-int8' }, { ...example, files: { ...example.files, '../model': 'a'.repeat(64) } }, { ...example, extra: 1 }]) assert.equal(validate(value), false);
  }
});

test('NAS TTS与ASR并存：独立内部网络、只读模型、无端口和网关启动依赖', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(root, '.dev/asr-compose-'));
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443', '--media-origin', `http://127.0.0.1:${await freePort()}`], { cwd: root, timeout: 30000 });
  let command = ['docker', 'compose']; try { await exec(command[0], [...command.slice(1), 'version']); } catch { command = ['docker-compose']; }
  const args = [...command.slice(1), '--env-file', path.join(directory, 'compose.env'), '-f', 'deploy/nas/compose.yaml', '-f', 'deploy/nas/compose.media.yaml', '-f', 'deploy/nas/compose.sherpa.yaml', '-f', 'deploy/nas/compose.sherpa-asr.yaml', 'config', '--format', 'json'];
  const env = { ...process.env, LIMEIOT_TTS_MODEL: 'vits-icefall-zh-aishell3', LIMEIOT_TTS_VOICES: 'mandarin', LIMEIOT_TTS_MODELS_DIR: path.join(directory, 'tts-models'), LIMEIOT_TTS_CONFIG_FILE: path.join(directory, 'tts.json'), LIMEIOT_ASR_MODEL: 'paraformer-small-int8', LIMEIOT_ASR_MODELS_DIR: path.join(directory, 'asr-models'), LIMEIOT_ASR_CONFIG_FILE: path.join(directory, 'asr.json') };
  const rendered = JSON.parse((await exec(command[0], args, { cwd: root, env, timeout: 15000 })).stdout), gateway = rendered.services.gateway;
  assert.equal(gateway.environment.LIMEIOT_ASR_URL, 'http://transcription:8000'); assert.equal(gateway.environment.LIMEIOT_TTS_URL, 'http://speech:8000');
  for (const name of ['local', 'media', 'speech', 'transcription']) assert.ok(name in gateway.networks);
  for (const name of ['speech', 'transcription']) {
    const service = rendered.services[name]; assert.equal(gateway.depends_on?.[name], undefined);
    assert.deepEqual(Object.keys(service.networks), [name]); assert.equal(rendered.networks[name].internal, true);
    assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ['ALL']); assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.equal((service.ports ?? []).length, 0); assert.equal(service.pids_limit, 64); assert.ok(service.mem_limit > 0); assert.ok(service.cpus > 0);
    assert.deepEqual(service.volumes.map(v => v.target).sort(), ['/config/provider.json', '/models']);
    assert.equal(service.volumes.every(v => v.read_only && v.bind.create_host_path === false), true);
    assert.equal(Object.keys(service.environment).some(key => /TOKEN|PASSWORD|SECRET/.test(key)), false);
    assert.equal(service.volumes.some(v => /secrets|gateway\.sqlite|docker\.sock/.test(v.source)), false);
  }
  await writeFile(path.join(directory, 'asr-compose-result.json'), JSON.stringify({ passed: true, compose_rendered: true, tts_asr_coexist: true, separate_internal_networks: true, no_gateway_startup_dependency: true, read_only_models: true, no_device_credentials: true, container_runtime: false, image_built: false, hardware: false, full_goal_completed: false }, null, 2));
  console.log(JSON.stringify({ report: path.join(directory, 'asr-compose-result.json') }));
});
