import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, until } from './dev-stack.mjs';
import { inspectNasImages, nasImageOverrides, nasVerificationPlatform, verifyNasMachine } from './nas-verification-platform.mjs';
import { thresholdRule } from '../tests/fixtures/zigbee/runtime.mjs';
import { verifyObservationBinding, verifyObservationCandidate, verifyObservationCandidates, verifyObservationOperation } from '../packages/protocol/observation-bindings.mjs';
import { verifyZigbeeCoordinators, verifyZigbeeOperation, verifyZigbeeOperations } from '../packages/protocol/zigbee-operations.mjs';

const exec = promisify(execFile), { values } = parseArgs({ options: { image: { type: 'string' }, platform: { type: 'string' } } });
assert.match(values.image ?? '', /^limeiot\/verification:[A-Za-z0-9_.-]+$/, 'provide a locally built verification image');
const directory = path.join(root, '.dev/nas-zigbee-' + randomBytes(8).toString('hex'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const project = 'limeiot-nas-znp-' + randomBytes(6).toString('hex'), manager = path.join(root, 'deploy/nas/manage.py');
const installation = path.join(directory, 'installation'), restored = path.join(directory, 'restored'), backup = path.join(directory, 'backup');
const overridesFile = path.join(directory, 'compose.test.json');
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user', published: false, full_goal_completed: false, evidence: path.relative(root, directory) };
let state = installation, composeCommand, composePrefix, started = false, agent, session, browser, sourceEnabled = true;
const fixtures = []; let overrides, origin, owner;
async function run(command, args, log, options = {}) {
  try { const result = await exec(command, args, { cwd: root, timeout: 120000, maxBuffer: 4_000_000, ...options }); if (log) await writeFile(path.join(directory, log), result.stdout + result.stderr, { mode: 0o600 }); return result.stdout.trim(); }
  catch (error) { if (log) await writeFile(path.join(directory, log), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 }); throw error; }
}
async function compose(args, log = 'compose-latest.log') {
  return run(composeCommand, [...composePrefix, '--project-name', project, '--env-file', path.join(state, 'compose.env'), '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', overridesFile, '--profile', 'simulation', ...args], log, { env: { ...process.env, LIMEIOT_STATE_DIR: state, LIMEIOT_BIND_HOST: '127.0.0.1' } });
}
async function writeOverrides() { overrides.services.gateway.environment = sourceEnabled ? { LIMEIOT_ZIGBEE_CONFIG: '/config/zigbee.json' } : {}; await writeFile(overridesFile, JSON.stringify(overrides, null, 2), { mode: 0o600 }); }
function call(resource, { input, key, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const req = httpsRequest(origin + resource, { agent, method: input === undefined ? 'GET' : 'POST', headers: {
      ...(authenticated && session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, Origin: origin } : {}),
      ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(key ? { 'Idempotency-Key': key } : {}),
    } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 2_000_000) req.destroy(new Error('response_too_large')); else chunks.push(chunk); });
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: response.statusCode, headers: response.headers, value }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('https_timeout'))); req.on('error', reject); req.end(body);
  });
}
const base = '/api/v1/spaces/space-demo', ids = ['zigbee-environment', 'zigbee-environment-2'], ieee = ['1122334455667788', '1122334455667789'];
const commissioningFor = page => page.getByRole('region', { name: 'Zigbee入网管理', exact: true });
const reviewFor = page => commissioningFor(page).getByRole('group', { name: '核对Zigbee入网', exact: true });
const joinRowFor = (page, key) => commissioningFor(page).locator(`[data-zigbee-key="${key}"]`);
async function originals(page) {
  return page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key))), `limeiot.zigbee-operation:${base}:`);
}
async function commissioningOperation(key) {
  const response = await call(base + '/zigbee-operations/by-key/' + key); assert.equal(response.status, 200);
  return verifyZigbeeOperation(response.value);
}
async function verifyCommissioningHistory(expected) {
  const response = await call(base + '/zigbee-operations'); assert.equal(response.status, 200);
  const history = await verifyZigbeeOperations(response.value, 'space-demo'); assert.deepEqual(history.items, expected);
  for (const operation of expected) assert.deepEqual(await commissioningOperation(operation.request.idempotency_key), operation);
}
async function login() {
  const response = await call('/api/v1/auth/session', { authenticated: false, input: { token: owner } }); assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith('__Host-limeiot_session=')); assert.ok(cookie?.includes('Secure') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
  session = { cookie: cookie.split(';')[0], csrf: response.value.csrf_token };
}
async function sensor(index = 0) { const response = await call(base + '/devices/' + ids[index]); assert.equal(response.status, 200); return response.value; }
async function binding(index = 0) { const response = await call(base + '/devices/' + ids[index] + '/observation-binding'); assert.equal(response.status, 200); return verifyObservationBinding(response.value, ids[index]); }
async function candidates() { const response = await call(base + '/observation-candidates'); assert.equal(response.status, 200); return verifyObservationCandidates(response.value); }
async function query(index = 0) {
  const response = await call(base + '/observation-candidates', { input: { coordinator_id: 'home-znp', ieee_address: ieee[index], endpoint: 1 } }); assert.equal(response.status, 200);
  const value = await verifyObservationCandidate(response.value); assert.equal(value.target.ieee_address, ieee[index]); return value;
}
async function change(input, key) {
  const response = await call(base + '/observation-operations', { input, key }); assert.equal(response.status, 200);
  return verifyObservationOperation(response.value, { space_id: 'space-demo', idempotency_key: key, change: input });
}
async function bind(index, key) {
  const candidate = await query(index), current = await binding(index);
  const result = await change({ type: 'sources.bind', device_id: ids[index], source: candidate.source, expected_binding_revision: current.revision, expected_model_revision: candidate.model_revision }, key);
  assert.equal(result.status, 'applied'); return result;
}
async function ready(index = 0) { return until(async () => { const d = await sensor(index); return d.ready && d.reported['environment.temperature']?.quality === 'confirmed' && d; }, 15000); }
async function deployThreshold(index) {
  assert.equal((await call(base + '/rule-deployments', { input: thresholdRule(index) })).status, 200);
  const baseline = (await sensor(index)).reported['environment.temperature'].observed_at;
  await until(async () => {
    const observation = (await sensor(index)).reported['environment.temperature'];
    return observation.observed_at !== baseline && observation.quality === 'confirmed' && observation.value < 2800;
  });
}
async function startNcp(phase) {
  const child = spawn(composeCommand, [...composePrefix, '--project-name', project, '--env-file', path.join(state, 'compose.env'), '-f', path.join(root, 'deploy/nas/compose.yaml'), '-f', overridesFile, 'exec', '-T', 'gateway', 'python3', '-u', '/fixture/tests/fixtures/zigbee/ncp.py', '/tmp/ncp-requests.json'], { cwd: root, env: { ...process.env, LIMEIOT_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'] });
  const fixture = { child, phase, messages: [], stderr: '', sequence: 0, pending: '' }; fixtures.push(fixture);
  child.stderr.on('data', chunk => { fixture.stderr += chunk; });
  child.on('error', error => { fixture.error = error; });
  child.stdout.on('data', chunk => { fixture.pending += chunk; while (fixture.pending.includes('\n')) {
    const at = fixture.pending.indexOf('\n'), line = fixture.pending.slice(0, at); fixture.pending = fixture.pending.slice(at + 1);
    try { fixture.messages.push(JSON.parse(line)); } catch { fixture.error = new Error('invalid_ncp_output: ' + line); }
  } });
  child.stdin.on('error', () => {});
  const initial = await until(() => { if (fixture.error) throw fixture.error; assert.equal(child.exitCode, null, fixture.stderr); return fixture.messages.find(value => value.type === 'ready'); }, 10000);
  assert.equal(initial.serial, '/dev/pts/0', 'fresh container must allocate the configured software PTY');
  async function send(message, type) {
    if (fixture.error) throw fixture.error;
    assert.equal(child.exitCode, null, 'software NCP exited before request'); const id = ++fixture.sequence; child.stdin.write(JSON.stringify({ ...message, id }) + '\n');
    const value = await until(() => fixture.messages.find(value => value.type === type && value.id === id), 5000); if (type === 'stats') assert.deepEqual(value.errors, []); return value;
  }
  return { stats: () => send({ type: 'inspect' }, 'stats'), temperature: (index, temperature) => send({ device: ieee[index], temperature, mode: 'normal' }, 'ack'), join: mode => send({ type: 'join', mode }, 'ack') };
}
async function recreate(enable, phase) {
  sourceEnabled = enable; await writeOverrides();
  await compose(['up', '--no-build', '--detach', '--force-recreate', '--no-deps', 'gateway'], `${phase}-recreate.log`);
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90', 'lamp', 'button'], `${phase}-up.log`);
  await until(async () => (await call('/healthz', { authenticated: false })).value?.broker_connected, 15000);
  session = undefined; await login();
  return enable ? startNcp(phase) : undefined;
}
async function sqlite(directoryName) {
  const output = await run('python3', ['-c', 'import sqlite3,json,sys,hashlib; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); r=d.execute("SELECT version,config_hash,body FROM snapshot WHERE id=1").fetchone(); print(json.dumps({"integrity":d.execute("PRAGMA integrity_check").fetchone()[0],"version":r[0],"config_hash":r[1],"body_sha256":hashlib.sha256(r[2].encode()).hexdigest(),"body":json.loads(r[2])}))', path.join(directoryName, 'data/gateway.sqlite')]);
  const value = JSON.parse(output); assert.equal(value.integrity, 'ok'); return value;
}
async function commissioningEvents(directoryName) {
  const output = await run('python3', ['-c', 'import sqlite3,json,sys; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(d.execute("SELECT id,type,data FROM events WHERE type=? ORDER BY id",("zigbee.commissioning",)).fetchall()))', path.join(directoryName, 'data/gateway.sqlite')]);
  return JSON.parse(output);
}
try {
  try { await exec('docker', ['compose', 'version']); composeCommand = 'docker'; composePrefix = ['compose']; }
  catch { await exec('docker-compose', ['version']); composeCommand = 'docker-compose'; composePrefix = []; }
  const daemon = (await exec('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim();
  const platform = nasVerificationPlatform(values.platform, daemon); report.target_platform = platform; report.emulated = platform !== daemon;
  const images = await inspectNasImages({ gateway: values.image, lamp: values.image, button: values.image, edge: process.env.LIMEIOT_TEST_NGINX_IMAGE ?? 'nginxinc/nginx-unprivileged:1.29-alpine' }, platform);
  report.images = images;
  const label = JSON.parse((await exec('docker', ['image', 'inspect', images.gateway.id, '--format', '{{json .Config.Labels}}'])).stdout);
  assert.match(label?.['run.limeiot.source-digest'] ?? '', /^[a-f0-9]{64}$/); report.source_digest = label['run.limeiot.source-digest'];
  origin = `https://127.0.0.1:${await freePort()}`;
  await run('python3', [manager, 'init', '--directory', state, '--origin', origin], 'initialize.log');
  await writeFile(path.join(state, 'config/zigbee.json'), JSON.stringify({ schema_version: 2, bindings: [], coordinators: [{ coordinator_id: 'home-znp', serial: '/dev/pts/0', coordinator_ieee: '0102030405060708', timeout_ms: 1500, poll_interval_ms: 1000 }] }), { mode: 0o600 });
  const configHash = createHash('sha256').update(await readFile(path.join(state, 'config/gateway.json'))).digest('hex');
  const mounts = ['test_znp.py', 'test_znp_environment.py', 'fixtures/zigbee/ncp.py'].map(name => ({ type: 'bind', source: path.join(root, 'tests', name), target: '/fixture/tests/' + name, read_only: true }));
  overrides = { services: nasImageOverrides(images, platform) }; overrides.services.gateway.volumes = mounts; await writeOverrides();
  const configuration = JSON.parse(await compose(['config', '--format', 'json'], 'configuration.log'));
  assert.equal(configuration.services.gateway.read_only, true); assert.ok(configuration.services.gateway.cap_drop.includes('ALL'));
  assert.notEqual(configuration.services.gateway.user.split(':')[0], '0'); assert.notEqual(configuration.services.gateway.privileged, true);
  assert.ok(configuration.services.gateway.volumes.every(volume => volume.source.startsWith(state + path.sep) || mounts.some(mount => mount.source === volume.source)));
  owner = (await readFile(path.join(state, 'secrets/owner-token'), 'utf8')).trim(); agent = new Agent({ ca: await readFile(path.join(state, 'authority/ca.crt')), keepAlive: true });
  started = true; await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90'], 'initial-up.log');
  report.linux_machine = verifyNasMachine(await compose(['exec', '-T', 'gateway', 'uname', '-m']), platform, 'gateway');
  assert.equal((await call(base + '/devices', { authenticated: false })).status, 401); await login();
  let ncp = await startNcp('initial'); assert.equal((await ncp.stats()).host_checks, 0); assert.deepEqual((await candidates()).items, []);
  const before = await sqlite(state), first = await bind(0, 'nas-bind-first'), second = await bind(1, 'nas-bind-second');
  await ready(0); await ready(1);
  await deployThreshold(0);
  await ncp.temperature(0, 2900); await until(async () => { const c = (await call(base + '/commands')).value.items; return c.length === 1 && c[0].status === 'confirmed'; });
  const current = await binding(1), revoked = await change({ type: 'sources.revoke', device_id: ids[1], expected_binding_revision: current.revision }, 'nas-revoke-second'); assert.equal(revoked.status, 'applied');
  const conflict = await change({ type: 'sources.revoke', device_id: ids[0], expected_binding_revision: 'sha256:' + '0'.repeat(64) }, 'nas-conflict'); assert.equal(conflict.status, 'conflict');
  assert.equal((await sensor(1)).ready, false); report.initial_stats = await ncp.stats();
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.getByLabel('所有者凭据', { exact: true }).fill(owner); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await expect(page.getByRole('article', { name: '环境传感器', exact: true })).toHaveCount(2);
  await page.screenshot({ path: path.join(directory, 'nas-zigbee-devices-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '家庭导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '家庭导航', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '设备接入', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Zigbee 设备', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '家庭导航', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.locator('#home-sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  let joinPosts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/zigbee-operations')) joinPosts++; });
  const panel = commissioningFor(page);
  await expect(panel.getByRole('button', { name: '开放入网', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '开放入网', exact: true }).click(); await expect(reviewFor(page)).toBeVisible();
  await reviewFor(page).getByRole('button', { name: '取消入网操作', exact: true }).click();
  assert.equal(joinPosts, 0); assert.deepEqual(await originals(page), []); assert.deepEqual((await ncp.stats()).join_requests, []);
  let dropResponse = false;
  await page.route('**/zigbee-operations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const saved = await originals(page), key = route.request().headers()['idempotency-key'];
    const original = saved.find(value => value.request.idempotency_key === key); assert.ok(original, 'original is saved and read back before the packaged page sends POST');
    assert.deepEqual(original.request.change, route.request().postDataJSON());
    const response = await route.fetch(); assert.equal(response.status(), 200);
    if (dropResponse) await route.abort(); else await route.fulfill({ response });
  });
  await ncp.join('timeout');
  await panel.getByRole('button', { name: '开放入网', exact: true }).click(); await expect(reviewFor(page)).toBeVisible();
  await reviewFor(page).getByRole('button', { name: '确认开放', exact: true }).click();
  await expect(panel.getByText('入网结果未知，请查询原操作', { exact: true })).toBeVisible();
  const [openOriginal] = await originals(page), openKey = openOriginal.request.idempotency_key;
  const unknown = await until(async () => { const operation = await commissioningOperation(openKey); return operation.completed_at && operation; });
  await verifyZigbeeOperation(unknown, openOriginal.request); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reason, 'observation_query_timeout');
  await panel.getByRole('button', { name: '开放入网', exact: true }).click();
  await expect(panel.getByText('此前入网结果未确认，请查询原操作或明确关闭', { exact: true })).toBeVisible();
  assert.equal(await reviewFor(page).count(), 0); assert.equal(joinPosts, 1); assert.deepEqual((await ncp.stats()).join_requests, [60]);
  await ncp.join('normal'); dropResponse = true;
  await panel.getByRole('button', { name: '关闭入网', exact: true }).click(); await expect(reviewFor(page)).toBeVisible();
  assert.equal(joinPosts, 1); await reviewFor(page).getByRole('button', { name: '确认关闭', exact: true }).click();
  await expect(panel.getByText('入网结果未知，请查询原操作', { exact: true })).toBeVisible();
  const closeOriginal = (await originals(page)).find(value => value.request.idempotency_key !== openKey); assert.ok(closeOriginal);
  const closeKey = closeOriginal.request.idempotency_key;
  const closed = await until(async () => { const operation = await commissioningOperation(closeKey); return operation.completed_at && operation; });
  await verifyZigbeeOperation(closed, closeOriginal.request); assert.equal(closed.status, 'protocol_accepted'); assert.equal(closed.request.change.duration_seconds, 0);
  const summary = panel.getByText('入网操作记录', { exact: true });
  if (!await summary.locator('..').evaluate(element => element.open)) await summary.click();
  await joinRowFor(page, closeKey).getByRole('button', { name: '查询原入网操作', exact: true }).click();
  await expect(joinRowFor(page, closeKey).getByText('协议已受理', { exact: true })).toBeVisible();
  await expect(joinRowFor(page, openKey).getByText('结果未知', { exact: true })).toBeVisible();
  assert.equal(joinPosts, 2); assert.deepEqual((await ncp.stats()).join_requests, [60, 0]);
  const commissioning = [unknown, closed]; await verifyCommissioningHistory(commissioning);
  const events = await commissioningEvents(state); assert.equal(events.length, 4, 'each original has one durable intent and one durable result');
  report.initial_commissioning_stats = await ncp.stats(); report.commissioning_posts = joinPosts; report.original_commissioning_operations = commissioning;
  const source = page.getByRole('region', { name: 'Zigbee设备接入', exact: true });
  await source.getByRole('button', { name: '发现已有设备', exact: true }).click();
  await source.getByRole('group', { name: '发现的Zigbee设备', exact: true }).getByRole('article').filter({ hasText: ieee[0] }).getByRole('button', { name: '读取端点', exact: true }).click();
  await expect(source.getByRole('group', { name: 'Zigbee设备端点', exact: true }).getByRole('button', { name: '查询此端点', exact: true })).toBeEnabled();
  report.discovery_and_endpoints_from_packaged_page = true;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: path.join(directory, 'nas-zigbee-mobile.png'), fullPage: true, animations: 'disabled' }); await browser.close(); browser = undefined;
  ncp = await recreate(true, 'restarted');
  assert.deepEqual((await candidates()).items, []); await ready(0); assert.equal((await sensor(1)).ready, false);
  assert.equal((await call(base + '/commands')).value.items.length, 1, 'container recreation must not replay the original threshold');
  assert.equal((await ncp.stats()).samples[ieee[1]], 0, 'revoked source is not polled after container recreation');
  assert.deepEqual((await ncp.stats()).join_requests, [], 'a fresh NCP receives no replay after container recreation');
  await verifyCommissioningHistory(commissioning); assert.deepEqual(await commissioningEvents(state), events);
  report.restarted_stats = await ncp.stats();
  for (const op of [first, second, revoked, conflict]) { const value = (await call(base + '/observation-operations/by-key/' + op.request.idempotency_key)).value; await verifyObservationOperation(value, op.request); assert.deepEqual(value, op); }
  const snapshot = await sqlite(state); assert.equal(snapshot.version, 13); assert.equal(snapshot.config_hash, before.config_hash);
  assert.equal(createHash('sha256').update(await readFile(path.join(state, 'config/gateway.json'))).digest('hex'), configHash);
  await run('python3', [manager, 'backup', '--directory', state, '--output', backup], 'backup.log');
  await run('python3', [manager, 'restore', '--backup', backup, '--directory', restored], 'restore.log');
  const saved = await sqlite(backup), recovered = await sqlite(restored); assert.equal(saved.version, 13); assert.deepEqual(recovered, saved);
  const savedEvents = await commissioningEvents(backup), recoveredEvents = await commissioningEvents(restored);
  assert.deepEqual(savedEvents, events); assert.deepEqual(recoveredEvents, savedEvents);
  report.backup_commissioning_events_sha256 = createHash('sha256').update(JSON.stringify(savedEvents)).digest('hex');
  report.restored_commissioning_events_sha256 = createHash('sha256').update(JSON.stringify(recoveredEvents)).digest('hex');
  report.backup_snapshot_body_sha256 = saved.body_sha256; report.restored_snapshot_body_sha256 = recovered.body_sha256;
  assert.deepEqual(await readFile(path.join(restored, 'config/zigbee.json')), await readFile(path.join(state, 'config/zigbee.json')));
  await compose(['logs', '--no-color'], 'original-containers.log'); await compose(['down', '--remove-orphans'], 'original-down.log'); started = false;
  state = restored; sourceEnabled = false; await writeOverrides(); started = true; await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '90'], 'restored-disabled-up.log');
  session = undefined; await login(); assert.deepEqual((await candidates()).coordinators, []);
  const missing = await call(base + '/zigbee-coordinators'); assert.equal(missing.status, 200); assert.deepEqual(verifyZigbeeCoordinators(missing.value).items, []);
  await verifyCommissioningHistory(commissioning); assert.deepEqual(await commissioningEvents(state), events);
  const unavailable = await call(base + '/zigbee-operations', { input: closed.request.change, key: 'nas-unavailable-close' });
  assert.equal(unavailable.status, 404); assert.equal(unavailable.value.error.code, 'observation_coordinator_not_found');
  await verifyCommissioningHistory(commissioning); report.missing_coordinator_history_readable_and_new_write_rejected = true;
  assert.equal((await sensor(0)).ready, false); assert.equal((await sensor(0)).reported['environment.temperature'].quality, 'stale'); assert.equal((await sensor(1)).ready, false);
  assert.equal((await binding(0)).binding.active, true); assert.equal((await binding(1)).binding.active, false); report.missing_coordinator_keeps_stale_without_mqtt_fallback = true;
  ncp = await recreate(true, 'restored-enabled'); await ready(0); assert.equal((await ncp.stats()).samples[ieee[1]], 0);
  const old = (await call(base + '/observation-operations/by-key/nas-bind-second')).value; assert.deepEqual(old, second); assert.equal((await binding(1)).binding.active, false);
  const rebound = await bind(1, 'nas-explicit-rebind'); await ready(1);
  await deployThreshold(1); await ncp.temperature(1, 2900);
  await until(async () => { const c = (await call(base + '/commands')).value.items; return c.length === 2 && c.every(command => command.status === 'confirmed'); });
  assert.equal((await sqlite(state)).config_hash, before.config_hash); report.final_stats = await ncp.stats();
  assert.deepEqual(report.final_stats.join_requests, [], 'restored NCP receives no original open or close');
  await verifyCommissioningHistory(commissioning); assert.deepEqual(await commissioningEvents(state), events);
  report.commissioning_unknown_preserved = true; report.independent_explicit_close_and_lost_response_get_recovery = true;
  report.commissioning_recreate_and_restore_zero_replay = true; report.commissioning_backup_event_bytes_equal = true;
  report.cancel_zero_save_and_send = true; report.original_readback_before_post = true; report.unknown_blocks_replacement_open = true;
  report.original_decisions = [first, second, revoked, conflict, rebound]; report.snapshot_version = 13; report.backup_restore_snapshot_byte_semantics_equal = true; report.configuration_preserved = true;
  report.https_verified_ca = true; report.non_root_read_only_linux_pty = true; report.dynamic_observation_and_revocation_restored = true; report.historical_applied_does_not_reactivate = true; report.confirmed_threshold_commands = 2; report.packaged_mobile_home_and_zigbee_panel = true; report.mobile_navigation_open_and_close = true;
  report.physical_device_passthrough = false; report.ncp_fixture_inside_gateway_container = true; report.passed = true;
} catch (error) {
  report.error = String(error); report.error_stack = error.stack; process.exitCode = 1;
  if (started) { try { await compose(['ps', '--all', '--format', 'json'], 'failure-containers.log'); } catch {} }
} finally {
  await browser?.close(); agent?.destroy();
  if (started) { await compose(['logs', '--no-color'], 'final-containers.log').catch(() => {}); try { await compose(['down', '--remove-orphans'], 'final-down.log'); report.containers_cleaned = true; } catch { report.passed = false; report.containers_cleaned = false; process.exitCode = 1; } }
  for (const fixture of fixtures) {
    await until(() => fixture.child.exitCode !== null || fixture.child.signalCode !== null, 5000).catch(() => {});
    await writeFile(path.join(directory, fixture.phase + '-ncp.log'), fixture.stderr, { mode: 0o600 });
  }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ passed: report.passed, report: path.relative(root, path.join(directory, 'report.json')) }));
}
