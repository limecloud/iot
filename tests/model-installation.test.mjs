import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { root, startStack, stop, until } from '../tools/dev-stack.mjs';
import { verifyModelOperation } from '../packages/protocol/model-registry.mjs';

const exec = promisify(execFile), prefix = '/api/v1/spaces/space-demo';
const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });

async function publication() {
  if (!process.env.LIMEIOT_TEST_CONTROL_ORIGIN) return { ...JSON.parse(await readFile(path.join(root, 'contracts/examples/model-release.json'), 'utf8')), source: 'public-test-vector' };
  const { cloudClient, origin } = await import('./helpers/control.mjs');
  const cloud = await cloudClient(), publisher = await cloud.call('/api/console/v1/publisher');
  const model = JSON.parse(await readFile(path.join(root, 'contracts/models/lamp.json'), 'utf8'));
  model.model_id = `urn:${publisher.namespace}:model:gateway-installation:1`;
  const product = (await cloud.call('/api/console/v1/products', { request_key: 'gateway-installation-product', name: '本地安装环境灯', model })).product;
  const resource = '/api/console/v1/products/' + product.product_id;
  const first = await cloud.call(resource + '/releases', { request_key: 'gateway-installation-first', expected_revision: product.revision, expected_release_id: null, visibility: 'public' });
  assert.equal(first.status, 'published');
  const downloaded = await (await fetch(origin + '/api/catalog/v1/model-releases/' + first.release.artifact.statement.release_id)).json();
  assert.deepEqual(downloaded, first.release);
  model.model_version = '1.0.1';
  const saved = await cloud.call(resource + '/drafts', { request_key: 'gateway-installation-v2-draft', expected_revision: product.revision, name: product.name, model });
  const next = await cloud.call(resource + '/releases', { request_key: 'gateway-installation-next', expected_revision: saved.product.revision, expected_release_id: first.release.artifact.statement.release_id, visibility: 'public' });
  assert.equal(next.status, 'published');
  return { trust: publisher.trust, artifact: downloaded.artifact, upgrade: next.release.artifact, source: 'real-control-publication' };
}

test('签名模型进入真实本地链路：明确指纹、CLI安装、设备握手、升级、撤销与SQLite恢复', { timeout: 90000 }, async t => {
  const source = await publication(), stack = await startStack(); t.after(() => stack.close());
  const input = path.join(stack.directory, 'model-change.json'), state = path.join(stack.directory, 'cli-state');
  async function cli(args, code = 0) {
    let result; try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', ...args, '--space-id', 'space-demo', '--state-dir', state], { cwd: root, env: stack.env, timeout: 16000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, code, result.stderr); return result;
  }
  async function change(value, key, code = 0) {
    await writeFile(input, JSON.stringify(value));
    const result = JSON.parse((await cli(['invoke', 'model-changes.create', '--input', input, '--idempotency-key', key], code)).stdout);
    const { cli: original, ...operation } = result;
    await verifyModelOperation(operation, { space_id: 'space-demo', idempotency_key: key, change: value });
    assert.equal((await stat(original.record_file)).mode & 0o777, 0o600);
    return operation;
  }
  const apply = async (value, key) => (await stack.request(prefix + '/model-operations', post(value, key))).value;
  const counts = async () => (await stack.request(prefix + '/events?after=0')).value.items.filter(value => value.type === 'model.operation').length;
  const before = await counts();
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + prefix + '/model-operations', post({ type: 'trust.add' }, 'unauthorized'))).status, 401);
  assert.equal((await stack.request('/api/v1/spaces/other/model-trusts')).status, 403);
  const duplicate = await stack.request(prefix + '/model-operations', { ...post({}, 'duplicate'), body: '{"type":"trust.revoke","trust_id":"one","trust_id":"two","expected_revision":"x"}' });
  assert.equal(duplicate.status, 422);
  const omitted = await apply({ type: 'models.install', trust_id: 'trust', artifact: {} }, 'omitted'); assert.equal(omitted.error.code, 'invalid_model_change');
  assert.equal(await counts(), before);
  const confirmedTrust = { type: 'trust.add', trust: source.trust, expected_signing_key_id: source.trust.signing_key_id };
  const trustOperation = await change(confirmedTrust, 'local-publisher-trust'); const trusted = trustOperation.result.value;
  assert.equal((await change(confirmedTrust, 'local-publisher-trust')).operation_id, trustOperation.operation_id);
  assert.equal((await stack.request(prefix + '/model-trusts')).value.items.length, 1);
  const deviceBefore = (await stack.request(prefix + '/devices/device-lamp')).value;
  const installInput = { type: 'models.install', trust_id: trusted.trust_id, artifact: source.artifact, expected_release_id: null };
  const installation = (await change(installInput, 'local-installation')).result.value;
  assert.equal((await stack.request(prefix + '/devices/device-lamp')).value.model_revision, deviceBefore.model_revision);
  assert.equal((await stack.request(prefix + '/model-installations')).value.heads[source.artifact.statement.model.model_id], installation.installation_id);
  await change({ ...installInput, artifact: { ...source.artifact, signature: 'invalid' } }, 'invalid-signature', 7);
  const bindInput = { type: 'devices.bind', device_id: 'device-lamp', installation_id: installation.installation_id, expected_model_revision: deviceBefore.model_revision, expected_binding_revision: null };
  const bound = (await change(bindInput, 'local-device-binding')).result.value;
  assert.equal((await stack.request(prefix + '/devices/device-lamp')).value.ready, false);
  async function simulator(artifact, name) {
    await stop(stack.lamp);
    const modelFile = path.join(stack.directory, name + '-model.json'); await writeFile(modelFile, JSON.stringify(artifact.statement.model));
    stack.lamp = stack.launch(name, path.join(root, 'target/debug/limeiot-simulator'), ['device-lamp', modelFile, path.join(stack.directory, name + '-state.json')]);
    return until(async () => { const value = (await stack.request(prefix + '/devices/device-lamp')).value; return value.ready && value.model_revision === artifact.statement.model_revision && value; });
  }
  const live = await simulator(source.artifact, 'signed-lamp');
  const commandInput = { device_id: 'device-lamp', model_revision: live.model_revision, expires_at: new Date(Date.now() + 10000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } };
  const sent = (await stack.request(prefix + '/commands', post(commandInput, 'installed-command'))).value;
  const completed = await until(async () => { const value = (await stack.request(prefix + '/commands/' + sent.command_id)).value; return value.status === 'confirmed' && value; });
  assert.equal(completed.evidence.type, 'device_result');
  const upgraded = (await change({ ...installInput, artifact: source.upgrade, expected_release_id: source.artifact.statement.release_id }, 'local-upgrade')).result.value;
  assert.equal((await stack.request(prefix + '/devices/device-lamp')).value.model_revision, live.model_revision);
  await change({ ...bindInput, installation_id: upgraded.installation_id }, 'stale-binding', 4);
  await change({ ...bindInput, installation_id: upgraded.installation_id, expected_model_revision: live.model_revision, expected_binding_revision: bound.revision }, 'upgrade-binding');
  await simulator(source.upgrade, 'upgraded-lamp');
  await change({ type: 'trust.revoke', trust_id: trusted.trust_id, expected_revision: trusted.revision }, 'local-revoke');
  assert.equal((await stack.request(prefix + '/devices/device-lamp')).value.ready, false);
  const revokedCommand = await stack.request(prefix + '/commands', post({ ...commandInput, model_revision: source.upgrade.statement.model_revision, expires_at: new Date(Date.now() + 5000).toISOString() }, 'after-revoke'));
  assert.equal(revokedCommand.value.error.code, 'model_trust_revoked');
  assert.equal((await stack.request(prefix + '/commands/' + sent.command_id)).value.status, 'confirmed');
  await stack.restartGateway();
  assert.equal((await stack.request(prefix + '/model-trusts/' + trusted.trust_id)).value.active, false);
  assert.equal((await stack.request(prefix + '/devices/device-lamp')).value.ready, false);
  assert.equal((await change(installInput, 'local-installation')).result.value.installation_id, installation.installation_id);
  assert.equal((await stack.request(prefix + '/model-installations')).value.heads[source.artifact.statement.model.model_id], upgraded.installation_id);
  assert.equal((await change(confirmedTrust, 'local-publisher-trust')).operation_id, trustOperation.operation_id);
  assert.equal((await stack.request(prefix + '/model-trusts/' + trusted.trust_id)).value.active, false);
  await change(confirmedTrust, 'no-reactivation', 7);
  const cliRead = JSON.parse((await cli(['device-models', 'get', 'device-lamp'])).stdout); assert.equal(cliRead.trust_active, false);
  await writeFile(path.join(stack.directory, 'model-installation-result.json'), JSON.stringify({ passed: true, source: source.source, real_mqtt: true, cli: true, sqlite_restart: true, explicit_trust: true, no_automatic_device_switch: true, revoked_trust_blocks_control: true, hardware: false }));
});
