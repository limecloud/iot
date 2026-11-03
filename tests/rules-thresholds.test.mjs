import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { chromium, expect } from '@playwright/test';
import { root, startStack, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const post = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const fixture = async () => JSON.parse(await readFile(path.join(root, 'contracts/examples/environment-light.json')));
function packet(temperature) {
  const raw = Math.round((temperature + 4500) * 65535 / 17500);
  assert.equal(-4500 + Math.round(raw * 17500 / 65535), temperature);
  const bytes = [raw >> 8, raw & 255, 0, 128, 0, 162];
  let crc = 255;
  for (const byte of bytes.slice(0, 2)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 128 ? 49 : 0)) & 255; }
  bytes[2] = crc; return bytes;
}
test('阈值合同严格互斥且发现目录与旧规则一致', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'))), rule = await fixture();
  const validate = new Ajv({ strict: true }).compile(schema);
  assert(validate(rule));
  assert(validate(JSON.parse(await readFile(path.join(root, 'contracts/examples/button-light.json')))));
  for (const trigger of [{ device: 'device-environment' }, { ...rule.trigger, event: 'button.pressed' },
    { ...rule.trigger, event: null }, { device: 'device-environment', property: null },
    { ...rule.trigger, property: { ...rule.trigger.property, edge: 'above' } }]) assert.equal(validate({ ...rule, trigger }), false);
  const catalog = JSON.parse(await readFile(path.join(root, 'contracts/tools/catalog.json')));
  assert.deepEqual(catalog.schemas.rule, schema); assert.deepEqual(catalog.schemas.simulation.properties.rule, schema);
});
test('C环境采样越过阈值经真实MQTT驱动灯光，滞回、重启与多端预演保持一致', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/rule-thresholds-')), nas = path.join(directory, 'nas');
  await exec('python3', ['deploy/nas/manage.py', 'init', '--directory', nas, '--origin', 'https://127.0.0.1:18443', '--with-environment'], { cwd: root });
  const credentials = { owner: (await readFile(path.join(nas, 'secrets/owner-token'), 'utf8')).trim() };
  for (const role of ['gateway', 'lamp', 'button', 'environment']) credentials[role] = (await readFile(path.join(nas, 'secrets/'+(role === 'gateway' ? role : 'device-'+role)+'-password'), 'utf8')).trim();
  const stack = await startStack({ directory: path.join(directory, 'runtime'), firmware: true, environment: true, credentials, gatewayEnv: { LIMEIOT_CONFIG: path.join(nas, 'config/gateway.json') } });
  t.after(() => stack.close());
  const rule = await fixture(), file = path.join(directory, 'rule.json'); await writeFile(file, JSON.stringify(rule));
  const cli = async (operation, filename) => JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space-demo', '--input', filename], { cwd: root, env: stack.env })).stdout);
  assert.equal((await cli('rules.validate', file)).valid, true);
  const now = Date.now(), sample = (value, time) => ({ value, observed_at: new Date(time).toISOString(), quality: 'confirmed', source: 'simulation' });
  const simulation = { rule, event: { device_id: 'device-environment', path: 'environment.temperature', historical: false, previous: sample(2500, now-1000), current: sample(2900, now) } };
  const simfile = path.join(directory, 'simulation.json'); await writeFile(simfile, JSON.stringify(simulation));
  const proof = await cli('rules.simulate', simfile); assert.equal(proof.matched, true); assert.equal(proof.executed, false);
  assert.equal((await stack.request(base+'/commands')).value.items.length, 0);
  const deployment = await cli('rules.deploy', file); assert.equal(deployment.rule.trigger.property.threshold, 2800);
  const sensor = async () => (await stack.request(base+'/devices/device-environment')).value;
  const baseline = await sensor();
  await until(async () => (await sensor()).state_revision > baseline.state_revision);
  async function temperature(value) {
    stack.environment.stdin.write(JSON.stringify({ sensor_packet: packet(value) })+'\n');
    return until(async () => { const device = await sensor(); return device.reported['environment.temperature'].value === value && device; }, 15000);
  }
  await temperature(2900);
  const first = await until(async () => (await stack.request(base+'/runs')).value.items[0]);
  const confirmed = await until(async () => { const result = (await stack.request(base+'/commands/'+first.command_ids[0])).value; return result.status === 'confirmed' && result; });
  assert.equal(confirmed.evidence.reported['light.brightness'], 30);
  assert.equal(first.property_trigger.current.value, 2900);
  assert.equal(first.property_trigger.current.source, 'host-fixture.sht3x');
  await stack.restartGateway(); await until(async () => (await sensor()).ready);
  await temperature(2750); await temperature(2900);
  assert.equal((await stack.request(base+'/runs')).value.items.length, 1, '滞回区间和高值恢复不补发');
  await temperature(2600); await temperature(2900);
  const runs = await until(async () => { const items = (await stack.request(base+'/runs')).value.items; return items.length === 2 && items; });
  assert.equal(new Set(runs.map(item => item.event_id)).size, 2);
  for (const run of runs) await until(async () => (await stack.request(base+'/commands/'+run.command_ids[0])).value.status === 'confirmed');
  const commands = (await stack.request(base+'/commands')).value.items; assert.equal(commands.length, 2);
  const nativeEnv = { ...stack.env, LIMEIOT_THRESHOLD_CHECK: '1' };
  const swift = await exec('swift', ['run', 'ClientChecks'], { cwd: path.join(root, 'apps/ios'), env: nativeEnv, timeout: 60000 });
  assert.match(swift.stdout, /"threshold_integration":"passed"/); await writeFile(path.join(directory, 'swift.log'), swift.stdout+swift.stderr);
  const kotlin = await exec('sh', ['gradlew', '--no-daemon', ':core:test', '--tests', '*RuleTriggerTest', '--rerun-tasks'], { cwd: path.join(root, 'apps/android'), env: nativeEnv, timeout: 90000 });
  await writeFile(path.join(directory, 'kotlin.log'), kotlin.stdout+kotlin.stderr);
  assert.equal((await stack.request(base+'/commands')).value.items.length, 2, '多端预演不创建设备命令');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT); await page.getByLabel('所有者凭据', { exact: true }).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button', { name: '连接家庭网关', exact: true }).click();
  await page.getByRole('button', { name: '自动化', exact: true }).click();
  await expect(page.getByRole('heading', { name: '温度上升越过 28.00 ℃，滞回 1.00 ℃', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'threshold-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const threshold = page.getByLabel('阈值（℃）', { exact: true });
  const hysteresis = page.getByLabel('滞回（℃）', { exact: true });
  const preview = page.getByRole('button', { name: '校验并预演', exact: true });
  const enable = page.getByRole('button', { name: '启用自动化', exact: true });
  await expect(threshold).toHaveValue('28'); await expect(hysteresis).toHaveValue('1');
  await expect(enable).toBeDisabled();
  await threshold.fill('28.001'); await expect(preview).toBeDisabled();
  await threshold.fill('29.03'); await hysteresis.fill('-1'); await expect(preview).toBeDisabled();
  await hysteresis.fill('1'); await preview.click(); await expect(enable).toBeEnabled();
  await threshold.fill('29.04'); await expect(enable).toBeDisabled();
  await threshold.fill('29.03');
  await page.getByLabel('变化方向', { exact: true }).selectOption('falling');
  await expect(enable).toBeDisabled(); await preview.click(); await expect(enable).toBeEnabled(); await enable.click();
  const edited = (await stack.request(base+'/rule-deployments')).value.items[0];
  assert.equal(edited.rule.trigger.property.threshold, 2903); assert.equal(edited.rule.trigger.property.hysteresis, 100);
  assert.equal(edited.rule.trigger.property.edge, 'falling'); assert.deepEqual(edited.rule.actions, rule.actions);
  await expect(page.getByRole('heading', { name: '温度下降越过 29.03 ℃，滞回 1.00 ℃', exact: true })).toBeVisible();
  assert.equal((await stack.request(base+'/commands')).value.items.length, 2, '编辑和预演没有额外命令');
  await page.screenshot({ path: path.join(directory, 'threshold-editor-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => { const rect = await page.locator('aside').boundingBox(); return rect.x + rect.width <= 0; }).toBe(true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, 'threshold-editor-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByText('暂无自动化', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建自动化', exact: true }).click();
  await page.getByLabel('当', { exact: true }).selectOption('device-environment/property/environment.temperature');
  await threshold.fill('29.03'); await hysteresis.fill('1'); await preview.click(); await expect(enable).toBeEnabled(); await enable.click();
  const created = (await stack.request(base+'/rule-deployments')).value.items[0];
  assert.notEqual(created.rule.id, rule.id); assert.equal(created.rule.trigger.property.threshold, 2903);
  assert.equal((await stack.request(base+'/commands')).value.items.length, 2, '创建规则没有额外命令');
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByText('暂无自动化', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, real_c_sensor_and_lamp: true, synthetic_i2c: true,
    real_mqtt_rust_sqlite: true, cli_validate_simulate_deploy: true, zero_effect_simulation: true,
    rising_edge_hysteresis: true, gateway_restart_no_replay: true, swift_kotlin_actual_http: true,
    web_display_and_stop: true, web_threshold_editor: true, web_threshold_editor_create_edit_roundtrip: true, native_threshold_helpers_http: true, native_threshold_editor_runtime: false, native_app_runtime: false,
    hardware: false, hardware_status: '用户要求跳过', full_goal_completed: false, runs: runs.length, commands: commands.length }, null, 2));
});
