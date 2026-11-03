import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const core = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).name === 'limeiot';
const { documentDigest } = await import(pathToFileURL(path.join(root, core ? 'packages/protocol/model-validation.mjs' : 'src/console/protocol/model-validation.mjs')));
// 实际前端构建与合成HTTP，隔离验证交互；不替代Go/Rust/MQTT或实机验收。
const enabled = process.env.LIMEIOT_UI_TEST === '1';
const built = path.join(root, core ? 'apps/console/dist' : 'dist');
const model = {
  schema_version: 2, model_id: 'urn:limeiot:model:consumer-action-fixture:1', model_version: '1.0.0',
  services: [
    { id: 'light', semantic_id: 'urn:limeiot:service:light:1', properties: [{ id: 'power', semantic_id: 'urn:limeiot:property:power:1', schema: { type: 'boolean' }, access: ['read', 'write', 'notify'], max_age_ms: 60000 }], actions: [], events: [] },
    { id: 'signal', semantic_id: 'urn:limeiot:service:consumer-signal:1', properties: [], events: [], actions: [
      { id: 'submit', semantic_id: 'urn:limeiot:action:consumer-submit:1', input: { type: 'object', properties: { key: { type: 'string', enum: ['home', 'back'] } }, required: ['key'], additionalProperties: false }, output: { type: 'object', properties: {}, required: [], additionalProperties: false }, idempotent: false, risk: 'low', completion: 'submitted' },
      { id: 'observe', semantic_id: 'urn:limeiot:action:consumer-observe:1', input: { type: 'object', properties: { level: { type: 'integer', minimum: 1, maximum: 3 }, enabled: { type: 'boolean' }, title: { type: 'string', minLength: 2, maxLength: 2 } }, required: ['level'], additionalProperties: false }, output: { type: 'object', properties: {}, required: [], additionalProperties: false }, idempotent: false, risk: 'medium', completion: 'observed' },
    ] },
  ],
};
const revision = await documentDigest(model);
const principal = 'fixture-user', space = 'space-fixture', prefix = '/api/console/v1/spaces/' + space;

async function setup() {
  const now = new Date().toISOString();
  const records = new Map(), state = { posts: 0, reads: 0, missing: false, corrupt: false, available: true, wrongModel: false };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let value;
        if (url.pathname.endsWith('/auth/config')) value = { local: true, oidc: false };
        else if (url.pathname.endsWith('/auth/session')) value = { audience: 'console', principal: { principal_id: principal, name: 'Fixture' }, csrf_token: 'a'.repeat(64), expires_at: new Date(Date.now() + 3600000).toISOString() };
        else if (url.pathname.endsWith('/spaces')) value = { spaces: [{ space_id: space, name: 'Fixture space', created_at: now }] };
        else if (url.pathname.endsWith('/gateways')) value = { gateways: [{ gateway_id: 'gateway-fixture', space_id: space, local_space_id: 'space-demo', principal_id: principal, revision: 'binding-fixture', active: true, scopes: ['devices.read', 'commands.write'], created_at: now }] };
        else if (url.pathname.endsWith('/connection')) value = { connected: true, binding_revision: 'binding-fixture', last_seen_at: now };
        else if (url.pathname.endsWith('/devices')) value = { items: [{ device_id: 'device-fixture', model_revision: revision, ready: true, last_seen: now, reported: { 'light.power': { value: false, observed_at: now, quality: 'confirmed' } }, action_availability: { 'signal.submit': state.available, 'signal.observe': true } }], next: null, binding_revision: 'binding-fixture' };
        else if (url.pathname.includes('/model-releases/')) value = { revision, model: state.wrongModel ? { ...model, model_version: '2.0.0' } : model };
        else if (url.pathname === prefix + '/remote-commands' && req.method === 'POST') {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const input = JSON.parse(raw); state.posts++;
          assert.equal(req.headers['x-csrf-token'], 'a'.repeat(64));
          const remoteID = 'remote-' + state.posts.toString(16).padStart(64, '0');
          const request = { space_id: 'space-demo', idempotency_key: remoteID, device_id: input.device_id, model_revision: input.model_revision, expires_at: input.expires_at, operation: input.operation };
          const observed = new Date().toISOString();
          value = { remote_id: remoteID, space_id: space, principal_id: principal, local_space_id: 'space-demo', request_digest: (await documentDigest(input)).slice(7), request: input, status: 'accepted', local_result: null, created_at: observed, updated_at: observed };
          records.set(input.request_key, { value, request, observed });
        } else if (url.pathname.includes('/remote-commands/by-key/')) {
          state.reads++;
          const record = records.get(decodeURIComponent(url.pathname.split('/').at(-1)));
          if (!record || state.missing) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'not_found' } })); }
          const { request, observed } = record, operation = request.operation;
          const evidence = operation.type === 'property.set'
            ? { type: 'device_result', reported: { [operation.path]: operation.value } }
            : { type: 'action_result', path: operation.path, input_digest: state.corrupt ? 'sha256:' + '0'.repeat(64) : await documentDigest(operation.value), output: {}, completion: operation.path.endsWith('observe') ? 'observed' : 'submitted', observed_at: observed };
          value = { ...record.value, status: 'confirmed', local_result: { command_id: 'command-' + record.value.remote_id.slice(7), status: 'confirmed', request, request_digest: await documentDigest(request), evidence, error: null } };
        } else { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(value));
      }
      const relative = decodeURIComponent(url.pathname).replace(core ? /^\/console\// : /^\//, '');
      let target = path.resolve(built, relative);
      if (!target.startsWith(built + path.sep) && target !== built) throw new Error('path');
      if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(target)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(target));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const url = view => origin + '/console/?lang=en&space=' + space + '&view=' + view;
  return { state, records, page, errors, url, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

test('远程动作消费者：Schema 2控件、丢响应只查原键、错误证据拒绝、完成范围与属性兼容', { timeout: 60000, skip: !enabled }, async () => {
  const s = await setup(), { page, state } = s;
  try {
    await page.goto(s.url('devices'));
    const submit = page.getByRole('form', { name: 'signal.submit', exact: true });
    await expect(submit.getByRole('button', { name: 'Run action' })).toBeEnabled();
    await submit.getByLabel('signal.submit.key', { exact: true }).selectOption('"back"');
    await page.route('**/remote-commands', async route => { await route.fetch(); await route.abort('failed'); });
    await submit.getByRole('button', { name: 'Run action' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.unroute('**/remote-commands');
    assert.equal(state.posts, 1);
    assert.deepEqual([...s.records.values()][0].request.operation, { type: 'action.invoke', path: 'signal.submit', value: { key: 'back' } });
    await page.reload();
    await expect(submit.getByRole('button', { name: 'Run action' })).toBeDisabled();
    assert.equal(state.posts, 1);
    await page.goto(s.url('operations'));
    state.missing = true;
    await page.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(page.getByText('The original operation is not recorded yet. Nothing was sent again.', { exact: true })).toBeVisible();
    state.missing = false; state.corrupt = true;
    await page.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('Input submitted to executor', { exact: true })).toHaveCount(0);
    state.corrupt = false;
    await page.getByRole('button', { name: 'Check result', exact: true }).click();
    await expect(page.getByText('Input submitted to executor', { exact: true })).toBeVisible();
    assert.equal(state.posts, 1);
    await page.reload();
    await expect(page.getByText('Input submitted to executor', { exact: true })).toBeVisible();
    assert.equal(state.posts, 1);
    await page.goto(s.url('devices'));
    const observe = page.getByRole('form', { name: 'signal.observe', exact: true });
    await observe.getByLabel('signal.observe.level', { exact: true }).fill('2');
    await observe.getByLabel('Include enabled', { exact: true }).check();
    await observe.getByLabel('signal.observe.enabled', { exact: true }).check();
    await observe.getByLabel('Include title', { exact: true }).check();
    await observe.getByLabel('signal.observe.title', { exact: true }).fill('😀😀');
    const approval = observe.getByRole('checkbox', { name: 'I approve running signal.observe with these inputs.' });
    await approval.check();
    await observe.getByLabel('signal.observe.level', { exact: true }).fill('3');
    await expect(approval).not.toBeChecked();
    await expect(observe.getByRole('button', { name: 'Run action' })).toBeDisabled();
    await approval.check();
    await observe.getByRole('button', { name: 'Run action' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Gateway accepted' })).toBeVisible();
    assert.equal(state.posts, 2);
    assert.deepEqual([...s.records.values()][1].request.operation.value, { level: 3, enabled: true, title: '😀😀' });
    await page.goto(s.url('operations'));
    await page.getByRole('button', { name: 'Check result', exact: true }).first().click();
    await expect(page.getByText('Effect reported by provider', { exact: true })).toBeVisible();
    await page.goto(s.url('devices'));
    await page.getByRole('switch', { name: 'light.power', exact: true }).click();
    assert.equal(state.posts, 3);
    assert.equal([...s.records.values()][2].request.operation.type, 'property.set');
    await page.goto(s.url('operations'));
    await page.getByRole('button', { name: 'Check result', exact: true }).first().click();
    await expect(page.getByRole('row').filter({ hasText: 'Confirmed by device' })).toHaveCount(3);
    state.available = false;
    await page.goto(s.url('devices'));
    await expect(submit.getByRole('button', { name: 'Run action' })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    state.wrongModel = true;
    await page.reload();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('form', { name: 'signal.submit', exact: true })).toHaveCount(0);
    assert.equal(state.posts, 3);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
