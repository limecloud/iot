// 真实NAS容器与预装Ollama模型；不下载模型、不连接已有安装、不测试实机。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest, Agent } from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { root, freePort, until, stop } from './dev-stack.mjs';
import { nasTextModelJourney } from './nas-text-model-journey.mjs';

const exec = promisify(execFile);
const { values } = parseArgs({ options: { image: { type: 'string' }, 'ollama-image': { type: 'string', default: 'ollama/ollama:0.40.13' },
  'models-dir': { type: 'string' }, model: { type: 'string' }, 'no-build': { type: 'boolean' },
  'ollama-executable': { type: 'string' }, 'ollama-host': { type: 'string', default: 'host.docker.internal' },
  capability: { type: 'string', default: 'rules' }, 'ollama-version': { type: 'string', default: '0.40.13' } } });
assert.ok(['rules', 'text'].includes(values.capability));
assert.match(values['ollama-version'], /^\d+\.\d+\.\d+$/);
const textMode = values.capability === 'text', providerService = textMode ? 'text' : 'ollama';
const hostProvider = Boolean(values['ollama-executable']);
assert.ok(!hostProvider || textMode, '--ollama-executable is only supported for the external text service journey');
assert.match(values['ollama-host'], /^(host\.(docker|lima)\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/);
assert.ok(values.model && values['models-dir'], 'set --model and --models-dir to an already installed model cache');
assert.match(values.model, /^[a-zA-Z0-9_./:-]{1,128}$/);
const id = randomBytes(8).toString('hex'), project = 'limeiot-inference-' + id;
const directory = path.join(root, '.dev/nas-inference-' + id), state = path.join(directory, 'installation');
await mkdir(directory, { recursive: true, mode: 0o700 });
const image = values.image ?? 'limeiot/verification:nas-inference-' + id;
assert.match(image, /^limeiot\/verification:[\w.-]+$/);
assert.match(values['ollama-image'], /^(ollama\/ollama:[\w.-]+|limeiot\/verification:[\w.-]+)$/);
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user', model: values.model,
  capability: values.capability, provider_placement: hostProvider ? 'external_host_process' : 'same_machine_container', real_containers: false, real_ollama: false, model_quality_acceptance: false, checks: [] };
let command = ['docker', 'compose'], agent, started = false, currentState = state, ollama, ollamaLog;
try { await exec(command[0], [...command.slice(1), 'version']); } catch { command = ['docker-compose']; }
const override = path.join(directory, 'verification.json');
const env = { ...process.env, LIMEIOT_BIND_HOST: '127.0.0.1', LIMEIOT_MQTT_TLS_PORT: String(await freePort()),
  LIMEIOT_OLLAMA_MODEL: values.model, LIMEIOT_TEXT_MODEL: values.model,
  LIMEIOT_OLLAMA_IMAGE: values['ollama-image'], LIMEIOT_OLLAMA_MODELS_DIR: path.join(directory, 'models') };
if (hostProvider) { env.LIMEIOT_TEXT_URL = new URL(`http://${values['ollama-host']}:${await freePort()}`).origin; env.LIMEIOT_TEXT_CA_FILE = ''; }
const args = extra => [...command.slice(1), '--project-name', project, '--env-file', path.join(currentState, 'compose.env'),
  ...(textMode ? ['compose.yaml', 'compose.media.yaml', hostProvider ? 'compose.text.yaml' : 'compose.text-local.yaml'] : ['compose.yaml', 'compose.ollama.yaml']).flatMap(file => ['-f', path.join(root, 'deploy/nas', file)]), '-f', override,
  '--profile', 'simulation', ...extra];
const compose = extra => exec(command[0], args(extra), { cwd: root, env: { ...env, LIMEIOT_STATE_DIR: currentState }, timeout: 180000, maxBuffer: 2_000_000 });
async function build() {
  const stream = createWriteStream(path.join(directory, 'build.log'), { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['build', '--pull=false', '--tag', image, '--file', 'deploy/nas/Dockerfile', '.'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('nas_build_failed')));
    });
  } finally { stream.end(); }
}
try {
  // 提前核对实际镜像，避免缺少推理提供方时先做无效的NAS构建。
  const inspect = name => exec('docker', ['image', 'inspect', '--format', '{{json .}}', name]).then(r => JSON.parse(r.stdout));
  const provider = hostProvider ? null : await inspect(values['ollama-image']);
  if (!values['no-build']) await build();
  const gateway = await inspect(image);
  report.images = { gateway: gateway.Id, ollama: provider?.Id ?? null };
  report.platforms = { gateway: `${gateway.Os}/${gateway.Architecture}`, ollama: provider ? `${provider.Os}/${provider.Architecture}` : `${os.platform()}/${os.arch()}` };
  if (provider) assert.equal(report.platforms.gateway, report.platforms.ollama);
  assert.equal(gateway.Os, 'linux');
  await cp(path.resolve(values['models-dir']), env.LIMEIOT_OLLAMA_MODELS_DIR, { recursive: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
  if (hostProvider) {
    const port = new URL(env.LIMEIOT_TEXT_URL).port;
    ollamaLog = createWriteStream(path.join(directory, 'ollama.log'), { mode: 0o600 });
    ollama = spawn(path.resolve(values['ollama-executable']), ['serve'], { cwd: directory, env: { ...process.env,
      OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: env.LIMEIOT_OLLAMA_MODELS_DIR, OLLAMA_NO_CLOUD: '1', OLLAMA_NOPRUNE: '1',
      OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_MAX_QUEUE: '1', OLLAMA_CONTEXT_LENGTH: '4096' }, stdio: ['ignore', 'pipe', 'pipe'] });
    ollama.stdout.pipe(ollamaLog, { end: false }); ollama.stderr.pipe(ollamaLog, { end: false });
    let spawnError; ollama.once('error', error => { spawnError = error; });
    await until(async () => {
      if (spawnError) throw spawnError;
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.json()).version === values['ollama-version'];
    }, 30000);
    report.provider_isolation = { placement: 'external_host_process', loopback_listener_only: true, no_cloud: true, dedicated_model_cache_copy: true, container_resource_limits: false };
  }
  const origin = `https://127.0.0.1:${await freePort()}`;
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', state, '--origin', origin, ...(textMode ? ['--media-origin', `http://127.0.0.1:${await freePort()}`] : [])], { cwd: root, timeout: 30000 });
  const overrides = { services: {
    gateway: { image: gateway.Id, pull_policy: 'never' }, lamp: { image: gateway.Id, pull_policy: 'never' },
    button: { image: gateway.Id, pull_policy: 'never' }, edge: { pull_policy: 'never' },
    ...(provider ? { [providerService]: { image: provider.Id, pull_policy: 'never' } } : {}),
  } };
  if (textMode) {
    if (hostProvider) {
      overrides.networks = { text: { internal: true } };
      overrides.services.gateway.networks = { text: {} };
    }
    const control = path.join(directory, 'relay-control'); await mkdir(control, { mode: 0o700 });
    await writeFile(path.join(control, 'mode.json'), JSON.stringify({ mode: 'pass' }), { mode: 0o600 });
    overrides.services['text-relay'] = { image: gateway.Id, pull_policy: 'never', user: `${process.getuid()}:${process.getgid()}`,
      entrypoint: ['python3', '/test-relay.py'], command: [], read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
      cpus: 0.25, mem_limit: '64m', pids_limit: 32, networks: hostProvider ? ['text', 'media'] : ['text'], healthcheck: { disable: true },
      environment: { LIMEIOT_TEST_TEXT_UPSTREAM: hostProvider ? env.LIMEIOT_TEXT_URL : 'http://text:11434' },
      volumes: [{ type: 'bind', source: path.join(root, 'tests/fixtures/text/live-relay.py'), target: '/test-relay.py', read_only: true },
        { type: 'bind', source: control, target: '/control', read_only: true }],
    };
  }
  await writeFile(override, JSON.stringify(overrides), { mode: 0o600 });
  agent = new Agent({ ca: await readFile(path.join(state, 'authority/ca.crt')) });
  let session;
  function call(resource, input, key) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(origin + resource, { agent, method: input === undefined ? 'GET' : 'POST', headers: {
        Origin: origin, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}),
      } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try {
            const cookie = response.headers['set-cookie']?.[0];
            if (cookie && !session) {
              assert.ok(cookie.includes('HttpOnly') && cookie.includes('Secure'));
              session = { cookie: cookie.split(';')[0] };
            }
            resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) });
          } catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.setTimeout(8000, () => request.destroy(new Error('https_timeout')));
      request.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  started = true;
  await compose(['up', '--no-build', '-d', '--wait', '--wait-timeout', '120']);
  report.real_containers = true;
  const ids = (await compose(['ps', '-q'])).stdout.trim().split(/\s+/);
  const containers = JSON.parse((await exec('docker', ['inspect', ...ids])).stdout);
  if (!hostProvider) {
  const inference = containers.find(c => c.Config.Labels['com.docker.compose.service'] === providerService);
  assert.ok(inference.HostConfig.ReadonlyRootfs && inference.HostConfig.CapDrop.includes('ALL'));
  assert.notEqual(inference.Config.User.split(':')[0], '0');
  assert.ok(!Object.values(inference.NetworkSettings.Ports ?? {}).some(value => value?.length));
  const mounts = inference.Mounts.filter(m => m.Type === 'bind');
  assert.equal(mounts.length, 1); assert.equal(mounts[0].Destination, '/models');
  const networks = Object.values(inference.NetworkSettings.Networks); assert.equal(networks.length, 1);
  assert.equal((await exec('docker', ['network', 'inspect', '--format', '{{.Internal}}', networks[0].NetworkID])).stdout.trim(), 'true');
  report.provider_isolation = { non_root: true, readonly_root: true, public_ports: 0, bind_mounts: ['/models'], internal_networks: 1,
    cpu_limit: inference.HostConfig.NanoCpus / 1e9, memory_limit_bytes: inference.HostConfig.Memory };
  report.checks.push('private_non_root_readonly_model_container_without_device_material_or_public_port');
  } else assert.equal(containers.some(c => c.Config.Labels['com.docker.compose.service'] === 'text'), false);
  report.runtime_machines = {};
  for (const service of ['gateway', 'edge', ...(hostProvider ? [] : [providerService])]) report.runtime_machines[service] = (await compose(['exec', '-T', service, 'uname', '-m'])).stdout.trim();
  const machine = { arm64: 'aarch64', amd64: 'x86_64' }[gateway.Architecture];
  assert.ok(machine); for (const runtime of Object.values(report.runtime_machines)) assert.equal(runtime, machine);
  const providerOrigin = hostProvider ? env.LIMEIOT_TEXT_URL : `http://${providerService}:11434`;
  const providerInfo = JSON.parse((await compose(['exec', '-T', 'gateway', 'python3', '-c',
    `import json,urllib.request;print(json.dumps({"version":json.load(urllib.request.urlopen(${JSON.stringify(providerOrigin + '/api/version')},timeout=5)),"tags":json.load(urllib.request.urlopen(${JSON.stringify(providerOrigin + '/api/tags')},timeout=5))}))`])).stdout);
  assert.equal(providerInfo.version.version, values['ollama-version']);
  const installed = providerInfo.tags.models.find(m => m.name === values.model); assert.ok(installed);
  report.model_digest = installed.digest;
  report.real_ollama = true; report.provider_version = providerInfo.version.version;
  const token = (await readFile(path.join(state, 'secrets/owner-token'), 'utf8')).trim();
  const authenticate = async () => {
    // restart返回不代表HTTP已就绪；只等待只读健康检查，不重试登录写入。
    await until(async () => (await call('/healthz')).status === 200, 30000);
    session = undefined;
    const login = await call('/api/v1/auth/session', { token });
    assert.equal(login.status, 200); session.csrf = login.value.csrf_token;
  };
  await authenticate();
  const base = '/api/v1/spaces/space-demo';
  await until(async () => {
    const devices = (await call(base + '/devices')).value.items;
    return devices?.length === 2 && ['device-button', 'device-lamp'].every(id => devices.some(d => d.device_id === id && d.ready));
  }, 30000);
  if (textMode) {
    report.text = await nasTextModelJourney({ directory, state, origin, model: values.model, token, call, compose, authenticate,
      async restore(next) { currentState = next; }, providerService, providerPlacement: report.provider_placement,
      ...(hostProvider ? { providerCalls: async () => ((await readFile(path.join(directory, 'ollama.log'), 'utf8')).match(/\bPOST\s+"?\/api\/chat"?(?:\s|$)/gm) ?? []).length,
        async stopProvider() { await stop(ollama); assert.ok(ollama.exitCode !== null || ollama.signalCode); } } : {}),
      async useRelay() {
        await writeFile(path.join(directory, 'verification.direct.json'), await readFile(override), { mode: 0o600 });
        overrides.services.gateway.environment = { LIMEIOT_TEXT_URL: 'http://text-relay:8000' };
        await writeFile(override, JSON.stringify(overrides), { mode: 0o600 });
        await compose(['up', '--no-build', '-d', '--wait', '--wait-timeout', '90', 'gateway', 'lamp', 'button']);
        await authenticate();
      } });
    report.checks.push('real_text_model_browser_cli_and_api', 'byte_exact_v5_backup_new_installation_restore_without_inference_replay', hostProvider ? 'actual_external_model_process_outage_preserves_manual_device_control' : 'actual_model_container_outage_preserves_manual_device_control');
  } else {
  const key = 'nas-model-original', input = { prompt: '按下按钮时将环境灯亮度设为37，冷却10秒。', expires_at: new Date(Date.now() + 120000).toISOString() };
  assert.equal((await call(base + '/rule-drafts', input, key)).status, 202);
  const draft = await until(async () => { const r = await call(base + '/rule-drafts/by-key/' + key); return r.status === 200 && r.value.status !== 'running' && r.value; }, 110000);
  report.draft = draft;
  assert.equal(draft.status, 'completed');
  assert.deepEqual(draft.rule.trigger, { device: 'device-button', event: 'button.pressed' });
  assert.deepEqual(draft.rule.actions, [{ device: 'device-lamp', set: { path: 'light.brightness', value: 37 } }]);
  assert.equal(draft.rule.cooldown_ms, 10000);
  assert.equal((await call(base + '/commands')).value.items.length, 0);
  assert.equal((await call(base + '/rule-deployments')).value.items.length, 0);
  const proof = await call(base + '/rules:simulate', { rule: draft.rule, event: { device_id: 'device-button', path: 'button.pressed', historical: false, data: { count: 1 } } });
  assert.equal(proof.value.executed, false); assert.equal(proof.value.revision, draft.rule_revision);
  await compose(['stop', 'ollama']);
  assert.equal((await call(base + '/rule-drafts/by-key/' + key)).value.draft_id, draft.draft_id);
  const failedKey = 'nas-model-unavailable';
  assert.equal((await call(base + '/rule-drafts', { ...input, expires_at: new Date(Date.now() + 120000).toISOString() }, failedKey)).status, 202);
  const failed = await until(async () => { const d = (await call(base + '/rule-drafts/by-key/' + failedKey)).value; return d.status !== 'running' && d; }, 30000);
  assert.ok(['rejected', 'unknown'].includes(failed.status)); assert.equal(failed.rule, null); assert.equal(failed.error, 'inference_unavailable');
  const lamp = (await call(base + '/devices/device-lamp')).value;
  const accepted = await call(base + '/commands', { device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 15000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'model-outage-control');
  assert.equal(accepted.status, 202);
  await until(async () => (await call(base + '/commands/' + accepted.value.command_id)).value.status === 'confirmed');
  assert.equal((await call(base + '/commands')).value.items.length, 1);
  assert.equal((await call(base + '/rule-deployments')).value.items.length, 0);
  report.checks.push('real_ollama_container_positive_draft_and_simulation_no_automatic_deployment', 'provider_outage_preserves_original_draft_and_manual_mqtt_control');
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  if (started) {
    const logs = await compose(['logs', '--no-color']).catch(() => null);
    if (logs) await writeFile(path.join(directory, 'containers.log'), logs.stdout, { mode: 0o600 });
  }
  throw error;
} finally {
  agent?.destroy();
  if (started) {
    try { await compose(['down', '--remove-orphans']); report.containers_cleaned = true; }
    catch { report.containers_cleaned = false; report.passed = false; }
  }
  if (ollama) { await stop(ollama); report.external_model_process_cleaned = ollama.exitCode !== null || Boolean(ollama.signalCode); }
  if (ollamaLog) await new Promise(resolve => ollamaLog.end(resolve));
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, hardware: false, report: path.relative(root, path.join(directory, 'report.json')) }));
  if (!report.passed) process.exitCode = 1;
}
