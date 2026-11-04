import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mediaStack } from './media.mjs';
import { sameJSON } from '../../packages/protocol/products.mjs';
import { VoiceTurnClient } from '../../packages/protocol/voice-turns.mjs';
import { until } from '../../tools/dev-stack.mjs';
import { verifyPcmWav } from '../../packages/protocol/media.mjs';
import { createHash } from 'node:crypto';

export const base = '/api/v1/spaces/space-demo';
export const post = (input, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(input) });
export const transcript = '我想搭一个会说话的积木小狗。';
export const answer = '先搭一个稳固的底座，再给小狗装上灯和扬声器。';

export async function voiceStack(t, { recordedSource = false, homeDirectory, inspectText } = {}) {
  const calls = [], errors = [], holds = [], recordings = [], textRequests = []; let mode = 'ok', directory, audio;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks);
      const kind = req.url === '/v1/audio/transcriptions' ? 'transcription' : req.url === '/api/chat' ? 'text' : req.url === '/v1/audio/speech' ? 'speech' : null;
      assert.ok(kind);
      const raw = await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'), disk = JSON.parse(raw), field = { transcription: 'transcriptions', text: 'texts', speech: 'speech' }[kind];
      assert.ok(Object.values(disk[field]).some(value => value.status === 'running'));
      if (kind === 'transcription') {
        if (recordedSource) { const format = verifyPcmWav(bytes); assert.equal(format.sample_rate, 16000); assert.equal(format.channels, 1); assert.ok(format.frames > 0); recordings.push({ ...format, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
        else assert.deepEqual(bytes, audio);
      }
      if (kind === 'text') { const input = JSON.parse(bytes); assert.equal(input.model, 'fixture:text'); assert.equal(input.tools, undefined); assert.equal(input.messages.at(-1).content, transcript); assert.equal(raw.includes(transcript), true); if (inspectText) inspectText(input, textRequests.length); else assert.equal(input.messages.filter(value => value.role === 'user').length, 1); textRequests.push(input); }
      if (kind === 'speech') { const input = JSON.parse(bytes); assert.equal(input.model, 'fixture/tts'); assert.equal(input.input, mode === 'long' ? '字'.repeat(1001) : answer); assert.equal(input.voice, 'local'); }
      calls.push(kind);
      const respond = () => {
        const output = kind === 'transcription' ? { text: transcript } : kind === 'text' ? { model: 'fixture:text', done: true, done_reason: 'stop', message: { role: 'assistant', content: mode === 'long' ? '字'.repeat(1001) : answer }, prompt_eval_count: 25, eval_count: 8 } : audio;
        res.writeHead(200, { 'Content-Type': kind === 'speech' ? 'audio/wav' : 'application/json' }); res.end(Buffer.isBuffer(output) ? output : JSON.stringify(output));
      };
      if (mode === 'hold-' + kind) holds.push(respond); else respond();
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const env = { LIMEIOT_ASR_URL: origin, LIMEIOT_ASR_MODEL: 'fixture/asr', LIMEIOT_TEXT_URL: origin, LIMEIOT_TEXT_MODEL: 'fixture:text', LIMEIOT_TTS_URL: origin, LIMEIOT_TTS_MODEL: 'fixture/tts', LIMEIOT_TTS_VOICES: 'local', LIMEIOT_ASR_CA_FILE: '', LIMEIOT_TEXT_CA_FILE: '', LIMEIOT_TTS_CA_FILE: '' };
  if (homeDirectory) env.LIMEIOT_HOME_DIR = homeDirectory;
  const setup = await mediaStack(t, 'voice-turn-', { gatewayEnv: env }); directory = setup.directory; audio = setup.bytes;
  const media = (await setup.stack.request(base + '/media-operations', post({ type: 'media.upload', content_base64: audio.toString('base64'), retain_seconds: 600 }, 'voice-source'))).value.result.media;
  const memory = { raw: null, saves: 0, failAt: Infinity, pauseAt: Infinity, active: true };
  const journal = {
    async load() { return memory.raw; },
    async save(previous, next) {
      assert.ok(memory.raw === null ? previous === null : sameJSON(JSON.parse(memory.raw), previous));
      memory.saves++; if (memory.saves === memory.failAt) throw new Error('voice_turn_record_unavailable');
      memory.raw = JSON.stringify(next); if (memory.saves === memory.pauseAt) memory.active = false;
    },
  };
  const requests = []; let lose = null;
  const request = async (resource, input, key) => {
    requests.push({ resource, method: input === undefined ? 'GET' : 'POST', key });
    const result = await setup.stack.request(resource, input === undefined ? {} : post(input, key));
    if (lose && resource.endsWith('/' + lose) && input !== undefined) { lose = null; throw new Error('response_lost'); }
    if (result.status >= 400) throw Object.assign(new Error(result.value.error.code), { code: result.value.error.code, status: result.status, definitiveRejection: result.status < 500 && result.status !== 408 });
    return result.value;
  };
  const client = extra => new VoiceTurnClient({ origin: setup.stack.env.LIMEIOT_ENDPOINT, space: 'space-demo', journal, request, active: () => memory.active, ...extra });
  const input = turn_id => ({ turn_id, media_id: media.media_id, language: 'zh', voice: 'local' });
  async function complete(value) {
    return until(async () => { const next = await value.continue(); return ['succeeded', 'failed', 'unknown', 'stopped', 'expired'].includes(next.phase) && next; }, 20000);
  }
  return { ...setup, media, calls, errors, holds, recordings, textRequests, memory, journal, requests, request, client, input, complete, setMode(value) { mode = value; }, loseResponse(family) { lose = family; } };
}
