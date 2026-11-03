import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startStack, freePort, until } from '../../tools/dev-stack.mjs';
export const base = '/api/v1/spaces/space-demo';
export const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(value) });
export const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), data.length + 8); return result; };
export function png(width = 1, height = 1, noise = false, animated = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = noise ? randomBytes((width * 3 + 1) * height) : Buffer.alloc((width * 3 + 1) * height, 50);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  const animation = Buffer.alloc(8), frame = Buffer.alloc(26); animation.writeUInt32BE(1); frame.writeUInt32BE(width, 4); frame.writeUInt32BE(height, 8); frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...(animated ? [chunk('acTL', animation), chunk('fcTL', frame)] : []), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
export const input = (bytes = png()) => ({ image_base64: bytes.toString('base64'), content_type: 'image/png', prompt: '请描述这张图片中的颜色和形状。', retain_seconds: 600, expires_at: new Date(Date.now() + 60000).toISOString() });
export async function visionStack(t, options = {}) {
  const calls = [], holds = [], errors = []; let mode = 'ok', directory;
  const text = '图片中有一个方块。仅凭这张图片无法确定其用途。';
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.url, '/api/chat'); assert.equal(req.headers.authorization, undefined);
      const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, 'fixture:vision'); assert.equal(body.stream, false); assert.equal(body.keep_alive, 0); assert.equal(body.tools, undefined);
      assert.deepEqual(body.options, { num_ctx: 4096, num_predict: 1024, temperature: 0 }); assert.equal(body.messages.length, 2); assert.equal(body.messages[1].role, 'user'); assert.equal(body.messages[1].images.length, 1);
      const bytes = Buffer.from(body.messages[1].images[0], 'base64'), digest = hash(bytes), promptDigest = hash(Buffer.from(body.messages[1].content));
      const raw = await readFile(path.join(directory, 'gateway.sqlite.media.json'), 'utf8'), disk = JSON.parse(raw);
      assert.equal(disk.schema_version, 4); assert.ok(Object.values(disk.visions).some(task => task.status === 'running' && task.input.image_digest === digest && task.input.prompt_digest === promptDigest));
      assert.equal(raw.includes(body.messages[1].content), false); assert.equal(raw.includes(body.messages[1].images[0]), false);
      calls.push({ byte_length: bytes.length, image_digest: digest, prompt_digest: promptDigest, durable_before_provider: true });
      const reply = { model: 'fixture:vision', done: true, done_reason: 'stop', message: { role: 'assistant', content: text } };
      const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); };
      if (mode === 'hold') holds.push(respond);
      else if (mode === 'lost') req.socket.destroy();
      else if (mode === 'redirect') { res.writeHead(302, { Location: '/never-follow' }); res.end(); }
      else if (mode === 'reject') { res.writeHead(422); res.end(); }
      else if (mode === 'oversize') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(' '.repeat(65537)); }
      else if (mode === 'duplicate') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"done":true,"done":false}'); }
      else { if (mode === 'tool') reply.message.tool_calls = [{ function: { name: 'commands.create', arguments: {} } }]; if (mode === 'truncated') reply.done_reason = 'length'; if (mode === 'invalid') reply.message.content = 'x'.repeat(2049); if (mode === 'model') reply.model = 'other:vision'; respond(); }
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const stack = await startStack({ ...options, gatewayEnv: { ...options.gatewayEnv, LIMEIOT_MEDIA_LISTEN: `127.0.0.1:${port}`, LIMEIOT_MEDIA_ORIGIN: origin, LIMEIOT_VISION_URL: `http://127.0.0.1:${provider.address().port}`, LIMEIOT_VISION_MODEL: 'fixture:vision', LIMEIOT_VISION_CA_FILE: '' } }); t.after(() => stack.close()); directory = stack.directory;
  const finish = key => until(async () => { const response = await stack.request(base + '/vision-observations/by-key/' + key); return response.status === 200 && response.value.status !== 'running' && response.value; });
  return { stack, directory, calls, holds, errors, text, finish, setMode(value) { mode = value; } };
}
