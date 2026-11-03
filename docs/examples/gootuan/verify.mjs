import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv from 'ajv/dist/2020.js';
import { verifyModelReport } from '../../../packages/protocol/model-validation.mjs';
import { verifyRuleSimulation } from '../../../packages/protocol/rule-simulation.mjs';

// 本例只消费现有合同与实验工具，不增加网关能力或产品运动驱动。
const exec = promisify(execFile);
const here = fileURLToPath(new URL('./', import.meta.url));
const root = path.resolve(here, '../../..');
const integration = process.argv.slice(2);
if (integration.length > 1 || (integration.length === 1 && integration[0] !== '--integration')) throw new Error('Usage: node docs/examples/gootuan/verify.mjs [--integration]');
const model = JSON.parse(await readFile(path.join(here, 'model.json'), 'utf8'));
const rule = JSON.parse(await readFile(path.join(here, 'rule.json'), 'utf8'));
const event = JSON.parse(await readFile(path.join(here, 'event.json'), 'utf8'));
const ajv = new Ajv({ strict: true });
const modelSchema = ajv.compile(JSON.parse(await readFile(path.join(root, 'contracts/model.schema.json'), 'utf8')));
const ruleSchema = ajv.compile(JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'), 'utf8')));
assert(modelSchema(model), JSON.stringify(modelSchema.errors));
assert(ruleSchema(rule), JSON.stringify(ruleSchema.errors));
const touchSchema = ajv.compile(model.services.find(service => service.id === 'touch').events[0].schema);
assert(touchSchema(event.data));
assert.equal(touchSchema({ count: 0 }), false);
assert.equal(ruleSchema({ ...rule, actions: [{ ...rule.actions[0], invoke: { path: 'motion.run', input: {} } }] }), false);
const validator = process.env.LIMEIOT_MODEL_VALIDATOR ?? path.join(root, 'target/debug/limeiot-model-validator');
assert(path.isAbsolute(validator), 'LIMEIOT_MODEL_VALIDATOR must be absolute');
const result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', path.join(here, 'model.json')], {
  cwd: root, timeout: 8000, env: { ...process.env, LIMEIOT_MODEL_VALIDATOR: validator },
});
const report = await verifyModelReport(JSON.parse(result.stdout), model);
assert.equal(report.valid, true);
const summary = { formal_schema: true, shared_rust_model_validator: report.validator, model_revision: report.model_revision, invalid_touch_rejected: true, conflicting_rule_operations_rejected: true, real_http: false, real_mqtt: false, real_sqlite: false, hardware: false, motion: false, beat_synchronization: false };

if (integration.length) {
  const { startStack, until } = await import('../../../tools/dev-stack.mjs');
  await mkdir(path.join(root, '.dev'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.dev/gootuan-example-'));
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
  config.models = [report.normalized_model];
  config.devices = ['device-lamp', 'device-button'].map(device_id => ({ device_id, model_revision: report.model_revision }));
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  // 保留既有测试装配器的两个设备ID；二者均换成本例灯光/触摸模型。
  const stack = await startStack({ directory, modelPaths: { lamp: path.join(here, 'model.json'), button: path.join(here, 'model.json') }, gatewayEnv: { LIMEIOT_CONFIG: configPath } });
  const base = '/api/v1/spaces/space-demo';
  const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const validation = await stack.request(base + '/rules:validate', post(rule));
    assert.equal(validation.status, 200);
    assert.equal(validation.value.valid, true);
    const proof = await stack.request(base + '/rules:simulate', post({ rule, event }));
    assert.equal(proof.status, 200);
    await verifyRuleSimulation(rule, proof.value, validation.value);
    assert.equal(proof.value.simulation, true);
    assert.equal(proof.value.executed, false);
    assert.equal(proof.value.matched, true);
    assert.deepEqual(proof.value.proposed_actions, rule.actions);
    assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
    for (const device of ['lamp', 'button']) {
      const current = (await stack.request(base + '/devices/device-' + device)).value;
      assert.equal(current.reported['light.power'].value, false);
      assert.equal(current.reported['light.power'].source, 'simulator');
    }
    const deployment = await stack.request(base + '/rule-deployments', post(rule));
    assert.equal(deployment.status, 200);
    const live = { event_id: 'gootuan-touch-001', occurred_at: new Date().toISOString(), path: event.path, historical: false, data: event.data };
    stack.button.stdin.write(JSON.stringify(live) + '\n');
    const run = await until(async () => (await stack.request(base + '/runs')).value.items[0]);
    assert.equal(run.command_ids.length, 2);
    for (const commandID of run.command_ids) {
      const command = await until(async () => {
        const current = (await stack.request(base + '/commands/' + commandID)).value;
        return current.status === 'confirmed' && current;
      });
      assert.equal(command.request.operation.type, 'property.set');
      assert.equal(command.evidence.type, 'device_result');
      assert.equal(command.evidence.reported['light.power'], true);
    }
    for (const device of ['lamp', 'button']) assert.equal(JSON.parse(await readFile(path.join(directory, `${device}.json`), 'utf8')).reported['light.power'], true);
    stack.button.stdin.write(JSON.stringify(live) + '\n');
    stack.button.stdin.write(JSON.stringify({ ...live, event_id: 'gootuan-history-001', historical: true }) + '\n');
    await until(async () => (await stack.request(base + '/events?after=0')).value.items.filter(item => item.type === 'device.event').length >= 3);
    assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
    assert.equal((await stack.request(base + '/commands')).value.items.length, 2);
    const stopped = await stack.request(base + '/rule-deployments/' + rule.id + '/stop', post({ revision: deployment.value.revision }));
    assert.equal(stopped.status, 200);
    Object.assign(summary, { real_http: true, real_mqtt: true, real_sqlite: true, simulation_zero_effects: true, two_virtual_light_results: true, duplicate_and_historical_event_no_replay: true, rule_stopped: true });
    await writeFile(path.join(directory, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
  } finally { await stack.close(); }
}
console.log(JSON.stringify(summary, null, 2));
