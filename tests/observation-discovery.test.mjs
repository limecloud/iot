import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseObservationDiscoveryQuery, verifyObservationDiscovery, verifyObservationEndpoints, supportsEnvironmentEndpoint } from '../packages/protocol/observation-discovery.mjs';
import { until } from '../tools/dev-stack.mjs';
import { base, post, targets, devices, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

const execute = promisify(execFile), coordinator = { coordinator_id: 'home-znp', coordinator_ieee: '0102030405060708' };
const query = { coordinator_id: coordinator.coordinator_id }, endpointQuery = { ...query, ieee_address: targets[0] };
const observed_at = '2026-11-04T00:00:00Z', expires_at = '2026-11-04T00:01:00Z';
const common = { ...coordinator, observed_at, expires_at, protocol: 'zigbee-znp', evidence: 'unauthenticated_protocol' };
const neighbor = { extended_pan_id: coordinator.coordinator_ieee, ieee_address: targets[0], network_address: 0x1234,
  device_type: 2, rx_on_when_idle: 0, relationship: 1, flags: 0x12, permit_joining: 0, depth: 1, link_quality: 200 };
const discovered = { ...common, scope: 'coordinator_neighbors', items: [neighbor] };
const interviewed = { ...common, ieee_address: targets[0], network_address: 0x1234, manufacturer_code: 4660,
  endpoints: [{ endpoint: 1, profile_id: 0x0104, device_id: 0x0302, device_version: 0, input_clusters: [0, 0x0402, 0x0405], output_clusters: [] }] };
const read = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));

test('Swift和Kotlin共用的发现向量通过正式Schema与JS合同', async () => {
  const fixture = await read('tests/fixtures/zigbee/observation-native.json');
  const schema = await read('contracts/observation-discovery.schema.json');
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const [definition, key, verify] of [['neighbors', 'discovery', verifyObservationDiscovery], ['endpoints', 'endpoints', verifyObservationEndpoints]]) {
    const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/' + definition });
    assert(validate(fixture[key]), JSON.stringify(validate.errors)); verify(fixture[key], { ...coordinator, ...endpointQuery });
  }
  for (const { name, document } of fixture.invalidDiscovery) assert.throws(() => verifyObservationDiscovery(document, coordinator), name);
  for (const { name, document } of fixture.invalidEndpoints) assert.throws(() => verifyObservationEndpoints(document, { ...coordinator, ...endpointQuery }), name);
  assert(supportsEnvironmentEndpoint(fixture.endpoints.endpoints[0])); assert(!supportsEnvironmentEndpoint(fixture.endpoints.endpoints[1]));
});

test('发现Schema和离线工具目录一致，严格拒绝客户端串口与重复键', async () => {
  const schema = await read('contracts/observation-discovery.schema.json'), catalog = await read('contracts/tools/catalog.json');
  assert.deepEqual(catalog.schemas['observation-discovery'], schema);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const [definition, value] of Object.entries({ query, endpointQuery, neighbors: discovered, endpoints: interviewed })) {
    const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/' + definition });
    assert(validate(value), JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, serial: '/dev/ttyUSB0' }), false);
  }
  assert.deepEqual(parseObservationDiscoveryQuery(JSON.stringify(query)), query);
  assert.deepEqual(parseObservationDiscoveryQuery(JSON.stringify(endpointQuery), true), endpointQuery);
  for (const value of [{ ...query, serial: '/dev/ttyUSB0' }, endpointQuery, { coordinator_id: 'bad\n' }]) assert.throws(() => parseObservationDiscoveryQuery(JSON.stringify(value)));
  assert.throws(() => parseObservationDiscoveryQuery('{"coordinator_id":"one","coordinator_id":"two"}'));
  assert.throws(() => parseObservationDiscoveryQuery(JSON.stringify({ ...endpointQuery, ieee_address: 'ffffffffffffffff' }), true));
  assert.throws(() => parseObservationDiscoveryQuery(JSON.stringify({ ...endpointQuery, ieee_address: targets[0] + '\n' }), true));
  const result = JSON.parse((await execute(process.execPath, ['packages/cli/src/main.mjs', 'schema', 'observation-discoveries.query'])).stdout);
  assert.equal(result.device_execution, false); assert.equal(result.request_timeout_ms, 35000);
  assert.deepEqual(result.schemas['observation-discovery'], schema);
});

test('发现与访谈回执核对上下文、位字段、地址唯一性与端点能力', () => {
  verifyObservationDiscovery(discovered, coordinator); verifyObservationEndpoints(interviewed, { ...coordinator, ...endpointQuery });
  assert(supportsEnvironmentEndpoint(interviewed.endpoints[0]));
  assert.equal(supportsEnvironmentEndpoint({ ...interviewed.endpoints[0], input_clusters: [0, 0x0402] }), false);
  for (const value of [
    { ...discovered, coordinator_id: 'other' }, { ...discovered, scope: 'network' },
    { ...discovered, expires_at: '2026-11-04T00:01:01Z' }, { ...discovered, observed_at: 'invalid' },
    { ...discovered, items: [neighbor, neighbor] }, { ...discovered, items: [{ ...neighbor, flags: 0 }] },
    { ...discovered, items: [{ ...neighbor, ieee_address: coordinator.coordinator_ieee }] },
    { ...discovered, items: [{ ...neighbor, network_address: 0xfff8 }] },
  ]) assert.throws(() => verifyObservationDiscovery(value, coordinator));
  for (const value of [
    { ...interviewed, coordinator_ieee: targets[1] }, { ...interviewed, ieee_address: targets[1] },
    { ...interviewed, endpoints: [...interviewed.endpoints, ...interviewed.endpoints] },
    { ...interviewed, endpoints: [{ ...interviewed.endpoints[0], input_clusters: [0, 0] }] },
    { ...interviewed, endpoints: [{ ...interviewed.endpoints[0], endpoint: 0 }] },
    { ...interviewed, manifest: {} },
  ]) assert.throws(() => verifyObservationEndpoints(value, { ...coordinator, ...endpointQuery }));
});

test('网关邻居发现与IEEE访谈不注册AF、不创建设备，CLI之后仍需明确绑定', { timeout: 60000 }, async t => {
  const { directory, stack, stats, sensor, commands, control, discovery } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  const discoveryPath = base + '/observation-discoveries', endpointsPath = base + '/observation-endpoints';
  const deviceIDs = async () => (await stack.request(base + '/devices')).value.items.map(item => item.device_id).sort();
  const originalDevices = await deviceIDs();
  const noAuth = await fetch(stack.env.LIMEIOT_ENDPOINT + discoveryPath, post(query)); assert.equal(noAuth.status, 401);
  for (const [resource, input, status] of [
    [discoveryPath, { ...query, ieee_address: targets[0] }, 422], [endpointsPath, { ...endpointQuery, serial: '/dev/ttyUSB0' }, 422],
    [endpointsPath, { ...endpointQuery, ieee_address: coordinator.coordinator_ieee }, 422],
    [discoveryPath, { coordinator_id: 'missing' }, 404], [endpointsPath.replace('space-demo', 'other'), endpointQuery, 403],
  ]) assert.equal((await stack.request(resource, post(input))).status, status);
  assert.equal((await stack.request(discoveryPath, { ...post(query), body: '{"coordinator_id":"one","coordinator_id":"two"}' })).status, 422);
  assert.equal((await stats()).neighbor_requests, 0);
  const found = await stack.request(discoveryPath, post(query)); assert.equal(found.status, 200);
  verifyObservationDiscovery(found.value, coordinator); assert.deepEqual(found.value.items.map(item => item.ieee_address), targets);
  const endpoints = await stack.request(endpointsPath, post(endpointQuery)); assert.equal(endpoints.status, 200);
  verifyObservationEndpoints(endpoints.value, { ...coordinator, ...endpointQuery });
  const schema = await read('contracts/observation-discovery.schema.json');
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  for (const [definition, value] of [['neighbors', found.value], ['endpoints', endpoints.value]]) {
    const validate = ajv.compile({ $defs: schema.$defs, $ref: '#/$defs/' + definition });
    assert(validate(value), JSON.stringify(validate.errors));
  }
  assert(supportsEnvironmentEndpoint(endpoints.value.endpoints[0]));
  await discovery('moved_device');
  const moved = await stack.request(endpointsPath, post(endpointQuery));
  assert.equal(moved.status, 422); assert.equal(moved.value.error.code, 'znp_identity_changed');
  await discovery('normal');
  const state = await stats(); assert.equal(state.af_requests, 0); assert.equal(state.host_checks, 0); assert.deepEqual(state.errors, []);
  assert.deepEqual(await deviceIDs(), originalDevices);
  assert.deepEqual((await stack.request(base + '/observation-candidates')).value.items, []);
  const env = { ...process.env, ...stack.env }; delete env.LIMEIOT_TOKEN_FILE;
  for (const [operation, input] of [['observation-discoveries.query', query], ['observation-endpoints.query', endpointQuery]]) {
    const file = path.join(directory, operation + '.json'); await writeFile(file, JSON.stringify(input));
    const result = JSON.parse((await execute(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space-demo', '--input', file], { env, timeout: 10000 })).stdout);
    (operation === 'observation-discoveries.query' ? verifyObservationDiscovery : verifyObservationEndpoints)(result, { ...coordinator, ...input });
  }
  const candidate = (await stack.request(base + '/observation-candidates', post({ ...endpointQuery, endpoint: 1 }))).value;
  const binding = (await stack.request(base + '/devices/' + devices[0] + '/observation-binding')).value;
  const bound = await stack.request(base + '/observation-operations', { ...post({ type: 'sources.bind', device_id: devices[0], source: candidate.source,
    expected_binding_revision: binding.revision, expected_model_revision: candidate.model_revision }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'discovered-bind' } });
  assert.equal(bound.value.status, 'applied');
  const initial = await until(async () => { const value = await sensor(); return value.ready && value; });
  assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule()))).status, 200);
  await until(async () => (await sensor()).state_revision > initial.state_revision);
  await control(2900);
  await until(async () => { const list = await commands(); return list.length === 1 && list[0].status === 'confirmed'; });
  await stack.restartGateway(); await until(async () => (await sensor()).ready);
  assert.equal((await commands()).length, 1);
  assert.deepEqual((await stats()).errors, []);
  await writeFile(path.join(directory, 'discovery-runtime-report.json'), JSON.stringify({ passed: true, readonly_discovery_and_interview: true,
    gateway_cli_bind_threshold_restart: true, discovery_af_requests: state.af_requests, confirmed_commands: 1, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'discovery-runtime-report.json') }));
});

test('发现、端点与候选共用查询slot，超时后先服务到期轮询，身份变化使整组离线', { timeout: 45000 }, async t => {
  const { directory, stack, stats, sensor, control, discovery } = await environmentStack(t, 1, { dynamic: true, timeoutMs: 1500 });
  const candidate = (await stack.request(base + '/observation-candidates', post({ ...endpointQuery, endpoint: 1 }))).value;
  const binding = (await stack.request(base + '/devices/' + devices[0] + '/observation-binding')).value;
  assert.equal((await stack.request(base + '/observation-operations', { ...post({ type: 'sources.bind', device_id: devices[0], source: candidate.source,
    expected_binding_revision: binding.revision, expected_model_revision: candidate.model_revision }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'create' } })).value.status, 'applied');
  await until(async () => (await sensor()).ready);
  await control(2600, 'interview_timeout', 1);
  const pending = stack.request(base + '/observation-endpoints', post({ ...query, ieee_address: targets[1] }));
  await until(async () => (await stats()).timeout_requests > 0);
  for (const [name, input] of [['observation-discoveries', query], ['observation-endpoints', endpointQuery], ['observation-candidates', { ...endpointQuery, endpoint: 1 }]]) {
    const response = await stack.request(base + '/' + name, post(input)); assert.equal(response.status, 429); assert.equal(response.value.error.code, 'observation_query_busy');
  }
  assert.equal((await pending).status, 504);
  assert.equal((await stack.request(base + '/observation-discoveries', post(query))).status, 200);
  const history = (await stats()).history, failed = history.lastIndexOf('interview');
  assert(history.slice(failed + 1, history.lastIndexOf('neighbors')).includes('sample'), '查询间先服务已到期的健康来源');
  await until(async () => (await sensor()).ready);
  await discovery('timeout');
  assert.equal((await stack.request(base + '/observation-discoveries', post(query))).status, 504);
  await discovery('wrong_coordinator');
  const changed = await stack.request(base + '/observation-discoveries', post(query));
  assert.equal(changed.status, 422); assert.equal(changed.value.error.code, 'znp_identity_changed');
  assert.equal((await sensor()).ready, false);
  await discovery('normal'); await until(async () => (await sensor()).ready);
  assert.deepEqual((await stats()).errors, []);
  await writeFile(path.join(directory, 'discovery-isolation-report.json'), JSON.stringify({ passed: true, shared_slot: true,
    due_polling_fairness: true, timeout_recovery: true, identity_failure_closes_group: true, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'discovery-isolation-report.json') }));
});

test('CLI发现核对请求上下文，坏输入零请求、错设备回执失败且不生成原请求日志', async t => {
  let requests = 0, input;
  const server = http.createServer(async (req, res) => {
    requests++; input = ''; for await (const chunk of req) input += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('observation-endpoints') ? { ...interviewed, ieee_address: targets[1] } : { ...discovered, coordinator_id: 'other' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { ...process.env, LIMEIOT_ENDPOINT: `http://127.0.0.1:${server.address().port}`, LIMEIOT_TOKEN: 'isolated-test-owner-token-value' }; delete env.LIMEIOT_TOKEN_FILE;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'limeiot-discovery-cli-'));
  for (const [operation, body, count, exit] of [
    ['observation-discoveries.query', '{"coordinator_id":"one","coordinator_id":"two"}', 0, 2],
    ['observation-discoveries.query', JSON.stringify(query), 1, 5], ['observation-endpoints.query', JSON.stringify(endpointQuery), 2, 5],
  ]) {
    const file = path.join(directory, 'query.json'); await writeFile(file, body);
    let result; try { result = await execute(process.execPath, ['packages/cli/src/main.mjs', 'invoke', operation, '--space-id', 'space', '--input', file], { env, timeout: 5000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, exit, result.stderr); assert.equal(requests, count);
    assert.equal(result.stdout, ''); assert.equal(result.stderr.includes('record_file'), false);
  }
  assert.deepEqual(JSON.parse(input), endpointQuery);
});
