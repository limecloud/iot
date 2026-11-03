import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, startStack, until } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const base = '/api/v1/spaces/space-demo';
const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(await readFile(path.join(root, 'contracts/device-event.schema.json'), 'utf8')));

async function records(stack, cursor = 0) {
  const result = await stack.request(`${base}/events?after=${cursor}`);
  assert.equal(result.status, 200);
  return result.value.items;
}
const projections = items => items.filter(item => item.type === 'device.event' && item.payload.data !== null);
async function sqliteEvents(directory) {
  const query = 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps([json.loads(r[0]) for r in c.execute("SELECT data FROM events WHERE type=\'device.event\'")]))';
  return JSON.parse((await exec('python3', ['-c', query, path.join(directory, 'gateway.sqlite')])).stdout);
}
async function readStream(response, through) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items = [];
  let pending = '';
  try {
    while (true) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE ended before the sentinel');
      pending += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw) continue;
        const entry = JSON.parse(raw);
        items.push(entry);
        if (entry.type === 'device.event' && entry.payload.data?.event_id === through) return items;
      }
    }
  } finally { await reader.cancel(); }
}

test('设备事件经过真实MQTT/SQLite提交后投影，SSE一致且重启不重放', { timeout: 45000 }, async t => {
  const stack = await startStack();
  t.after(() => stack.close());
  const button = (await stack.request(`${base}/devices/device-button`)).value;
  const cursor = (await records(stack)).at(-1)?.event_id ?? 0;
  let sequence = button.last_seq + 1000;
  let occurred = new Date().toISOString();
  const event = (id, changes = {}) => ({
    v: 1, kind: 'event', message_id: 'projection-' + sequence, device_id: button.device_id,
    model_revision: button.model_revision, boot_id: button.boot_id, session_id: button.session_id, seq: sequence++,
    body: { event_id: id, path: 'button.pressed', occurred_at: occurred, historical: false, data: { count: 1 }, untrusted_extra: 'transport-secret-must-not-be-projected', ...changes },
  });
  const send = message => stack.button.stdin.write(JSON.stringify({ raw: message }) + '\n');
  const uncommitted = event('not-committed');

  // 锁只属于本次隔离SQLite，证明未提交的状态和投影均不可见。
  const locker = spawn('python3', ['-u', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("locked",flush=True); sys.stdin.read(1); c.rollback()', path.join(stack.directory, 'gateway.sqlite')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (locker.exitCode === null) locker.kill(); });
  await new Promise((resolve, reject) => {
    locker.stdout.once('data', value => value.toString().includes('locked') ? resolve() : reject(new Error('SQLite lock unavailable')));
    locker.once('error', reject);
    locker.once('exit', code => { if (code !== 0) reject(new Error('SQLite lock failed')); });
  });
  send(uncommitted);
  await until(async () => (await readFile(path.join(stack.directory, 'gateway.log'), 'utf8')).includes('"code":"storage_unavailable"'));
  const unlocked = new Promise(resolve => locker.once('exit', resolve));
  locker.stdin.end('x');
  await unlocked;
  // 先释放外部写锁，避免随后心跳的SQLite忙等待阻塞HTTP探测。
  assert.equal(projections(await records(stack, cursor)).length, 0);
  assert.equal((await sqliteEvents(stack.directory)).filter(item => item.data !== null).length, 0);
  occurred = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/Z$/, '+08:00');
  const first = event('projection-once');

  const stream = fetch(`${stack.env.LIMEIOT_ENDPOINT}${base}/events/stream`, {
    headers: { Authorization: `Bearer ${stack.env.LIMEIOT_TOKEN}`, 'Last-Event-ID': String(cursor) }, signal: AbortSignal.timeout(8000),
  });
  send(first);
  send({ ...first, seq: sequence++, message_id: 'duplicate-business-event' });
  send(first);
  const historical = event('not-live-history', { historical: true }); send(historical);
  const stale = event('not-live-stale', { occurred_at: new Date(Date.now() - 6000).toISOString() }); send(stale);
  const badSchema = event('not-live-schema', { data: { count: 0, private: 'invalid-schema-secret' } }); send(badSchema);
  const badSession = event('not-live-session'); badSession.session_id = 'wrong-session'; send(badSession);
  const badModel = event('not-live-model'); badModel.model_revision = 'sha256:' + '0'.repeat(64); send(badModel);
  send(event('not-live-future', { occurred_at: new Date(Date.now() + 5000).toISOString() }));
  send({ ...first, seq: sequence++, message_id: 'business-conflict', body: { ...first.body, data: { count: 2 } } });
  const sentinel = event('projection-sentinel', { data: { count: 2 } }); send(sentinel);
  const accepted = await until(async () => {
    const values = projections(await records(stack, cursor));
    return values.some(item => item.payload.data.event_id === 'projection-sentinel') && values;
  });
  assert.deepEqual(accepted.map(item => item.payload.data.event_id), ['projection-once', 'projection-sentinel']);
  for (const item of accepted) {
    assert(validate(item.payload.data), JSON.stringify(validate.errors));
    assert.equal(item.payload.data.device_id, button.device_id);
    assert.equal(item.payload.data.model_revision, button.model_revision);
    assert.equal(item.payload.data.boot_id, button.boot_id);
    assert.equal(item.payload.data.session_id, button.session_id);
    assert.equal(Date.parse(item.payload.data.occurred_at), Date.parse(occurred));
    assert.equal(item.payload.data.occurred_at, occurred);
    assert(Number.isFinite(Date.parse(item.payload.data.received_at)));
    assert(!JSON.stringify(item).includes('transport-secret-must-not-be-projected'));
  }
  const fromStream = projections(await readStream(await stream, 'projection-sentinel'));
  assert.deepEqual(fromStream, accepted);
  const committed = (await sqliteEvents(stack.directory)).filter(item => item.data !== null);
  assert.deepEqual(committed, accepted.map(item => item.payload));
  assert(!JSON.stringify(await records(stack, cursor)).includes('invalid-schema-secret'));
  const persistedCount = accepted.length;

  await stack.restartDevice('button');
  await stack.restartGateway();
  await until(async () => (await stack.request(base + '/devices')).value.items.every(item => item.ready));
  assert.deepEqual(projections(await records(stack, cursor)), accepted);
  const current = (await stack.request(`${base}/devices/device-button`)).value;
  send({ ...first, seq: current.last_seq + 1000, message_id: 'duplicate-after-restart', boot_id: current.boot_id, session_id: current.session_id });
  const after = { ...sentinel, seq: current.last_seq + 1001, message_id: 'after-restart', boot_id: current.boot_id, session_id: current.session_id, body: { ...sentinel.body, event_id: 'projection-after-restart', occurred_at: new Date().toISOString() } };
  send(after);
  await until(async () => projections(await records(stack, cursor)).some(item => item.payload.data.event_id === 'projection-after-restart'));
  assert.equal(projections(await records(stack, cursor)).length, persistedCount + 1);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  const result = { passed: true, real_http: true, real_mqtt: true, real_sqlite: true, strict_projection_schema: true, failed_commit_no_projection: true, sse_equals_committed_poll: true, invalid_stale_historical_no_projection: true, duplicate_no_replay: true, restart_readable: true, projected_business_events: persistedCount + 1, hardware: false };
  await writeFile(path.join(stack.directory, 'device-events-result.json'), JSON.stringify(result, null, 2) + '\n');
});
