import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startStack, until, root } from '../tools/dev-stack.mjs';
import { cloudClient, fixture, origin, post } from './helpers/control.mjs';
const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
async function stack() {
  const directory = path.join(root, '.dev', `pairing-${randomBytes(8).toString('hex')}`); await mkdir(directory, { recursive: true }); const key = path.join(directory, 'identity.pk8');
  await exec(path.join(root, 'target/debug/limeiot-gateway'), ['identity-init', key]);
  return startStack({ directory, gatewayEnv: { LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: key, LIMEIOT_CONTROL_CA_FILE: process.env.LIMEIOT_TEST_CONTROL_CA_FILE ?? '', LIMEIOT_CONTROL_RELAY_ENABLED: '0' } });
}
async function settled(s, id, status) { return until(async () => { const value = (await s.request(`${base}/control-pairings/${id}`)).value; return value.status === status && value; }); }
function input(pair) { return { control_origin: pair.control_origin, pairing_id: pair.pairing.pairing_id, code: pair.code }; }

test('真实Go/MySQL与Rust配对：先审核，断流/重启只查原绑定，撤销不被迟到结果恢复', { timeout: 60000, skip: !origin }, async () => {
  const cloud = await cloudClient(), s = await stack();
  try {
    const pair = await cloud.pair(), before = await fixture();
    assert.equal((await fetch(s.env.LIMEIOT_ENDPOINT + base + '/control-pairings', post(input(pair), 'anonymous'))).status, 401);
    assert.equal((await s.request(`${base}/control-pairings`, post({ ...input(pair), control_origin: 'http://127.0.0.1:1' }, 'forbidden-origin'))).status, 422);
    assert.equal((await fixture()).reviews, before.reviews);
    const filename = path.join(s.directory, 'request.json'); await writeFile(filename, JSON.stringify({ ...input(pair), space_id: 'space-demo', idempotency_key: 'original-pairing' }), { mode: 0o600 });
    const cli = async (args, expectedExit = 0) => {
      let result;
      try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', ...args], { cwd: root, env: s.env }); assert.equal(expectedExit, 0); }
      catch (error) { if (error.code !== expectedExit || expectedExit === 0) throw error; result = error; }
      return JSON.parse(result.stdout);
    };
    assert.equal((await cli(['schema', 'control-pairings.approve'])).requires_explicit_local_owner_approval, true);
    const created = await cli(['control-pairings', 'create', '--space-id', 'space-demo', '--input', filename]);
    const review = await settled(s, created.link_id, 'awaiting_approval'); assert.equal(review.review.pairing.owner.principal_id, pair.pairing.owner.principal_id);
    assert.equal((await cloud.bindings(pair.pairing.space_id)).gateways.length, 0); assert.equal((await fixture()).claims, before.claims);
    assert.equal((await cli(['control-pairings', 'create', '--space-id', 'space-demo', '--input', filename])).link_id, created.link_id);
    assert.equal((await fixture()).reviews, before.reviews + 1);
    assert.equal((await s.request(`${base}/control-pairings/${created.link_id}/approve`, post({ review_revision: 'wrong' }))).status, 409);
    await fixture({ drop_claims: true });
    const approval = path.join(s.directory, 'approval.json'); await writeFile(approval, JSON.stringify({ review_revision: review.review_revision }));
    await cli(['control-pairings', 'approve', '--space-id', 'space-demo', created.link_id, '--input', approval]);
    await settled(s, created.link_id, 'unknown');
    const bound = (await cloud.bindings(pair.pairing.space_id)).gateways[0]; assert.equal(bound.active, true);
    assert.equal((await fixture()).claims, before.claims + 1);
    await s.restartGateway(); assert.equal((await cli(['control-pairings', 'resolve', '--space-id', 'space-demo', 'original-pairing'], 6)).status, 'unknown');
    await cli(['control-pairings', 'approve', '--space-id', 'space-demo', created.link_id, '--input', approval], 6);
    assert.equal((await fixture()).claims, before.claims + 1);
    await fixture({}); await cli(['control-pairings', 'reconcile', '--space-id', 'space-demo', created.link_id]);
    const recovered = await settled(s, created.link_id, 'active'); assert.equal(recovered.binding.revision, bound.revision); assert.equal((await fixture()).claims, before.claims + 1);
    const events = (await s.request(`${base}/events?after=0`)).value; assert.ok(!JSON.stringify(events).includes(pair.code));
    for (const filename of ['gateway.sqlite', 'gateway.sqlite-wal']) { const bytes = await readFile(path.join(s.directory, filename)).catch(() => Buffer.alloc(0)); assert.ok(!bytes.includes(Buffer.from(pair.code))); }
    assert.equal((await s.request(`${base}/commands`)).value.items.length, 0);
    await cloud.revoke(bound); await cli(['control-pairings', 'reconcile', '--space-id', 'space-demo', created.link_id]); await settled(s, created.link_id, 'revoked');
    const second = await cloud.pair(); const pending = await s.request(`${base}/control-pairings`, post(input(second), 'late-claim')); const next = await settled(s, pending.value.link_id, 'awaiting_approval');
    await fixture({ hold_claims: true }); await s.request(`${base}/control-pairings/${next.link_id}/approve`, post({ review_revision: next.review_revision }));
    await until(async () => (await cloud.bindings(second.pairing.space_id)).gateways.some(item => item.active));
    await s.request(`${base}/control-pairings/${next.link_id}/revoke`, post({})); await fixture({});
    assert.equal((await settled(s, next.link_id, 'revoked')).approved_at !== null, true);
    await s.restartGateway(); assert.equal((await s.request(`${base}/control-pairings/${next.link_id}`)).value.status, 'revoked');
  } finally { await fixture({}); await s.close(); }
});

test('家庭PWA配对：本地保存失败不发送，响应丢失跨页恢复，明确批准后只查原绑定', { timeout: 60000, skip: !origin }, async () => {
  const cloud = await cloudClient(), s = await stack(); const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  try {
    const pair = await cloud.pair(), before = await fixture(), page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(s.env.LIMEIOT_ENDPOINT); await page.getByLabel('所有者凭据', { exact: true }).fill(s.env.LIMEIOT_TOKEN); await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
    await page.getByRole('heading', { name: '我的设备' }).waitFor(); await page.getByRole('button', { name: '网关配对', exact: true }).click();
    const panel = page.getByRole('region', { name: '网关配对' }); await panel.getByLabel('配对信息', { exact: true }).fill(JSON.stringify(pair));
    await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.startsWith('limeiot.control-pairing:')) throw new DOMException('unavailable', 'QuotaExceededError'); return original.call(this, key, value); }; });
    await panel.getByRole('button', { name: '读取配对信息' }).click(); await panel.getByText('无法保存本地配对记录，请检查浏览器存储设置').waitFor(); assert.equal((await fixture()).reviews, before.reviews);
    await page.reload(); await page.getByRole('button', { name: '网关配对', exact: true }).click();
    await page.route('**/api/v1/spaces/space-demo/control-pairings', async route => { if (route.request().method() !== 'POST') return route.continue(); await route.fetch(); await route.abort('failed'); await page.unroute('**/api/v1/spaces/space-demo/control-pairings'); });
    await panel.getByLabel('配对信息', { exact: true }).fill(JSON.stringify(pair)); await panel.getByRole('button', { name: '读取配对信息' }).click(); await panel.getByText('等待本地批准', { exact: true }).waitFor();
    assert.equal((await fixture()).claims, before.claims); const stored = await page.evaluate(() => JSON.stringify(localStorage)); assert.ok(!stored.includes(pair.code));
    await fixture({ drop_claims: true }); await panel.getByRole('button', { name: '批准配对', exact: true }).click(); await panel.getByText('配对结果未知', { exact: true }).waitFor();
    await page.reload(); await page.getByRole('button', { name: '网关配对', exact: true }).click(); await panel.getByText('配对结果未知', { exact: true }).waitFor();
    assert.equal((await fixture()).claims, before.claims + 1); await fixture({}); await panel.getByRole('button', { name: '核实原配对', exact: true }).click(); await panel.getByText('已配对', { exact: true }).waitFor();
    assert.equal((await fixture()).claims, before.claims + 1); assert.equal((await s.request(`${base}/commands`)).value.items.length, 0);
    await mkdir(path.join(root, '.dev/pairing-test'), { recursive: true }); await page.screenshot({ path: path.join(root, '.dev/pairing-test/desktop.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(root, '.dev/pairing-test/mobile.png'), fullPage: true });
  } finally { await fixture({}); await browser.close(); await s.close(); }
});

test('NAS机器密钥与配对材料随一致性备份恢复，缺少原密钥拒绝恢复', { timeout: 60000, skip: !origin }, async () => {
  const cloud = await cloudClient(); const directory = path.join(root, '.dev', `nas-pairing-${randomBytes(8).toString('hex')}`), manager = path.join(root, 'deploy/nas/manage.py');
  await exec('python3', [manager, 'init', '--directory', directory, '--origin', 'https://127.0.0.1:18443']);
  const secret = async name => (await readFile(path.join(directory, 'secrets', name), 'utf8')).trim();
  const credentials = { owner: await secret('owner-token'), gateway: await secret('gateway-password'), lamp: await secret('device-lamp-password'), button: await secret('device-button-password') };
  const env = key => ({ LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: key, LIMEIOT_CONTROL_CA_FILE: process.env.LIMEIOT_TEST_CONTROL_CA_FILE ?? '', LIMEIOT_CONTROL_RELAY_ENABLED: '0' });
  const s = await startStack({ directory: path.join(directory, 'data'), credentials, gatewayEnv: env(path.join(directory, 'secrets/gateway-identity.pk8')) }); let restored;
  try {
    const pair = await cloud.pair(), initial = (await s.request(`${base}/control-pairings`, post(input(pair), 'nas-pairing'))).value;
    const reviewed = await settled(s, initial.link_id, 'awaiting_approval'); await s.request(`${base}/control-pairings/${initial.link_id}/approve`, post({ review_revision: reviewed.review_revision }));
    const bound = await settled(s, initial.link_id, 'active'), count = (await fixture()).claims;
    const backup = `${directory}-backup`, destination = `${directory}-restored`;
    await exec('python3', [manager, 'backup', '--directory', directory, '--output', backup]); await s.close();
    await exec('python3', [manager, 'restore', '--directory', destination, '--backup', backup]);
    assert.deepEqual(await readFile(path.join(directory, 'secrets/gateway-identity.pk8')), await readFile(path.join(destination, 'secrets/gateway-identity.pk8')));
    restored = await startStack({ directory: path.join(destination, 'data'), credentials, gatewayEnv: env(path.join(destination, 'secrets/gateway-identity.pk8')) });
    assert.equal((await restored.request(`${base}/control-pairings/by-key/nas-pairing`)).value.binding.revision, bound.binding.revision);
    await restored.request(`${base}/control-pairings/${initial.link_id}/reconcile`, post({})); assert.equal((await settled(restored, initial.link_id, 'active')).binding.gateway_id, bound.binding.gateway_id); assert.equal((await fixture()).claims, count);
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup.json'), 'utf8')); delete manifest.files['secrets/gateway-identity.pk8']; await writeFile(path.join(backup, 'backup.json'), JSON.stringify(manifest));
    await assert.rejects(exec('python3', [manager, 'restore', '--directory', `${directory}-missing-key`, '--backup', backup]), /machine_identity_backup_missing/);
  } finally { await s.close(); await restored?.close(); }
});
