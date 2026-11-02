import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startStack, until } from '../tools/dev-stack.mjs';

const base = '/api/v1/spaces/space-demo';
async function control(stack, key, value) {
  const lamp = (await stack.request(base + '/devices/device-lamp')).value;
  const input = { device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.power', value } };
  const accepted = await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
  assert.equal(accepted.status, 202); return accepted.value;
}
async function command(stack, id, status) {
  return until(async () => { const current = (await stack.request(base + '/commands/' + id)).value; return current.status === status && current; });
}
function ordered(value) { return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value; }

test('同一C固件核心通过真实MQTT完成控制、规则、原操作和跨语言命令摘要', { timeout: 30000 }, async () => {
  const stack = await startStack({ firmware: true });
  try {
    const original = await control(stack, 'firmware-first', false);
    await command(stack, original.command_id, 'confirmed');
    const receipt = JSON.parse(await readFile(path.join(stack.directory, 'firmware-lamp/receipt-0.json'), 'utf8'));
    assert.equal(receipt.fingerprint, createHash('sha256').update(JSON.stringify(ordered(original.envelope))).digest('hex'));
    assert.equal((await stack.request(base + '/commands/by-key/firmware-first')).value.command_id, original.command_id);
    const rule = JSON.parse(await readFile(new URL('../contracts/examples/button-light.json', import.meta.url)));
    const deployed = await stack.request(base + '/rule-deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) });
    assert.equal(deployed.status, 200);
    stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
    const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
    assert.equal(run.command_ids.length, 1);
    await command(stack, run.command_ids[0], 'confirmed');
    const lamp = await until(async () => { const current = (await stack.request(base + '/devices/device-lamp')).value; return current.reported['light.power'].value === true && current; });
    assert.equal(lamp.reported['light.power'].source, 'host-fixture');
    const info = await until(async () => {
      const current = (await stack.request(base + '/devices/device-lamp')).value;
      return current.device_info?.fresh && current.device_info;
    });
    assert.equal(info.device.device_id, 'device-lamp');
    assert.equal(info.device.model_revision, lamp.model_revision);
    assert.equal(info.device.chip, 'host');
    assert.equal(info.device.board, 'host-fixture');
    assert.equal(info.device.firmware_version, '0.1.0');
    assert.equal(info.device.safe_to_update, false);
    assert.equal(info.device.battery_percent, null);
    assert.equal(info.session_id, lamp.session_id);
    assert.equal(info.boot_id, lamp.boot_id);
    assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  } finally { await stack.close(); }
});

test('C固件执行后回执耐久提交失败，网关保留unknown且重启不重放', { timeout: 30000 }, async () => {
  const stack = await startStack({ firmware: true, firmwareStoreFailure: 2 });
  try {
    const original = await control(stack, 'firmware-uncertain', true);
    const uncertain = await command(stack, original.command_id, 'unknown');
    assert.equal(uncertain.error, 'execution_unknown');
    const before = JSON.parse(await readFile(path.join(stack.directory, 'firmware-lamp/receipt-0.json'), 'utf8'));
    assert.equal(before.stage, 1);
    assert.equal(JSON.parse(await readFile(path.join(stack.directory, 'firmware-lamp/hardware.json'), 'utf8')).power, true);
    await stack.restartDevice('lamp', { LIMEIOT_FIRMWARE_FAIL_STORE: '0' });
    assert.equal((await stack.request(base + '/commands/by-key/firmware-uncertain')).value.status, 'unknown');
    assert.equal((await stack.request(base + '/commands')).value.items.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(stack.directory, 'firmware-lamp/receipt-0.json'), 'utf8')), before);
    const next = await control(stack, 'firmware-new-deliberate-control', false);
    await command(stack, next.command_id, 'confirmed');
    assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
  } finally { await stack.close(); }
});
