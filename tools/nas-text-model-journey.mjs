// 复用NAS安装、TLS与Compose入口；只验证真实模型，不提供替代回答。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { root, until } from './dev-stack.mjs';
import { createTextOriginal, verifyTextTask } from '../packages/protocol/text.mjs';
import { textLiveSamples as samples } from '../tests/helpers/text-live-samples.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
export async function nasTextModelJourney({ directory, state, origin, model, token, call, compose, authenticate, restore, providerService, useRelay,
  providerPlacement = 'same_machine_container', providerCalls: observeProviderCalls, stopProvider }) {
  const result = { passed: false, provider_fixture: false, hardware: false, cases: [], full_goal_completed: false };
  result.samples = samples.map(({ check, ...sample }) => sample);
  const inputFor = sample => ({ instructions: sample.id === 'arithmetic' ? '' : '用简短中文回答。', messages: sample.messages, retain_seconds: 600, expires_at: new Date(Date.now() + 85000).toISOString() });
  const finish = key => until(async () => { const response = await call(base + '/text-generations/by-key/' + key); return response.status === 200 && response.value.status !== 'running' && response.value; }, 88000);
  const relay = async () => JSON.parse((await compose(['exec', '-T', 'gateway', 'python3', '-c', 'import urllib.request;print(urllib.request.urlopen("http://text-relay:8000/_test/state",timeout=3).read().decode())'])).stdout);
  const providerCalls = observeProviderCalls ?? (async () => ((await compose(['logs', '--no-color', providerService])).stdout.match(/\bPOST\s+"?\/api\/chat"?(?:\s|$)/gm) ?? []).length);
  // 容器重建会开启新日志；外部专用进程跨NAS恢复保持累计4次调用。
  const restoredProviderCalls = providerPlacement === 'same_machine_container' ? 0 : 4;
  const manager = (...args) => exec('python3', ['deploy/nas/manage.py', ...args], { cwd: root, timeout: 45000 });
  const cli = args => exec(process.execPath, ['packages/cli/src/main.mjs', 'text-generations', ...args, '--space-id', 'space-demo', '--state-dir', path.join(directory, 'cli')], { cwd: root, timeout: 15000, env: { ...process.env, LIMEIOT_ENDPOINT: origin, LIMEIOT_TOKEN: token, LIMEIOT_TOKEN_FILE: undefined, NODE_EXTRA_CA_CERTS: path.join(state, 'authority/ca.crt') } });
  let browser;
  try {
    const capability = (await call(base + '/capabilities')).value.text;
    assert.equal(capability.configured, true); assert.equal(capability.device_execution, false);
    const browserErrors = [];
    // 浏览器仅对本安装叶证书SPKI使用例外；API与CLI仍校验私有CA、主机名和期限。
    const certificate = new X509Certificate(await readFile(path.join(state, 'tls/server.crt')));
    const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE, args: ['--ignore-certificate-errors-spki-list=' + spki] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' }); page.setDefaultTimeout(15000);
    page.on('pageerror', error => browserErrors.push(error.message));
    const panel = page.getByRole('region', { name: '本地对话', exact: true });
    async function browserLogin() {
      await page.goto(origin + '/?view=text');
      await page.getByLabel('所有者凭据', { exact: true }).fill(token);
      await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
      await expect(panel.getByRole('button', { name: '查询原任务', exact: true }).or(panel.getByLabel('消息', { exact: true })).first()).toBeEnabled();
    }
    await browserLogin();
    const originals = [];
    for (const sample of samples) {
      let input = inputFor(sample), key = 'nas-real-' + sample.id;
      if (sample.id === 'arithmetic') {
        await panel.getByLabel('消息', { exact: true }).fill(sample.messages[0].content);
        const pending = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === base + '/text-generations');
        await panel.getByRole('button', { name: '发送', exact: true }).click();
        const submitted = await pending; input = submitted.postDataJSON(); key = await submitted.headerValue('idempotency-key');
        assert.deepEqual(input.messages, sample.messages); assert.equal(input.instructions, '');
        await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText('15', { timeout: 88000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(directory, 'nas-real-text-mobile.png'), fullPage: true });
      } else if (sample.id === 'context') {
        const filename = path.join(directory, 'context.json'); await writeFile(filename, JSON.stringify(input), { mode: 0o600 });
        const accepted = JSON.parse((await cli(['create', '--input', filename, '--idempotency-key', key])).stdout);
        assert.equal((await stat(accepted.cli.record_file)).mode & 0o777, 0o600);
        const saved = await readFile(accepted.cli.record_file, 'utf8'); for (const message of sample.messages) assert.equal(saved.includes(message.content), false);
      } else assert.equal((await call(base + '/text-generations', input, key)).status, 202);
      const original = await createTextOriginal(origin, 'space-demo', key, input), task = await finish(key);
      await verifyTextTask(task, 'space-demo', key, original);
      result.cases.push({ id: sample.id, status: task.status, error_code: task.error_code, text: task.output?.text, usage: task.usage });
      assert.equal(task.status, 'succeeded', JSON.stringify(task)); sample.check(task.output.text);
      assert.equal(task.deployment.model, model); assert.ok(task.usage.input_tokens > 0 && task.usage.output_tokens > 0);
      originals.push({ key, input, original, task });
      console.log(JSON.stringify({ nas_text_sample: sample.id, passed: true }));
    }
    assert.equal((await relay()).calls.length, 0); assert.equal(await providerCalls(), 3);
    result.initial_samples_use_direct_production_service = true;
    assert.equal((await call(base + '/commands')).value.items.length, 0);
    assert.equal((await call(base + '/rule-deployments')).value.items.length, 0);
    await compose(['restart', 'gateway']); await authenticate();
    for (const { key, original, task } of originals) { const current = await finish(key); await verifyTextTask(current, 'space-demo', key, original); assert.equal(current.output.text, task.output.text); }
    assert.equal(JSON.parse((await cli(['resolve', originals[1].key])).stdout).output.text, originals[1].task.output.text);
    await browserLogin(); await panel.getByRole('button', { name: '查询原任务', exact: true }).click();
    await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText('15');
    assert.equal((await relay()).calls.length, 0); assert.equal(await providerCalls(), 3);
    result.completed_restart_no_inference = true;

    await useRelay();
    await writeFile(path.join(directory, 'relay-control/mode.json'), JSON.stringify({ mode: 'hold' }));
    const interrupted = inputFor(samples[0]), heldKey = 'nas-real-held';
    assert.equal((await call(base + '/text-generations', interrupted, heldKey)).status, 202);
    await until(async () => (await relay()).calls.some(entry => entry.held && entry.computed), 88000);
    result.before_restore_relay = await relay(); assert.equal(result.before_restore_relay.calls.length, 1); assert.equal(await providerCalls(), 4);
    for (const entry of result.before_restore_relay.calls) assert.equal(entry.status, 200);
    const snapshot = await readFile(path.join(state, 'data/gateway.sqlite.media.json'));
    const disk = JSON.parse(snapshot); assert.equal(disk.schema_version, 5); assert.equal(disk.texts[heldKey].status, 'running');
    const backup = path.join(directory, 'backup'), restored = path.join(directory, 'restored');
    await manager('backup', '--directory', state, '--output', backup);
    await manager('restore', '--directory', restored, '--backup', backup);
    for (const target of [backup, restored]) assert.deepEqual(await readFile(path.join(target, 'data/gateway.sqlite.media.json')), snapshot);
    await compose(['down', '--remove-orphans']);
    await writeFile(path.join(directory, 'relay-control/mode.json'), JSON.stringify({ mode: 'pass' }));
    await restore(restored); await compose(['up', '--no-build', '-d', '--wait', '--wait-timeout', '120']); await authenticate();
    for (const { key, original, task } of originals) { const current = await finish(key); await verifyTextTask(current, 'space-demo', key, original); assert.equal(current.output.text, task.output.text); }
    const unknown = await finish(heldKey); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error_code, 'text_interrupted'); assert.equal(unknown.request_digest, disk.texts[heldKey].request_digest);
    assert.equal((await call(base + '/text-generations', inputFor(samples[0]), 'nas-budget-blocked')).status, 429);
    assert.equal((await relay()).calls.length, 0); assert.equal(await providerCalls(), restoredProviderCalls);
    await browserLogin(); await panel.getByRole('button', { name: '查询原任务', exact: true }).click();
    await expect(panel.getByLabel('回答结果', { exact: true })).toHaveText('15');
    await page.screenshot({ path: path.join(directory, 'nas-real-text-restored-mobile.png'), fullPage: true });
    await panel.getByRole('button', { name: '清除回答', exact: true }).click();
    await panel.getByRole('button', { name: '确认清除输出', exact: true }).click();
    await expect(panel.getByText('回答已清除', { exact: true })).toBeVisible();
    for (const { key } of originals.slice(1)) assert.equal((await call(base + '/text-generations/by-key/' + key + '/discard', {})).status, 200);
    assert.equal((await call(base + '/text-generations/by-key/' + heldKey + '/discard', {})).value.status, 'discarded');
    await browser.close(); browser = undefined;
    await compose(['restart', 'gateway']); await authenticate();
    for (const { key } of originals) { const current = await finish(key); assert.equal(current.output.text, null); assert.ok(current.output.cleared_at); }
    assert.equal((await finish(heldKey)).status, 'discarded'); assert.equal((await relay()).calls.length, 0); assert.equal(await providerCalls(), restoredProviderCalls);
    result.snapshot_v5_byte_exact_backup_new_directory_restore = true; result.unknown_budget_no_replay = true; result.explicit_clear_survives_restart = true;

    if (stopProvider) await stopProvider(); else await compose(['stop', providerService]);
    assert.equal((await call(base + '/text-generations', inputFor(samples[0]), 'nas-provider-offline')).status, 202);
    const offline = await finish('nas-provider-offline'); assert.equal(offline.status, 'unknown'); assert.equal(offline.error_code, 'text_provider_unknown');
    const device = await until(async () => { const response = await call(base + '/devices/device-lamp'); return response.status === 200 && response.value.ready && response.value; }, 30000);
    const command = await call(base + '/commands', { device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 10000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'nas-outage-explicit-control');
    assert.equal(command.status, 202, JSON.stringify(command.value));
    await until(async () => (await call(base + '/commands/' + command.value.command_id)).value.status === 'confirmed');
    assert.equal((await call(base + '/commands')).value.items.length, 1); assert.equal((await call(base + '/rule-deployments')).value.items.length, 0);
    const after = await relay(); assert.equal(after.calls.length, 1); assert.equal(after.calls[0].computed, false);
    assert.equal(await providerCalls(), restoredProviderCalls); assert.deepEqual(browserErrors, []);
    await call(base + '/text-generations/by-key/nas-provider-offline/discard', {});
    Object.assign(result, { passed: true, provider_placement: providerPlacement, real_model_container_stopped: !stopProvider, real_external_model_process_stopped: Boolean(stopProvider), manual_command_confirmed_during_model_outage: true, automatic_commands: 0, explicit_commands: 1, provider_completions_before_restore: 4, provider_completions_after_restore: 0, gateway_restarts: 2, gateway_recreations_for_fault_injection: 1, installation_recreations: 1, browser_errors: browserErrors, viewport: 390, browser_certificate_exception: 'installation_leaf_spki_only', api_and_cli_verify_private_ca_and_hostname: true, independent_quality_benchmark: false });
    return result;
  } finally {
    await browser?.close();
    await writeFile(path.join(directory, 'text-journey.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  }
}
