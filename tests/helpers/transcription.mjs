import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { until } from '../../tools/dev-stack.mjs';
import { mediaStack, pcmWav } from './media.mjs';
export const base = '/api/v1/spaces/space-demo';
export const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(value) });
export const input = media => ({ media_id: media.media_id, media_digest: media.content_digest, language: 'auto', expires_at: new Date(Date.now() + 60000).toISOString() });
export async function transcriptionStack(t, prefix = 'transcription-', options = {}) {
  const calls = [], holds = [], errors = []; let mode = 'ok', directory;
  const bytes = pcmWav(), text = '你好，这是本地识别结果。';
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.url, '/v1/audio/transcriptions'); assert.equal(req.headers['content-type'], 'audio/wav'); assert.equal(req.headers['x-limeiot-model'], 'fixture/asr'); assert.ok(['auto', 'zh', 'en'].includes(req.headers['x-limeiot-language'])); assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(Buffer.concat(chunks), bytes);
      const disk = JSON.parse(await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'));
      assert.equal(disk.schema_version, 3); assert.ok(Object.values(disk.transcriptions).some(task => task.status === 'running'));
      calls.push({ path: req.url, byte_length: bytes.length, language: req.headers['x-limeiot-language'], durable_before_provider: true });
      const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text })); };
      if (mode === 'hold') holds.push(respond);
      else if (mode === 'reject') { res.writeHead(422); res.end(); }
      else if (mode === 'lost') req.socket.destroy();
      else if (mode === 'redirect') { res.writeHead(302, { Location: '/never-follow' }); res.end(); }
      else if (mode === 'oversize') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(' '.repeat(32768)); res.end('x'); }
      else if (mode === 'duplicate') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"text":"a","text":"b"}'); }
      else if (mode === 'invalid') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'x'.repeat(2049) })); }
      else respond();
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const result = await mediaStack(t, prefix, { ...options, gatewayEnv: { ...options.gatewayEnv, LIMEIOT_ASR_URL: `http://127.0.0.1:${provider.address().port}`, LIMEIOT_ASR_MODEL: 'fixture/asr', LIMEIOT_ASR_CA_FILE: '' } });
  directory = result.directory;
  const uploaded = await result.stack.request(base + '/media-operations', post({ type: 'media.upload', content_base64: bytes.toString('base64'), retain_seconds: 600 }, 'source'));
  assert.equal(uploaded.status, 200);
  const media = uploaded.value.result.media;
  const finish = key => until(async () => { const task = (await result.stack.request(base + '/audio-transcriptions/by-key/' + key)).value; return task.status !== 'running' && task; });
  return { ...result, calls, holds, errors, media, text, finish, setMode(value) { mode = value; } };
}
