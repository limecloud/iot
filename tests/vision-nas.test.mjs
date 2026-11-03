import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { root, freePort, until, stop } from '../tools/dev-stack.mjs';
import { base, post, input, png, visionStack } from './helpers/vision.mjs';
const exec = promisify(execFile), snapshot = 'data/gateway.sqlite.media.json', manager = path.join(root, 'deploy/nas/manage.py');
test('NAS视觉v4原字节备份与新目录恢复，运行中任务只恢复unknown，容器配置隔离', { timeout: 150000 }, async t => {
  const parent = await mkdtemp(path.join(root, '.dev/vision-nas-')), installation = path.join(parent, 'installation'), backup = path.join(parent, 'backup'), restored = path.join(parent, 'restored');
  const manage = (...args) => exec('python3', [manager, ...args], { cwd: root, timeout: 45000 });
  await manage('init', '--directory', installation, '--origin', 'https://127.0.0.1:18443');
  const secret = async name => (await readFile(path.join(installation, 'secrets', name), 'utf8')).trim();
  const credentials = { owner: await secret('owner-token'), gateway: await secret('gateway-password'), lamp: await secret('device-lamp-password'), button: await secret('device-button-password') };
  const { stack, calls, errors, text, holds, setMode, finish } = await visionStack(t, { directory: path.join(installation, 'data'), credentials });
  await manage('media-config', '--directory', installation, '--media-origin', stack.env.LIMEIOT_MEDIA_ORIGIN);
  assert.equal((await stack.request(base + '/vision-observations', post(input(), 'completed'))).status, 202); assert.equal((await finish('completed')).output.text, text);
  setMode('hold'); assert.equal((await stack.request(base + '/vision-observations', post(input(), 'running'))).status, 202); await until(() => holds.length === 1);
  const bytes = await readFile(path.join(installation, snapshot)); assert.equal(JSON.parse(bytes).schema_version, 4);
  await manage('backup', '--directory', installation, '--output', backup); assert.deepEqual(await readFile(path.join(backup, snapshot)), bytes); assert.equal((await stat(path.join(backup, snapshot))).mode & 0o777, 0o600);
  await manage('restore', '--directory', restored, '--backup', backup); assert.deepEqual(await readFile(path.join(restored, snapshot)), bytes);
  stack.env.LIMEIOT_DB = path.join(restored, 'data/gateway.sqlite'); stack.env.LIMEIOT_CONFIG = path.join(restored, 'config/gateway.json'); await stack.restartGateway();
  assert.equal((await finish('completed')).output.text, text); assert.equal((await finish('running')).status, 'unknown'); assert.equal((await stack.request(base + '/vision-observations', post(input(), 'blocked'))).status, 429); assert.equal(calls.length, 2);
  await stack.request(base + '/vision-observations/by-key/running/discard', post({})); holds.shift()(); await stack.request(base + '/vision-observations/by-key/completed/discard', post({})); await stack.restartGateway(); assert.equal((await finish('completed')).output.text, null); assert.equal((await finish('running')).status, 'discarded'); assert.equal(calls.length, 2); assert.deepEqual(errors, []);
  let compose = ['docker', 'compose']; try { await exec('docker', ['compose', 'version']); } catch { compose = ['docker-compose']; }
  const models = path.join(parent, 'models'); await mkdir(models);
  const render = file => exec(compose[0], [...compose.slice(1), '--env-file', path.join(installation, 'compose.env'), '-f', 'deploy/nas/compose.yaml', '-f', 'deploy/nas/compose.media.yaml', '-f', file, 'config', '--format', 'json'], { cwd: root, timeout: 15000, env: { ...process.env, LIMEIOT_VISION_URL: 'http://192.168.1.2:11434', LIMEIOT_VISION_MODEL: 'fixture:vision', LIMEIOT_OLLAMA_MODELS_DIR: models } });
  const external = JSON.parse((await render('deploy/nas/compose.vision.yaml')).stdout); assert.equal(external.services.gateway.environment.LIMEIOT_VISION_URL, 'http://192.168.1.2:11434');
  const local = JSON.parse((await render('deploy/nas/compose.vision-local.yaml')).stdout); assert.equal(local.services.gateway.environment.LIMEIOT_VISION_URL, 'http://vision:11434'); assert.equal(local.services.gateway.environment.LIMEIOT_OLLAMA_MODEL ?? '', ''); assert.deepEqual(Object.keys(local.services.vision.networks), ['vision']); assert.equal(local.networks.vision.internal, true); assert.equal(local.services.vision.ports, undefined); assert.equal(local.services.vision.read_only, true); assert.deepEqual(local.services.vision.cap_drop, ['ALL']); assert.equal(local.services.vision.volumes.some(v => /gateway|secret/i.test(v.target)), false); assert.equal(local.services.gateway.depends_on?.vision, undefined);
  await writeFile(path.join(parent, 'vision-nas-result.json'), JSON.stringify({ passed: true, host_software: true, snapshot_v4: true, backup_byte_exact: true, restored_new_directory: true, running_restored_unknown_without_resubmit: true, private_backup: true, clear_survives_restart: true, provider_calls: calls.length, compose_rendered: true, local_inference_internal_network: true, no_provider_host_port_or_device_secret: true, provider_fixture: true, container_runtime: false, nas_image_rebuilt: false, hardware: false, published: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(parent, 'vision-nas-result.json') }));
});
test('两套真实Nginx入口接收大图，视觉上限与其他路由限制保持独立', { timeout: 120000 }, async t => {
  const { stack, directory, calls, errors, finish } = await visionStack(t), image = png(512, 512, true), value = input(image), gateway = new URL(stack.env.LIMEIOT_ENDPOINT);
  assert.ok(JSON.stringify(value).length > 512 * 1024);
  for (const template of ['nginx.conf', 'nginx.platform.conf']) {
    const prefix = await mkdtemp(path.join(directory, 'nginx-')), port = await freePort(), config = path.join(prefix, 'nginx.conf');
    for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) await mkdir(path.join(prefix, name));
    // 保留正式location、上限和转发行为，只替换宿主夹具的地址、TLS材料及临时路径。
    let source = await readFile(path.join(root, 'deploy/nas', template), 'utf8');
    source = source.replace(/stream \{[\s\S]*?\n\}\nhttp \{/, 'http {').replace('pid /tmp/nginx.pid;', `pid ${prefix}/nginx.pid;`).replaceAll('resolver 127.0.0.11', 'resolver 127.0.0.1').replaceAll('server gateway:17880 resolve;', `server 127.0.0.1:${gateway.port};`).replaceAll('server control:8080 resolve;', `server 127.0.0.1:${gateway.port};`).replace('listen 8443 ssl;', `listen 127.0.0.1:${port};`).replace(/^\s*ssl_(?:certificate|certificate_key|protocols).*;$/gm, '').replaceAll('/tmp/client_body', prefix + '/client_body').replaceAll('/tmp/proxy', prefix + '/proxy').replaceAll('/tmp/fastcgi', prefix + '/fastcgi').replaceAll('/tmp/uwsgi', prefix + '/uwsgi').replaceAll('/tmp/scgi', prefix + '/scgi');
    if (process.platform === 'darwin') source = source.replaceAll(' 64k;', ' 256k;');
    await writeFile(config, source); const nginx = stack.launch('vision-nginx-' + template, process.env.LIMEIOT_NGINX ?? 'nginx', ['-e', 'stderr', '-p', prefix + '/', '-c', config, '-g', 'daemon off;']);
    const call = (resource, body, key) => new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}` + resource, { method: body === undefined ? 'GET' : 'POST', headers: { Host: gateway.host, Authorization: 'Bearer ' + stack.env.LIMEIOT_TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Idempotency-Key': key }) } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() })); }); req.setTimeout(10000, () => req.destroy(new Error('proxy_timeout'))); req.on('error', reject); req.end(body);
    });
    await until(async () => (await call('/healthz')).status === 200);
    const key = template.replaceAll('.', '-'), accepted = await call(base + '/vision-observations', JSON.stringify(value), key); assert.equal(accepted.status, 202, accepted.text); assert.equal((await finish(key)).status, 'succeeded');
    assert.equal((await call(base + '/vision-observations', 'x'.repeat(2804397), 'oversize')).status, 413); assert.equal((await call(base + '/commands', JSON.stringify({ padding: 'x'.repeat(17000) }), 'other')).status, 413); await stop(nginx);
  }
  assert.equal(calls.length, 2); assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'vision-ingress-result.json'), JSON.stringify({ passed: true, real_nginx: true, real_gateway: true, templates: 2, image_bytes: image.length, body_above_512k: true, vision_request_limit: 2804396, other_routes_still_limited: true, provider_calls: calls.length, provider_fixture: true, container_tls_dns_substituted: true, container_runtime: false, hardware: false, nas_image_rebuilt: false, full_goal_completed: false }, null, 2)); console.log(JSON.stringify({ report: path.join(directory, 'vision-ingress-result.json') }));
});
