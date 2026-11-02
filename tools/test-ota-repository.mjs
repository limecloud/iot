// 隔离的真实NAS HTTPS边缘容器，复用发布及下载组件；不连接实机或生产服务。
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { request } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, exec, cli, fixture, hash, signedWorkspace, publishArgs } from '../tests/helpers/ota-release.mjs';

const { values } = parseArgs({ options: { 'lamp-image': { type: 'string' }, 'button-image': { type: 'string' } } });
const directory = path.join(root, '.dev', 'ota-repository-' + crypto.randomUUID());
await mkdir(directory, { mode: 0o700 });
const state = path.join(directory, 'nas'), container = 'limeiot-ota-' + crypto.randomUUID();
const image = 'nginxinc/nginx-unprivileged:1.29-alpine';
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user',
  production_published: false, container_image: image, roles: [], checks: [] };
let started = false;
try {
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', state, '--origin', 'https://127.0.0.1:18443'], { cwd: root });
  report.container_image_id = (await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).stdout.trim();
  report.platform = (await exec('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  await exec('docker', ['run', '--detach', '--name', container, '--user', `${process.getuid()}:${process.getgid()}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:mode=1777,size=32m', '--publish', '127.0.0.1::8443',
    '--mount', `type=bind,src=${path.join(root, 'deploy/nas/nginx.conf')},dst=/etc/limeiot/nginx.conf,readonly`,
    '--mount', `type=bind,src=${path.join(state, 'tls')},dst=/tls,readonly`,
    '--mount', `type=bind,src=${path.join(state, 'firmware')},dst=/firmware,readonly`,
    '--entrypoint', 'nginx', image, '-c', '/etc/limeiot/nginx.conf', '-g', 'daemon off;']);
  started = true;
  const ports = JSON.parse((await exec('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', container])).stdout);
  assert.ok(ports['8443/tcp']?.[0]?.HostPort, 'nas_edge_exited_before_https_bind; see edge.log');
  const origin = `https://127.0.0.1:${ports['8443/tcp'][0].HostPort}`;
  const ca = await readFile(path.join(state, 'authority/ca.crt'));
  const get = (route, method = 'GET') => new Promise((resolve, reject) => {
    const call = request(origin + route, { ca, method, timeout: 3000 }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    call.on('error', reject); call.on('timeout', () => call.destroy(new Error('https_timeout'))); call.end();
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await get('/artifacts/')).status === 404) { ready = true; break; } } catch { /* 仅等待隔离容器就绪。 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'HTTPS edge did not become ready');
  const incomplete = 'artifact-' + '0'.repeat(64), incompleteDir = path.join(state, 'firmware/artifacts', incomplete);
  await mkdir(incompleteDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(incompleteDir, 'firmware.bin'), 'partial');
  await writeFile(path.join(incompleteDir, 'receipt.json'), '{"status":"ready"}');
  assert.equal((await get(`/artifacts/${incomplete}/firmware.bin`)).status, 404);
  report.checks.push('incomplete_or_ready_only_bundle_not_exposed');
  for (const role of ['lamp', 'button']) {
    const source = values[`${role}-image`];
    const w = await signedWorkspace({ baseURL: origin + '/artifacts/', directory: path.join(directory, role),
      role, ...(source ? { image: await readFile(path.resolve(source)) } : {}) });
    const args = publishArgs(w); args[args.indexOf('--repository') + 1] = path.join(state, 'firmware');
    const published = await cli(args); assert.equal(published.code, 0, published.stderr);
    const publication = JSON.parse(published.stdout), route = new URL(publication.download_url).pathname;
    const received = await get(route);
    assert.equal(received.status, 200); assert.deepEqual(received.bytes, w.image);
    assert.match(received.headers['cache-control'], /immutable/);
    assert.equal(received.headers['x-content-type-options'], 'nosniff');
    const head = await get(route, 'HEAD'); assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), w.image.length); assert.equal(head.bytes.length, 0);
    assert.equal((await get(route, 'POST')).status, 403);
    const parent = path.posix.dirname(route);
    const manifestHTTP = await get(parent + '/manifest.json'); assert.equal(manifestHTTP.status, 200);
    assert.deepEqual(JSON.parse(manifestHTTP.bytes), w.manifest);
    for (const name of ['release.json', 'receipt.json', 'published.json', 'publication.pending.json', 'private.pk8', 'public.json'])
      assert.equal((await get(parent + '/' + name)).status, 404);
    const device = { ...fixture.request.device, product_id: w.recipe.target.product_id,
      model_revision: w.recipe.compatibility.model_revisions[0], firmware_version: '0.1.0', security_epoch: 0 };
    await writeFile(path.join(w.dir, 'request.json'), JSON.stringify({ manifest: w.manifest, trust: w.trust, device }));
    const downloaded = await cli(['download', '--input', path.join(w.dir, 'request.json'),
      '--output-dir', path.join(w.dir, 'download'), '--ca-file', path.join(state, 'authority/ca.crt')]);
    assert.equal(downloaded.code, 0, downloaded.stderr); assert.equal(JSON.parse(downloaded.stdout).status, 'verified');
    assert.deepEqual(await readFile(path.join(w.dir, 'download/firmware.bin')), w.image);
    assert.equal((await cli(args)).code, 4);
    report.roles.push({ role, image_source: source ? path.relative(root, path.resolve(source)) : 'format_fixture_not_bootable_evidence',
      actual_firmware_version: w.recipe.firmware_version, actual_security_epoch: w.recipe.security_epoch,
      image_size_bytes: w.image.length, image_sha256: hash(w.image), artifact_id: publication.artifact_id,
      manifest_digest: publication.manifest_digest, snapshot: 'explicit_0.1.0_host_baseline',
      test_only_key: true, rust_download_verified: true });
  }
  report.checks.push('signed_bundle_revalidated_before_store', 'real_nas_nginx_configuration',
    'https_get_head_exact_bytes_and_immutable_headers', 'post_and_private_metadata_denied',
    'lamp_and_button_production_downloader_verified', 'repeat_store_refused_without_overwrite');
  report.passed = true;
} catch (error) {
  report.error = error.message; throw error;
} finally {
  if (started) {
    const logs = await exec('docker', ['logs', container]).catch(() => ({ stdout: '', stderr: '' }));
    await writeFile(path.join(directory, 'edge.log'), logs.stdout + logs.stderr);
    await exec('docker', ['stop', container]).catch(() => {});
    await exec('docker', ['rm', container]).catch(() => {});
  }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, hardware: false, report: path.relative(root, path.join(directory, 'report.json')) }) + '\n');
}
