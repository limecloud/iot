import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, until } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
import { createMediaOriginal, validMediaOriginal, verifyMediaOperation, verifyMediaPage } from '../packages/protocol/media.mjs';

const exec = promisify(execFile), space = 'space-demo', base = '/api/v1/spaces/' + space;
const stateCheck = process.env.LIMEIOT_MEDIA_STATE_CHECK === '1';
const operation = (trace, type) => trace.records.find(record => record.original.change.type === type);
test('Swift/Kotlin共享媒体向量与正式JS合同一致', async () => {
  const vector = JSON.parse(await readFile(path.join(root, 'tests/fixtures/media/upload.json'), 'utf8'));
  assert.deepEqual(await createMediaOriginal('https://nas.local', space, 'original', vector.change), vector.original);
  assert.deepEqual(verifyMediaOperation(vector.operation, space, 'original', vector.original), vector.operation);
  verifyMediaPage(vector.page, space);
  for (const page of vector.invalid_pages) assert.throws(() => verifyMediaPage(page, space));
});

for (const target of ['ios', 'android']) test(target + (stateCheck ? '原生媒体状态层' : '原生媒体库') + '：真实上传丢回执、明确授权播放、进程/网关重启及撤销删除', { timeout: 240000 }, async t => {
  const { directory, bytes, fixture, stack, bindSpeaker, mediaPort } = await mediaStack(t, (stateCheck ? 'media-native-state-' : 'media-native-') + target + '-');
  await bindSpeaker();
  const binding = (await stack.request(base + '/devices/device-lamp/execution-binding')).value;
  const wavPath = path.join(directory, 'chime.wav'), storePath = path.join(directory, 'native-originals.json');
  await writeFile(wavPath, bytes, { mode: 0o600 });
  async function native(phase) {
    const tracePath = path.join(directory, phase + '-trace.json');
    const command = target === 'ios' ? stateCheck ? path.join(root, '.dev/media-native-state/ios-media-checks') : 'swift' : 'sh';
    const args = target === 'ios' ? stateCheck ? [] : ['run', 'ClientChecks'] : ['gradlew', '--no-daemon', '--configure-on-demand', stateCheck ? ':app:testDebugUnitTest' : ':core:test', '--tests', stateCheck ? 'run.limeai.iot.MediaControllerTest.originalRecoveryPlaybackAndProcessRestart' : 'run.limeai.iot.core.MediaIntegrationTest', '--rerun'];
    const env = { ...stack.env, LIMEIOT_MEDIA_CHECK: '1', LIMEIOT_MEDIA_PHASE: phase, LIMEIOT_MEDIA_BYTES: wavPath, LIMEIOT_MEDIA_STORE: storePath, LIMEIOT_MEDIA_TRACE: tracePath, LIMEIOT_MEDIA_BINDING: binding.revision };
    try {
      const result = await exec(command, args, { cwd: path.join(root, 'apps', target), env, timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
      await writeFile(path.join(directory, phase + '.log'), result.stdout + result.stderr);
    } catch (error) {
      await writeFile(path.join(directory, phase + '.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
      throw error;
    }
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    assert.equal(trace.passed, true); assert.equal(trace.phase, phase);
    if (stateCheck) assert.equal(trace.host_ui_state, true);
    assert.equal(trace.posts, phase === 'create' ? 2 : 3); assert.equal(trace.records.length, phase === 'create' ? 2 : 5);
    for (const record of trace.records) {
      assert.equal(validMediaOriginal(record.original, stack.env.LIMEIOT_ENDPOINT, space), true);
      verifyMediaOperation(record.result, space, record.original.idempotency_key, record.original);
    }
    const upload = operation(trace, 'media.upload');
    assert.deepEqual(upload.original, await createMediaOriginal(stack.env.LIMEIOT_ENDPOINT, space, upload.original.idempotency_key, { type: 'media.upload', content_base64: bytes.toString('base64'), retain_seconds: 600 }));
    const stored = await readFile(storePath, 'utf8');
    assert.equal(/content_base64|download_url|owner-input/.test(stored), false);
    assert.equal(stored.includes(stack.env.LIMEIOT_TOKEN), false); assert.equal((await stat(storePath)).mode & 0o777, 0o600);
    return trace;
  }
  const created = await native('create');
  assert.deepEqual(fixture.effects.map(e => e.action), ['SetVolume', 'SetAVTransportURI', 'Play']);
  assert.equal(fixture.proofs.every(proof => proof.command.status === 'dispatched'), true);
  assert.deepEqual(fixture.renderedPulls, [{ status: 206, byte_length: bytes.length }]);
  const granted = operation(created, 'media.grant').result.result;
  const snapshot = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
  const privateGrant = snapshot.grants[granted.grant_id].grant;
  // 仅隔离测试从私有快照核对旧地址；客户端回执没有下载凭证。
  const oldUrl = 'http://127.0.0.1:' + mediaPort + '/media/v1/' + privateGrant.grant_id + '/' + privateGrant.token + '.wav';
  await stack.restartGateway(); await until(async () => (await stack.request(base + '/devices/device-lamp')).value.ready);
  assert.equal((await fetch(oldUrl)).status, 404);
  const restored = await native('restore');
  assert.equal(operation(restored, 'media.grant').result.result.issued_in_process, false);
  assert.equal(fixture.effects.length, 3); assert.equal(fixture.renderedPulls.length, 1);
  const page = (await stack.request(base + '/media')).value;
  assert.equal(page.items.length, 1); assert.equal(page.items.every(i => !i.available), true); assert.equal(page.grants.every(g => !g.active_in_process), true);
  const commands = (await stack.request(base + '/commands')).value.items;
  assert.equal(commands.length, 1); assert.equal(commands[0].status, 'confirmed');
  const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
  assert.equal(Object.values(disk.objects).every(o => o.content_base64 === null), true);
  const report = { passed: true, target, native_host_library: true, host_ui_state: stateCheck, current_binding_target_lookup: stateCheck, real_http: true, real_sqlite: true, real_mqtt: true, native_process_restart: true, gateway_restart: true, upload_response_loss: true, same_key_get_only: true, digest_matches_js_and_rust: true, digest_only_originals: true, no_automatic_play: true, explicit_native_playback: true, soap_mutations: 3, media_range_pulls: 1, media_posts: 5, old_grant_no_reauthorization: true, revoke_delete_no_resurrection: true, native_media_ui: false, native_app_runtime: false, simulated_renderer: true, audible_output: false, hardware: false, hardware_status: '用户要求跳过', published: false, full_goal_completed: false };
  const resultPath = path.join(directory, 'media-native-result.json');
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: resultPath }));
});
