import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { root, until } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { actionInput, actionState, base, commandResult, post, startActionStack } from './helpers/actions.mjs';

const exec = promisify(execFile);
test('Schema 2动作经过真实HTTP/MQTT：输入校验、顺序、证据、重复传输与双端重启', { timeout: 45000 }, async t => {
  const stack = await startActionStack(); t.after(() => stack.close());
  const publisher = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'gateway', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => publisher.close());
  const initial = (await stack.request(base + '/devices/device-lamp')).value.reported;
  for (const [name, value] of [['key', { key: 'shell' }], ['extra', { key: 'home', command: 'reboot' }], ['shape', 'home']]) {
    const rejected = await stack.request(base + '/commands', post(await actionInput(stack, 'remote.press', value), 'invalid-' + name));
    assert.equal(rejected.value.error.code, 'invalid_value');
  }
  const inputs = await Promise.all(['up', 'down', 'select'].map(key => actionInput(stack, 'remote.press', { key })));
  inputs.push(await actionInput(stack, 'apps.launch', { application_id: 'org.example.player' }));
  const created = await Promise.all(inputs.map((input, i) => stack.request(base + '/commands', post(input, 'action-' + i))));
  created.forEach(response => assert.equal(response.status, 202));
  for (let i = 0; i < created.length; i++) {
    const result = await commandResult(stack, created[i].value.command_id);
    assert.equal(result.evidence.type, 'action_result');
    assert.equal(result.evidence.path, inputs[i].operation.path);
    assert.equal(result.evidence.input_digest, await documentDigest(inputs[i].operation.value));
    assert.equal(result.evidence.completion, 'submitted'); assert.deepEqual(result.evidence.output, {});
  }
  const order = [...created].sort((a, b) => a.value.sequence - b.value.sequence).map(response => response.value.command_id);
  assert.deepEqual((await actionState(stack)).action_log.map(item => item.command_id), order);
  const observed = (await stack.request(base + '/devices/device-lamp')).value.reported;
  for (const property of Object.keys(initial)) assert.deepEqual(observed[property].value, initial[property].value);
  const repeated = await stack.request(base + '/commands', post(inputs[0], 'action-0'));
  assert.equal(repeated.value.command_id, created[0].value.command_id);
  const conflict = await stack.request(base + '/commands', post({ ...inputs[0], operation: { ...inputs[0].operation, value: { key: 'back' } } }, 'action-0'));
  assert.equal(conflict.status, 409);
  // 真实重投递原封装；执行端回读原回执，不能再产生一次虚拟输入。
  await publisher.publish('limeiot/v1/space-demo/device-lamp/down/command', JSON.stringify(created[0].value.envelope));
  await publisher.publish('limeiot/v1/space-demo/device-lamp/down/command', JSON.stringify(created[0].value.envelope));
  const property = { ...inputs[0], expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'audio.volume', value: 75 } };
  const volume = await stack.request(base + '/commands', post(property, 'volume'));
  await commandResult(stack, volume.value.command_id);
  await until(async () => (await stack.request(base + '/devices/device-lamp')).value.reported['audio.volume'].value === 75);
  assert.equal((await actionState(stack)).action_log.length, 4);
  await stack.restartGateway(); await stack.restartDevice('lamp');
  assert.equal((await stack.request(base + '/commands/' + created[0].value.command_id)).value.status, 'confirmed');
  assert.equal((await stack.request(base + '/commands', post(inputs[0], 'action-0'))).value.command_id, created[0].value.command_id);
  assert.equal((await actionState(stack)).action_log.length, 4);
  assert.equal((await stack.request(base + '/devices/device-lamp')).value.reported['audio.volume'].value, 75);
  await writeFile(path.join(stack.directory, 'actions-result.json'), JSON.stringify({ passed: true, real_http: true, real_mqtt: true, fifo: true, typed_evidence: true, duplicate_delivery: true, process_restart: true, hardware: false }));
});

test('动作已提交但回执丢失：unknown、原键查询及重启均不重发', { timeout: 30000 }, async t => {
  const stack = await startActionStack({ dropResults: true }); t.after(() => stack.close());
  const input = await actionInput(stack, 'remote.press', { key: 'home' }, 800);
  const created = await stack.request(base + '/commands', post(input, 'lost-action')); assert.equal(created.status, 202);
  const unknown = await commandResult(stack, created.value.command_id, 'unknown'); assert.equal(unknown.error, 'execution_unknown');
  assert.equal((await actionState(stack)).action_log.length, 1);
  const observer = await mqttProbe({ port: Number(stack.env.LIMEIOT_MQTT_PORT), username: 'device-lamp', password: stack.env.LIMEIOT_MQTT_PASSWORD }); t.after(() => observer.close());
  await observer.subscribe('limeiot/v1/space-demo/device-lamp/down/command');
  await stack.restartGateway(); await stack.restartDevice('lamp', { LIMEIOT_SIM_DROP_RESULTS: '0' });
  const recovered = await stack.request(base + '/commands', post(input, 'lost-action'));
  assert.equal(recovered.value.command_id, created.value.command_id); assert.equal(recovered.value.status, 'unknown');
  await assert.rejects(exec(process.execPath, ['packages/cli/src/main.mjs', 'commands', 'get', created.value.command_id, '--space-id', 'space-demo'], { cwd: root, env: stack.env }), error => error.code === 6 && JSON.parse(error.stdout).status === 'unknown');
  await assert.rejects(observer.message(200), /mqtt_packet_timeout/);
  assert.equal((await actionState(stack)).action_log.length, 1);
  const next = await stack.request(base + '/commands', post(await actionInput(stack, 'remote.press', { key: 'back' }), 'new-action'));
  await commandResult(stack, next.value.command_id);
  assert.equal(JSON.parse((await observer.message()).payload).body.command_id, next.value.command_id);
  assert.deepEqual((await actionState(stack)).action_log.map(entry => entry.command_id), [created.value.command_id, next.value.command_id]);
  assert.equal((await stack.request(base + '/commands/' + created.value.command_id)).value.status, 'unknown');
  await writeFile(path.join(stack.directory, 'actions-unknown-result.json'), JSON.stringify({ passed: true, real_mqtt: true, original_key_only: true, restart_no_replay: true, lost_receipt: true, physical_exactly_once: false, hardware: false }));
});
