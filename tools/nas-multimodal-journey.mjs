import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, freePort, until } from './dev-stack.mjs';
import { pcmWav } from '../tests/helpers/media.mjs';
import { png, input as visionInput } from '../tests/helpers/vision.mjs';

const base = '/api/v1/spaces/space-demo';
const snapshot = 'data/gateway.sqlite.media.json';
const texts = { asr: '这是容器协议夹具的识别结果。', vision: '这是容器协议夹具的图片观察结果。' };
const routes = { speech: 'speech-syntheses', asr: 'audio-transcriptions', vision: 'vision-observations' };
const address = value => value.split('.').reduce((result, part) => result * 256 + Number(part), 0);

// 仅在本次Compose网络使用地址，避开Docker当前已分配的IPv4网段。
function unusedSubnet(cidrs) {
  const occupied = cidrs.filter(value => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(value)).map(value => {
    const [ip, bits] = value.split('/'), size = 2 ** (32 - Number(bits));
    const start = Math.floor(address(ip) / size) * size;
    return [start, start + size - 1];
  });
  const seed = randomInt(1, 255);
  for (let offset = 0; offset < 254; offset++) {
    const third = 1 + ((seed + offset - 1) % 254), prefix = `10.231.${third}`;
    const start = address(prefix + '.0');
    if (occupied.every(([low, high]) => start + 255 < low || start > high)) return prefix;
  }
  throw new Error('nas_verification_private_subnet_unavailable');
}

export async function prepareNasMultimodal({ state, image, manager, run }) {
  const ids = (await run('docker', ['network', 'ls', '--quiet'], null)).split(/\s+/).filter(Boolean);
  const networks = ids.length ? JSON.parse(await run('docker', ['network', 'inspect', ...ids], null)) : [];
  const prefix = unusedSubnet(networks.flatMap(network => (network.IPAM?.Config ?? []).map(config => config.Subnet ?? '')));
  const mediaPort = await freePort(), mediaOrigin = `http://${prefix}.2:${mediaPort}`;
  await run('python3', [manager, 'media-config', '--directory', state, '--media-origin', mediaOrigin], 'multimodal-initialize.log');
  const modelSource = await readFile(path.join(root, 'contracts/models/dlna-speaker.json'), 'utf8');
  const validated = JSON.parse(await run('docker', ['run', '--rm', '--interactive', '--network', 'none', '--read-only', '--memory', '32m', '--memory-swap', '32m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', '/usr/local/bin/limeiot-model-validator', image], null, { input: modelSource }));
  assert.equal(validated.valid, true); assert.ok(validated.normalized_model && validated.model_revision);
  const model = validated.normalized_model, modelRevision = validated.model_revision;
  const configuration = JSON.parse(await readFile(path.join(state, 'config/gateway.json'), 'utf8'));
  configuration.models.push(model);
  configuration.devices.push({ device_id: 'device-speaker', model_revision: modelRevision });
  await writeFile(path.join(state, 'config/gateway.json'), JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(path.join(state, 'config/audio.json'), JSON.stringify({ schema_version: 1, bindings: [{
    device_id: 'device-speaker', adapter_id: 'speaker-dlna', config: {
      schema_version: 1, target: `${prefix}.3:17883`, description_path: '/description.xml', av_transport_path: '/av', rendering_control_path: '/render',
      udn: 'uuid:nas-software-speaker', playback_volume: 10, volume_limit: 20, media: [], managed_media: true, timeout_ms: 5000,
    },
  }] }), { mode: 0o600 });
  return {
    modelRevision, mediaPort, mediaOrigin, modelValidatedInImage: true,
    environment: {
      LIMEIOT_MEDIA_BIND_HOST: '127.0.0.1',
      LIMEIOT_TTS_URL: 'http://multimodal:17883', LIMEIOT_TTS_MODEL: 'fixture/local-model', LIMEIOT_TTS_VOICES: 'local', LIMEIOT_TTS_CA_FILE: '',
      LIMEIOT_ASR_URL: 'http://multimodal:17883', LIMEIOT_ASR_MODEL: 'fixture/asr', LIMEIOT_ASR_CA_FILE: '',
      LIMEIOT_VISION_URL: 'http://multimodal:17883', LIMEIOT_VISION_MODEL: 'fixture:vision', LIMEIOT_VISION_CA_FILE: '',
    },
    overrides: {
      services: {
        gateway: { networks: { local: { ipv4_address: prefix + '.2' }, media: {} } },
        multimodal: {
          image, pull_policy: 'never', user: '${LIMEIOT_UID:?}:${LIMEIOT_GID:?}', entrypoint: ['python3', '/fixture/multimodal.py'], command: [],
          read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], mem_limit: '48m', memswap_limit: '48m',
          volumes: [{ type: 'bind', source: path.join(root, 'tests/fixtures/nas/multimodal.py'), target: '/fixture/multimodal.py', read_only: true }],
          networks: { local: { ipv4_address: prefix + '.3' } },
          healthcheck: { test: ['CMD', 'python3', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:17883/state",timeout=2).read()'], interval: '2s', timeout: '3s', retries: 20 },
        },
      },
      networks: { local: { internal: true, ipam: { config: [{ subnet: prefix + '.0/24' }] } } },
    },
  };
}

export function nasMultimodalJourney({ configuration, call, compose, directory, getState }) {
  const bytes = pcmWav(), image = png(512, 512, true), prompt = '请检查容器旅程中的图片颜色。';
  const report = { passed: false, provider_fixture: true, renderer_fixture: true, model_validated_in_image: configuration.modelValidatedInImage, real_model_quality: false, hardware: false };
  let completed, original, binding, pending, beforeBackupCalls, originalMediaURL;
  const provider = async (resource = '/state', input) => {
    const script = 'import json,sys,urllib.request\nbody=None if len(sys.argv)==2 else sys.argv[2].encode()\nreq=urllib.request.Request("http://127.0.0.1:17883"+sys.argv[1],data=body,headers={"Content-Type":"application/json"})\nprint(urllib.request.urlopen(req,timeout=5).read().decode())';
    return JSON.parse(await compose(['exec', '-T', 'multimodal', 'python3', '-c', script, resource, ...(input ? [JSON.stringify(input)] : [])], null));
  };
  const finish = (kind, key) => until(async () => {
    const response = await call(`${base}/${routes[kind]}/by-key/${key}`);
    return response.status === 200 && response.value.status !== 'running' && response.value;
  });
  const create = (kind, input, key) => call(`${base}/${routes[kind]}`, { input, key });
  async function oldGrantStatus() {
    const script = 'import sys,urllib.request,urllib.error\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}))\ntry:\n response=opener.open(sys.argv[1],timeout=5)\n print(response.status)\n response.close()\nexcept urllib.error.HTTPError as error:\n print(error.code)';
    return Number(await compose(['exec', '-T', 'multimodal', 'python3', '-c', script, originalMediaURL], null));
  }
  const freshSpeech = text => ({ text, voice: 'local', retain_seconds: 600, expires_at: new Date(Date.now() + 60000).toISOString() });
  const mediaOperation = (input, key) => call(base + '/media-operations', { input, key });
  async function play(media, key) {
    const response = await call(base + '/commands', { key, input: {
      device_id: 'device-speaker', model_revision: configuration.modelRevision, expires_at: new Date(Date.now() + 10000).toISOString(),
      operation: { type: 'action.invoke', path: 'playback.play', value: { media_id: media } },
    } });
    assert.equal(response.status, 202, JSON.stringify(response.value));
    const result = await until(async () => { const value = (await call(base + '/commands/' + response.value.command_id)).value; return value.status !== 'queued' && value.status !== 'dispatched' && value; });
    assert.equal(result.status, 'confirmed', JSON.stringify(result));
    return result.command_id;
  }
  async function grant(media, key) {
    const response = await mediaOperation({ type: 'media.grant', media_id: media, device_id: 'device-speaker', expected_binding_revision: binding.revision, valid_for_seconds: 300 }, key);
    assert.equal(response.status, 200); assert.equal(response.value.result.type, 'granted');
    return response.value.result.grant_id;
  }
  async function verifyResults() {
    for (const kind of Object.keys(routes)) {
      const result = await finish(kind, 'nas-' + kind);
      assert.deepEqual(result, completed[kind]);
    }
  }
  return {
    report,
    async begin() {
      const initialCommands = (await call(base + '/commands')).value.items.length;
      const uploaded = await mediaOperation({ type: 'media.upload', content_base64: bytes.toString('base64'), retain_seconds: 600 }, 'nas-source');
      assert.equal(uploaded.status, 200); const media = uploaded.value.result.media;
      original = {
        speech: freshSpeech('这段文字只用于容器语音协议验收。'),
        asr: { media_id: media.media_id, media_digest: media.content_digest, language: 'auto', expires_at: new Date(Date.now() + 60000).toISOString() },
        vision: { ...visionInput(image), prompt },
      };
      completed = {};
      for (const kind of Object.keys(routes)) {
        assert.equal((await create(kind, original[kind], 'nas-' + kind)).status, 202);
        completed[kind] = await finish(kind, 'nas-' + kind);
        assert.equal(completed[kind].status, 'succeeded', JSON.stringify(completed[kind]));
      }
      assert.equal(completed.asr.output.text, texts.asr); assert.equal(completed.vision.output.text, texts.vision);
      assert.equal((await call(base + '/media')).value.grants.length, 0);
      assert.equal((await call(base + '/commands')).value.items.length, initialCommands);
      const offers = (await call(base + '/execution-adapters')).value.items;
      const initial = (await call(base + '/devices/device-speaker/execution-binding')).value;
      const bound = await call(base + '/execution-operations', { key: 'nas-bind-speaker', input: {
        type: 'bindings.bind', device_id: 'device-speaker', expected_binding_revision: initial.revision,
        expected_model_revision: configuration.modelRevision, route: offers.find(item => item.route.adapter_id === 'speaker-dlna').route,
      } });
      assert.equal(bound.value.status, 'applied', JSON.stringify(bound.value)); binding = bound.value.result;
      await until(async () => (await call(base + '/devices/device-speaker')).value.ready);
      const grantID = await grant(completed.speech.media_id, 'nas-speech-grant');
      const disk = JSON.parse(await readFile(path.join(getState(), snapshot), 'utf8'));
      originalMediaURL = `${configuration.mediaOrigin}/media/v1/${grantID}/${disk.grants[grantID].grant.token}.wav`;
      report.play_command = await play(completed.speech.media_id, 'nas-speech-play');
      report.grant_id = grantID;
      const state = await provider(); assert.deepEqual(state.errors, []); assert.equal(state.calls.length, 3);
      assert.deepEqual(state.effects, ['SetVolume', 'SetAVTransportURI', 'Play']); assert.equal(state.pulls[0].bytes, bytes.length);
      assert.equal(state.calls.find(call => call.kind === 'vision').bytes, image.length);
      report.image_bytes = image.length; report.image_json_bytes = Buffer.byteLength(JSON.stringify(original.vision));
      assert.ok(report.image_json_bytes > 512 * 1024);
      assert.equal((await call(base + '/commands', { input: { padding: 'x'.repeat(17000) }, key: 'nas-small-route-limit' })).status, 413);
      assert.equal((await call(base + '/vision-observations', { input: { padding: 'x'.repeat(2804397) }, key: 'nas-large-route-limit' })).status, 413);
      report.no_implicit_grant_or_play = true; report.explicit_play_range_bytes_verified = true;
      report.source_media_id = media.media_id;
    },
    async afterRecreate() {
      await verifyResults();
      const page = (await call(base + '/media')).value;
      assert.equal(page.grants.find(grant => grant.grant_id === report.grant_id).active_in_process, false);
      assert.equal(await oldGrantStatus(), 404);
      const state = await provider(); assert.deepEqual(state.errors, []); assert.equal(state.calls.length, 3); assert.equal(state.effects.length, 3);
      report.recreation_no_inference_or_play = true;
    },
    async beforeBackup() {
      await verifyResults();
      pending = { speech: freshSpeech('该任务在备份时保持运行。'), asr: { ...original.asr, expires_at: new Date(Date.now() + 60000).toISOString() }, vision: { ...original.vision, expires_at: new Date(Date.now() + 60000).toISOString() } };
      for (const kind of Object.keys(routes)) {
        await provider('/fixture/mode', { kind, mode: 'hold' });
        assert.equal((await create(kind, pending[kind], 'nas-pending-' + kind)).status, 202);
      }
      const state = await until(async () => { const state = await provider(); return state.calls.length === 6 && state; });
      assert.deepEqual(state.errors, []); beforeBackupCalls = state.calls;
      const raw = await readFile(path.join(getState(), snapshot), 'utf8'), disk = JSON.parse(raw);
      assert.equal(disk.schema_version, 4);
      for (const [kind, field] of [['speech', 'speech'], ['asr', 'transcriptions'], ['vision', 'visions']]) assert.equal(disk[field]['nas-pending-' + kind].status, 'running');
      for (const value of [original.speech.text, pending.speech.text, prompt, original.vision.image_base64]) assert.equal(raw.includes(value), false);
      report.backup_snapshot_bytes = Buffer.byteLength(raw);
      return Buffer.from(raw);
    },
    async afterRestore() {
      await verifyResults();
      for (const kind of Object.keys(routes)) {
        assert.equal((await finish(kind, 'nas-pending-' + kind)).status, 'unknown');
        const input = { ...pending[kind], expires_at: new Date(Date.now() + 60000).toISOString() };
        assert.equal((await create(kind, input, 'nas-blocked-' + kind)).status, 429);
        assert.equal((await call(`${base}/${routes[kind]}/by-key/nas-blocked-${kind}`)).status, 404);
      }
      let state = await provider(); assert.deepEqual(state.calls, []); assert.deepEqual(state.effects, []); assert.deepEqual(state.errors, []);
      const page = (await call(base + '/media')).value;
      assert.equal(page.grants.find(grant => grant.grant_id === report.grant_id).active_in_process, false);
      assert.equal(await oldGrantStatus(), 404); report.old_grant_url_denied_after_restore = true;
      await grant(completed.speech.media_id, 'nas-restored-grant');
      report.restored_play_command = await play(completed.speech.media_id, 'nas-restored-play');
      state = await provider(); assert.equal(state.calls.length, 0); assert.equal(state.pulls[0].bytes, bytes.length); assert.equal(state.effects.length, 3);
      for (const kind of Object.keys(routes)) assert.equal((await call(`${base}/${routes[kind]}/by-key/nas-pending-${kind}/discard`, { input: {} })).value.status, 'discarded');
      for (const kind of ['asr', 'vision']) assert.equal((await call(`${base}/${routes[kind]}/by-key/nas-${kind}/discard`, { input: {} })).status, 200);
      for (const media of [report.source_media_id, completed.speech.media_id]) assert.equal((await mediaOperation({ type: 'media.delete', media_id: media }, 'nas-delete-' + media)).status, 200);
      report.pending_restored_unknown_without_resubmit = true; report.unknown_retains_budget = true;
      report.provider_calls_before_backup = beforeBackupCalls; report.provider_calls_after_restore = state.calls.length;
      report.restored_audio_range_bytes_verified = true;
    },
    async afterClearRestart() {
      for (const kind of Object.keys(routes)) assert.equal((await finish(kind, 'nas-pending-' + kind)).status, 'discarded');
      for (const kind of ['asr', 'vision']) assert.equal((await finish(kind, 'nas-' + kind)).output.text, null);
      const page = (await call(base + '/media')).value;
      for (const media of [report.source_media_id, completed.speech.media_id]) assert.equal(page.items.find(item => item.metadata.media_id === media).available, false);
      const state = await provider(); assert.equal(state.calls.length, 0); assert.equal(state.effects.length, 3); assert.deepEqual(state.errors, []);
      const raw = await readFile(path.join(getState(), snapshot), 'utf8');
      assert.equal(raw.includes(texts.asr), false); assert.equal(raw.includes(texts.vision), false);
      assert.equal((await stat(path.join(getState(), snapshot))).mode & 0o777, 0o600);
      report.clear_and_delete_survive_restart = true; report.snapshot_private = true; report.passed = true;
      await writeFile(path.join(directory, 'multimodal-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    },
  };
}
