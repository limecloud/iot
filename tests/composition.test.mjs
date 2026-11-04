import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { compileComposition, parseComposition } from '../packages/protocol/composition.mjs';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const example = path.join(root, 'examples/compositions/reading-companion');
const source = () => readFile(path.join(example, 'package.json'), 'utf8');
const bindings = () => readFile(path.join(example, 'bindings.json'), 'utf8');
const cli = (args, env = {}) => exec(process.execPath, ['packages/cli/src/main.mjs', 'composition', ...args], {
  cwd: root, env: { ...process.env, LIMEIOT_TOKEN: '', LIMEIOT_TOKEN_FILE: '', ...env }, timeout: 10000,
});
const inputs = ['--input', path.join(example, 'package.json'), '--bindings', path.join(example, 'bindings.json'), '--id', 'reading-test'];

test('组合包与正式规则Schema一致，未知行为和边界输入拒绝，编译只替换角色', async () => {
  const raw = await source(), map = await bindings(), original = JSON.parse(raw);
  const ajv = new Ajv({ strict: true });
  const ruleSchema = JSON.parse(await readFile(path.join(root, 'contracts/rule.schema.json'), 'utf8'));
  const schema = JSON.parse(await readFile(path.join(root, 'contracts/composition.schema.json'), 'utf8'));
  ajv.addSchema(ruleSchema, 'rule.schema.json');
  const validate = ajv.compile(schema);
  assert.equal(validate(original), true, JSON.stringify(validate.errors));
  const invalid = [
    value => { value.schema_version = 2; },
    value => { value.script = 'run'; },
    value => { value.package_id = '../run'; },
    value => { value.version = '01.0.0'; },
    value => { value.version = '1.0.0-preview'; },
    value => { value.name = ''; },
    value => { value.modules = {}; },
    value => { value.modules.light.extra = true; },
    value => { value.modules.light.model_revision = 'latest'; },
    value => { value.rule.version = 2; },
    value => { delete value.rule.id; },
    value => { value.rule.trigger.extra = true; },
    value => { value.rule.trigger = { schedule: { time: '22:00', time_zone: 'Asia/Shanghai', weekdays: [1] } }; },
    value => { value.rule.conditions = [{ device: 'light', property: 'light.power', operator: 'eq', value: true }]; },
    value => { value.rule.actions = []; },
    value => { value.rule.actions = Array(17).fill(value.rule.actions[0]); },
    value => { value.rule.actions[0].invoke = { path: 'x', input: {} }; },
    value => { value.rule.actions[0] = { device: 'light', invoke: { path: 'x', input: {} } }; },
    value => { delete value.rule.actions[0].set.value; },
    value => { value.rule.actions[0].set.path = false; },
    value => { value.rule.cooldown_ms = 0.5; },
    value => { value.rule.cooldown_ms = 86400001; },
    value => { value.sample_event_data = []; },
  ];
  for (const change of invalid) {
    const candidate = structuredClone(original); change(candidate);
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
    assert.throws(() => parseComposition(JSON.stringify(candidate)), /invalid_composition/);
  }
  for (const change of [value => { value.rule.trigger.device = 'missing'; }, value => { value.modules.unused = value.modules.light; }]) {
    const candidate = structuredClone(original); change(candidate);
    assert.throws(() => parseComposition(JSON.stringify(candidate)), /composition_role_mismatch/);
  }
  for (const bad of [raw.replace('"schema_version": 1', '"schema_version":1,"schema_version":1'), raw + '{}', ' '.repeat(32769)]) {
    assert.throws(() => parseComposition(bad), /invalid_composition/);
  }
  for (const bad of [{ light: 'device-lamp' }, { ...JSON.parse(map), ghost: 'device-ghost' }, { touch: 'same', light: 'same' }, { touch: 'x/y', light: 'device-lamp' }]) {
    await assert.rejects(compileComposition(raw, JSON.stringify(bad), 'reading-test'), /invalid_composition_bindings/);
  }
  await assert.rejects(compileComposition(raw, map, ''), /composition_instance_id_required/);
  const compiled = await compileComposition(raw, map, 'reading-test');
  assert.equal(ajv.compile(ruleSchema)(compiled.rule), true);
  assert.equal(compiled.rule.id, 'reading-test');
  assert.equal(compiled.rule.trigger.device, 'device-button');
  assert(compiled.rule.actions.every(action => action.device === 'device-lamp'));
  assert.deepEqual(compiled.rule.actions.map(action => action.set), original.rule.actions.map(action => action.set));
  assert.equal(compiled.required_permissions.length, 3);
  assert.equal(compiled.gateway_checked, false); assert.equal(compiled.deployed, false);
  assert.equal(compiled.rule_revision, await documentDigest(compiled.rule));
  const reordered = await compileComposition(canonicalJSON(original), canonicalJSON(JSON.parse(map)), 'reading-test');
  assert.deepEqual(reordered, compiled);
  const rebound = await compileComposition(raw, JSON.stringify({ touch: 'another-touch', light: 'another-light' }), 'another-instance');
  assert.equal(rebound.package_digest, compiled.package_digest);
  assert.notEqual(rebound.rule_revision, compiled.rule_revision);
  assert.notEqual(rebound.bindings_digest, compiled.bindings_digest);
});

test('离线机器发现和编译不读取凭据，命令不隐式部署', async () => {
  const schema = JSON.parse((await cli(['schema'], { LIMEIOT_TOKEN_FILE: '/nonexistent/composition-credentials' })).stdout);
  assert.equal(schema.grants_authority, false);
  assert.deepEqual(schema.commands, ['schema', 'compile', 'plan']);
  const output = JSON.parse((await cli(['compile', ...inputs], { LIMEIOT_TOKEN_FILE: '/nonexistent/composition-credentials' })).stdout);
  assert.equal(output.deployed, false); assert.equal(output.gateway_checked, false);
  await assert.rejects(cli(['deploy', ...inputs]), error => error.code === 2 && JSON.parse(error.stderr).error.code === 'unsupported_operation');
  await assert.rejects(cli(['plan', ...inputs, '--space-id', 'space-demo']), error => error.code === 3 && JSON.parse(error.stderr).error.code === 'unauthenticated');
  await assert.rejects(cli(['plan', ...inputs, '--space-id', 'space-demo', '--endpoint', 'http://example.invalid']), error => error.code === 2 && JSON.parse(error.stderr).error.code === 'secure_endpoint_required');
});

test('在线规划拒绝模型变化、伪造预演和过大响应，始终零部署或命令', { timeout: 30000 }, async t => {
  const manifest = JSON.parse(await source());
  const temporary = await mkdtemp(path.join(root, '.dev/composition-boundaries-'));
  const requests = []; let mode = 'valid', deviceReads = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'large') { response.end(' '.repeat(65537)); return; }
    if (request.url.includes('/devices/')) {
      deviceReads++;
      const device = request.url.endsWith('device-button') ? 'touch' : 'light';
      response.end(JSON.stringify({ device_id: device === 'touch' ? 'device-button' : 'device-lamp', ready: true,
        model_revision: mode === 'mismatch' || mode === 'late-mismatch' && deviceReads > 2 ? 'sha256:' + '0'.repeat(64) : manifest.modules[device].model_revision }));
    } else if (request.url.endsWith('/rules:validate')) {
      response.end(JSON.stringify({ valid: true, revision: await documentDigest(body) }));
    } else if (request.url.endsWith('/rules:simulate')) {
      response.end(JSON.stringify({ revision: await documentDigest(body.rule), simulation: true, executed: mode === 'forged', matched: true, proposed_actions: body.rule.actions }));
    } else { response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { LIMEIOT_TOKEN: 'composition-test-only', LIMEIOT_ENDPOINT: 'http://127.0.0.1:' + server.address().port };
  const args = ['plan', ...inputs, '--space-id', 'space-demo'];
  const planned = JSON.parse((await cli(args, env)).stdout);
  assert.equal(planned.gateway_checked, true); assert.equal(planned.deployed, false);
  assert.equal(deviceReads, 4); assert.equal(planned.simulation.executed, false);
  for (const [scenario, code, exit] of [['mismatch', 'composition_model_mismatch', 4], ['late-mismatch', 'composition_model_mismatch', 4], ['forged', 'invalid_simulation', 5], ['large', 'composition_gateway_unavailable', 5]]) {
    mode = scenario; deviceReads = 0;
    await assert.rejects(cli(args, env), error => error.code === exit && JSON.parse(error.stderr).error.code === code);
  }
  assert(requests.every(item => item.method === 'GET' && item.path.includes('/devices/') || item.method === 'POST' && /\/rules:(validate|simulate)$/.test(item.path)));
  await writeFile(path.join(temporary, 'result.json'), JSON.stringify({ passed: true, malformed_schema_cases: 23, no_deployment_or_command: true, model_changes_rejected: true, forged_simulation_rejected: true, bounded_response: true, requests }, null, 2) + '\n');
  t.diagnostic('evidence: ' + path.join(temporary, 'result.json'));
});
