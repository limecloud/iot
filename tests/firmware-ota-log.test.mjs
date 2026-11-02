import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJSON, documentDigest } from '../packages/protocol/model-validation.mjs';

const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
const now = Date.parse('2026-11-02T00:00:00Z');
const baseline = { firmware_version: '0.1.0', security_epoch: 0, image_sha256: 'sha256:' + 'b'.repeat(64) };
const code = { ok: 0, ignored: 1, invalid: 2, expired: 4, conflict: 5, storage: 6, capacity: 8, clock: 10 };
async function envelope(index = 1, change = () => {}) {
  const request = { v: 1, kind: 'ota_install', message_id: 'install-' + index, device_id: 'device-lamp',
    model_revision: fixture.request.device.model_revision, boot_id: 'boot-1', session_id: 'session-1',
    body: { task_id: 'ota-task-' + index, execution_id: 'execution-' + index, manifest_digest: '',
      manifest: structuredClone(fixture.request.manifest), expires_at: '2026-11-03T00:00:00.123456789Z' } };
  change(request); request.body.manifest_digest = await documentDigest(request.body.manifest); return request;
}
const prepare = (request, options = {}) => ({ op: 'prepare', request, baseline, ...options });
const get = (index = 1, options = {}) => ({ op: 'get', execution_id: 'execution-' + index, ...options });
const advance = (stage, index = 1, options = {}) => ({ op: 'advance', execution_id: 'execution-' + index, stage, ...options });
function result(stage = 'succeeded') {
  const target = fixture.request.manifest.statement;
  return { ...(stage === 'succeeded' ? { firmware_version: target.version, security_epoch: target.security_epoch, image_sha256: target.sha256 } : baseline),
    boot_id: stage === 'succeeded' || stage === 'rolled_back' ? 'boot-2' : 'boot-1', pending_update: false,
    error: stage === 'succeeded' ? '' : stage === 'rolled_back' ? 'boot_rollback' : 'download_failed' };
}
const finish = (stage = 'succeeded', index = 1, options = {}) => ({ op: 'finish', execution_id: 'execution-' + index, stage, outcome: result(stage), ...options });
async function workspace(run) {
  const dir = path.join(root, '.dev', 'ota-log-' + crypto.randomUUID()); await mkdir(dir); await run(dir);
}
async function invoke(dir, steps = [], options = {}) {
  const plan = path.join(dir, 'plan-' + crypto.randomUUID() + '.json'), state = path.join(dir, options.state ?? 'state.json');
  await writeFile(plan, JSON.stringify({ now, space_id: 'space-home', device_id: 'device-lamp', ...options, steps }));
  const output = await exec(path.join(root, '.dev/firmware-host/ota-log'), [plan, state], { cwd: root, timeout: 5000 });
  assert.equal(output.stderr, '', output.stderr); return JSON.parse(output.stdout);
}
function codes(output, expected) {
  assert.equal(output.opened, true); assert.equal(output.open_error, code.ok);
  assert.deepEqual(output.results.map(v => v.code), expected.map(v => code[v]), JSON.stringify(output));
  return output.results;
}
async function snapshot(dir, filename = 'state.json') {
  const value = JSON.parse(await readFile(path.join(dir, filename), 'utf8')), { checksum, ...unsigned } = value;
  assert.equal(checksum, await documentDigest(unsigned)); return value;
}

test('OTA原Envelope先耐久保存，JCS摘要与Node一致，重复请求只读且异参冲突', async () => workspace(async dir => {
  const request = await envelope(), reordered = Object.fromEntries(Object.entries(request).reverse());
  const changed = structuredClone(request); changed.message_id = 'other-message';
  const rows = codes(await invoke(dir, [prepare(request), get(), prepare(reordered, { trusted: false }),
    prepare(changed), get(99), get()]), ['ok', 'ok', 'ignored', 'conflict', 'ignored', 'ok']);
  assert.equal(rows[0].durable_writes, 1); assert.equal(rows[0].blocked, true);
  assert.equal(rows[1].view.request_digest, await documentDigest(request));
  assert.equal(rows[1].view.manifest_digest, request.body.manifest_digest);
  assert.equal(rows[1].view.original_raw, canonicalJSON(request));
  assert.deepEqual(rows[1].view.original, request); assert.equal(rows[1].view.expires_ms, Date.parse(request.body.expires_at));
  for (const row of rows.slice(1)) { assert.equal(row.writes, 1); assert.equal(row.clock_reads, 1); }
  assert.equal(rows[4].cleared, true); assert.equal(rows[5].view.stage, 'intent');
  const saved = await snapshot(dir); assert.equal(saved.version, 2); assert.equal(saved.records.length, 1);
  assert.deepEqual(saved.records[0].request, request); assert.deepEqual(saved.records[0].baseline, baseline);
}));

test('OTA每个非终态跨真实进程恢复均冻结，原请求只读，不因过期重新安装', async () => workspace(async dir => {
  const request = await envelope(), other = await envelope(2);
  for (const stage of ['intent', 'installing', 'awaiting_boot']) {
    const options = { state: stage + '.json' };
    const steps = [prepare(request), ...(stage !== 'intent' ? [advance('installing')] : []), ...(stage === 'awaiting_boot' ? [advance('awaiting_boot')] : [])];
    codes(await invoke(dir, steps, options), steps.map(() => 'ok'));
    const rows = codes(await invoke(dir, [get(), advance(stage === 'intent' ? 'installing' : 'awaiting_boot'),
      prepare(request, { trusted: false }), prepare(other), get()], { ...options, now: now + 7 * 86400000 }), ['ok', 'conflict', 'ignored', 'conflict', 'ok']);
    assert.equal(rows[0].view.stage, stage); assert.equal(rows[0].view.recovered, true);
    for (const row of rows) { assert.equal(row.writes, 0); assert.equal(row.clock_reads, 0); }
    const completed = codes(await invoke(dir, [finish(), get()], options), [stage === 'intent' ? 'conflict' : 'ok', 'ok']);
    assert.equal(completed[1].view.stage, stage === 'intent' ? 'intent' : 'succeeded');
  }
}));

test('OTA状态单调，安装开始重检可信毫秒期限，查询和已开始后的记录不依赖时钟', async () => workspace(async dir => {
  const request = await envelope(1, r => { r.body.expires_at = '2026-11-02T00:00:00.123456789Z'; });
  const rows = codes(await invoke(dir, [prepare(request, { trusted: false }), prepare(request, { trusted: true, now: now + 123 }),
    prepare(request, { now: now + 122 }), advance('awaiting_boot'), advance('installing', 1, { trusted: false }),
    advance('installing', 1, { trusted: true, now: now + 123 }), advance('installing', 1, { now: now + 122 }),
    advance('installing'), advance('awaiting_boot', 1, { trusted: false, now: now + 10000 }), get(), finish(), advance('installing')]),
  ['clock', 'expired', 'ok', 'conflict', 'clock', 'expired', 'ok', 'conflict', 'ok', 'ok', 'ok', 'conflict']);
  assert.equal(rows[2].durable_writes, 1); assert.equal(rows[6].durable_writes, 2);
  assert.equal(rows[8].clock_reads, rows[6].clock_reads); assert.equal(rows[10].blocked, false);
  assert.equal(rows[11].durable_writes, 4);
}));

test('OTA成功必须有新boot及精确本机目标证据，终态重复只读且不可改写', async () => workspace(async dir => {
  const request = await envelope(), invalid = [
    { boot_id: 'boot-1' }, { pending_update: true }, { firmware_version: '0.3.0' }, { security_epoch: 0 },
    { image_sha256: baseline.image_sha256 }, { error: 'failed' }, { boot_id: 'bad.boot' }, { firmware_version: 'x'.repeat(33) },
  ];
  const steps = [prepare(request), finish(), advance('installing'), ...invalid.map(change => finish('succeeded', 1, { outcome: { ...result(), ...change } })),
    finish('rejected'), finish(), get(), finish(), finish('failed'), get()];
  const rows = codes(await invoke(dir, steps), ['ok', 'conflict', 'ok', ...invalid.map(() => 'invalid'), 'conflict', 'ok', 'ok', 'ignored', 'conflict', 'ok']);
  assert.equal(rows.at(-1).view.stage, 'succeeded'); assert.deepEqual(rows.at(-1).view.outcome, result());
  assert.equal(rows.at(-1).writes, 3); assert.equal(rows.at(-1).blocked, false);
  const recovered = codes(await invoke(dir, [get(), finish(), advance('awaiting_boot')]), ['ok', 'ignored', 'conflict']);
  assert.equal(recovered[0].view.recovered, false); assert.equal(recovered[2].writes, 0);
}));

test('OTA拒绝/失败/回滚绑定原基线，回滚须新boot，intent不能报告成功或回滚', async () => workspace(async dir => {
  const request = await envelope();
  for (const stage of ['rejected', 'failed', 'rolled_back']) {
    const start = stage === 'rejected' ? [] : [advance('installing'), advance('awaiting_boot')];
    const bad = [{ firmware_version: '0.2.0' }, { security_epoch: 1 }, { image_sha256: result().image_sha256 },
      { error: '' }, { error: 'Bad-Error' }, { error: 'x'.repeat(65) }, ...(stage === 'rolled_back' ? [{ boot_id: 'boot-1' }] : [])];
    const steps = [prepare(request), ...start, ...bad.map(change => finish(stage, 1, { outcome: { ...result(stage), ...change } })), finish(stage), get(), finish(stage)];
    const rows = codes(await invoke(dir, steps, { state: stage + '.json' }), ['ok', ...start.map(() => 'ok'), ...bad.map(() => 'invalid'), 'ok', 'ok', 'ignored']);
    assert.equal(rows.at(-2).view.stage, stage); assert.equal(rows.at(-1).writes, start.length + 2);
    const restored = codes(await invoke(dir, [get()], { state: stage + '.json' }), ['ok']);
    assert.equal(restored[0].view.stage, stage); assert.equal(restored[0].writes, 0);
  }
  codes(await invoke(dir, [prepare(request), finish('rolled_back'), get()], { state: 'intent-rollback.json' }), ['ok', 'conflict', 'ok']);
}));

test('OTA提交前失败及耐久提交后报错均冻结对象，重开仅以实际文件为准', async () => workspace(async dir => {
  const request = await envelope();
  for (const fault of ['before', 'after']) for (const operation of ['prepare', 'advance', 'finish']) {
    const options = { state: fault + '-' + operation + '.json' };
    const prefix = operation === 'prepare' ? [] : [prepare(request), ...(operation === 'finish' ? [advance('installing')] : [])];
    const mutation = operation === 'prepare' ? prepare(request, { fault }) : operation === 'advance' ? advance('installing', 1, { fault }) : finish('succeeded', 1, { fault });
    const rows = codes(await invoke(dir, [...prefix, mutation, get(), advance('installing'), prepare(request)] , options),
      [...prefix.map(() => 'ok'), 'storage', 'storage', 'storage', 'storage']);
    const failure = rows[prefix.length]; assert.equal(failure.blocked, true);
    assert.equal(failure.writes, prefix.length + 1); assert.equal(failure.durable_writes, prefix.length + (fault === 'after' ? 1 : 0));
    assert.equal(rows[prefix.length + 1].cleared, true); assert.equal(rows.at(-1).writes, failure.writes);
    const absent = operation === 'prepare' && fault === 'before';
    const recovered = codes(await invoke(dir, [get(), advance('installing')], options), [absent ? 'ignored' : 'ok', absent ? 'ignored' : 'conflict']);
    if (!absent) {
      const expected = fault === 'before' ? operation === 'advance' ? 'intent' : 'installing' : operation === 'prepare' ? 'intent' : operation === 'advance' ? 'installing' : 'succeeded';
      assert.equal(recovered[0].view.stage, expected); assert.equal(recovered[0].view.recovered, expected !== 'succeeded');
      await snapshot(dir, options.state);
    }
  }
}));

test('OTA保留4条未过期终态，过期终态可回收，过期未决仍占用', async () => workspace(async dir => {
  const requests = await Promise.all([1, 2, 3, 4, 5].map(i => envelope(i)));
  const steps = requests.slice(0, 4).flatMap((r, i) => [prepare(r), finish('rejected', i + 1)]);
  const rows = codes(await invoke(dir, [...steps, prepare(requests[4]), get(1)]), [...steps.map(() => 'ok'), 'capacity', 'ok']);
  assert.equal(rows.at(-1).writes, 8); assert.equal((await snapshot(dir)).records.length, 4);
  const after = Date.parse(requests[0].body.expires_at) + 1, newer = await envelope(5, r => { r.body.expires_at = '2026-11-04T00:00:00Z'; });
  const reclaimed = codes(await invoke(dir, [prepare(newer), get(1), get(2), get(5), prepare(requests[0])], { now: after }), ['ok', 'ignored', 'ok', 'ok', 'conflict']);
  assert.equal(reclaimed[1].cleared, true); assert.equal((await snapshot(dir)).records.length, 4);
  const pending = codes(await invoke(dir, [prepare(requests[0]), prepare(newer, { now: after }), get()], { state: 'pending.json' }), ['ok', 'conflict', 'ok']);
  assert.equal(pending[2].view.stage, 'intent'); assert.equal(pending[2].writes, 1);
}));

test('OTA旧终态重复请求不受更早槽位的新未决记录影响', async () => workspace(async dir => {
  const first = await envelope(1, r => { r.body.expires_at = '2026-11-02T00:00:01Z'; });
  const second = await envelope(2), third = await envelope(3);
  const rows = codes(await invoke(dir, [prepare(first), finish('rejected'), prepare(second), finish('rejected', 2),
    prepare(third, { now: now + 1001 }), prepare(second, { trusted: false }), get(2)]), ['ok', 'ok', 'ok', 'ok', 'ok', 'ignored', 'ok']);
  assert.equal(rows.at(-1).view.stage, 'rejected'); assert.equal(rows.at(-1).writes, 5);
}));

test('OTA恢复拒绝损坏、未知版本、跨owner和重复ID，保持原文件不改写', async () => workspace(async dir => {
  const request = await envelope(); codes(await invoke(dir, [prepare(request), finish('rejected')]), ['ok', 'ok']);
  const saved = await snapshot(dir), changes = [
    v => { v.version = 3; }, v => { v.space_id = 'other-space'; }, v => { v.device_id = 'other-device'; },
    v => { v.records.push(structuredClone(v.records[0])); }, v => { v.records[0].stage = 'unknown'; },
    v => { v.records[0].outcome.image_sha256 = result().image_sha256; }, v => { v.records[0].request.body.manifest_digest = baseline.image_sha256; },
    v => { v.records[0].baseline.extra = true; }, v => { v.records[0].outcome.pending_update = true; },
    v => { const duplicate = structuredClone(v.records[0]); duplicate.request.body.execution_id = 'other-execution'; v.records.push(duplicate); },
    v => { const duplicate = structuredClone(v.records[0]); duplicate.request.body.task_id = 'ota-other-task'; v.records.push(duplicate); },
    v => {
      v.records[0].stage = 'installing'; v.records[0].outcome = null;
      const pending = structuredClone(v.records[0]); pending.request.body.task_id = 'ota-other-task'; pending.request.body.execution_id = 'other-execution';
      v.records.push(pending);
    },
  ];
  const raws = ['{}', JSON.stringify(saved).replace('rejected', 'installing'), '{"version":1,"version":1}', ' '.repeat(32769)];
  for (const change of changes) {
    const value = structuredClone(saved); change(value); delete value.checksum; value.checksum = await documentDigest(value); raws.push(JSON.stringify(value));
  }
  for (const [i, raw] of raws.entries()) {
    const state = 'invalid-' + i + '.json'; await writeFile(path.join(dir, state), raw);
    const output = await invoke(dir, [], { state }); assert.equal(output.opened, false); assert.equal(output.open_error, code.storage);
    assert.equal(await readFile(path.join(dir, state), 'utf8'), raw);
  }
  const failedRead = await invoke(dir, [], { fault: 'read' }); assert.equal(failedRead.open_error, code.storage);
  const wrongOwner = await invoke(dir, [], { space_id: 'other-space' }); assert.equal(wrongOwner.open_error, code.storage);
}));

test('OTA严格Envelope/摘要/期限检查，128字符标识及存储字节配额有界', async () => workspace(async dir => {
  const request = await envelope(), changes = [
    r => { r.seq = 1; }, r => { r.type = r.kind; delete r.kind; }, r => { r.device_id = 'other'; },
    r => { r.body.manifest_digest = baseline.image_sha256; }, r => { r.body.extra = true; },
    r => { r.body.task_id = 'ota-'; }, r => { r.boot_id = 'x'.repeat(129); }, r => { r.message_id = 'bad.id'; },
    ...['2026-02-29T00:00:00Z', '2026-11-03T00:00:00.Z', '2026-11-03T00:00:00.1234567890Z', '2026-11-03T00:00:00+00:00'].map(value => r => { r.body.expires_at = value; }),
  ];
  const steps = changes.map(change => { const value = structuredClone(request); change(value); return prepare(value); });
  const rawCases = [JSON.stringify(request).replace('"v":1', '"v":1,"v":1'), JSON.stringify(request) + '\0', JSON.stringify(request) + '{}'];
  for (const [i, raw] of rawCases.entries()) {
    const filename = path.join(dir, 'raw-' + i + '.json'); await writeFile(filename, raw); steps.push(prepare(null, { request_file: filename }));
  }
  const rows = codes(await invoke(dir, steps), steps.map(() => 'invalid')); assert.equal(rows.at(-1).writes, 0);
  const long = await envelope(1, r => { for (const key of ['message_id', 'boot_id', 'session_id']) r[key] = key[0].repeat(128); r.body.task_id = 'ota-' + 't'.repeat(124); r.body.execution_id = 'e'.repeat(128); });
  codes(await invoke(dir, [prepare(long), { op: 'get', execution_id: long.body.execution_id }], { state: 'long.json' }), ['ok', 'ok']);
  // 此处只验证日志容量；安装策略仍须独立拒绝含额外字段的清单，日志不授予信任。
  const large = await Promise.all([1, 2, 3].map(i => envelope(i, r => { r.body.manifest.storage_test_padding = 'x'.repeat(12000); })));
  const capacity = codes(await invoke(dir, [prepare(large[0]), finish('rejected'), prepare(large[1]), finish('rejected', 2), prepare(large[2]), get(2)], { state: 'large.json' }),
    ['ok', 'ok', 'ok', 'ok', 'capacity', 'ok']);
  assert.equal(capacity.at(-1).writes, 4); assert.equal((await snapshot(dir, 'large.json')).records.length, 2);
  const restored = codes(await invoke(dir, [get(1), get(2)], { state: 'large.json' }), ['ok', 'ok']);
  assert.equal(restored[0].view.stage, 'rejected'); assert.equal(restored[1].view.stage, 'rejected');
}));

test('OTA启动凭据只在本次awaiting_boot绑定，重复只读且恢复不重新绑定', async () => workspace(async dir => {
  const request = await envelope(), bind = binding => ({ op: 'bind', execution_id: 'execution-1', binding });
  const rows = codes(await invoke(dir, [prepare(request), bind('host_one'), advance('installing'), bind('host_one'),
    advance('awaiting_boot'), bind('host_one'), get(), bind('host_one'), bind('host_two'), finish('failed')]),
    ['ok', 'conflict', 'ok', 'conflict', 'ok', 'ok', 'ok', 'ignored', 'conflict', 'conflict']);
  assert.equal(rows[6].view.boot_binding, 'host_one'); assert.equal(rows[6].view.target_size_bytes, request.body.manifest.statement.size_bytes);
  assert.equal(rows.at(-1).writes, 4);
  const saved = await snapshot(dir); assert.equal(saved.version, 2); assert.equal(saved.records[0].boot_binding, 'host_one');
  const recovered = codes(await invoke(dir, [get(), bind('host_one'), bind('host_two'), finish()]), ['ok', 'ignored', 'conflict', 'ok']);
  assert.equal(recovered[0].view.recovered, true); assert.equal(recovered[0].view.boot_binding, 'host_one');
  assert.equal((await snapshot(dir)).records[0].boot_binding, 'host_one');
}));
test('OTA日志读取版本1不写盘，修改后升级为版本2且不从旧请求推导启动凭据', async () => workspace(async dir => {
  codes(await invoke(dir, [prepare(await envelope()), finish('rejected')]), ['ok', 'ok']);
  const value = await snapshot(dir); value.version = 1;
  for (const record of value.records) delete record.boot_binding;
  delete value.checksum; value.checksum = await documentDigest(value);
  const raw = JSON.stringify(value); await writeFile(path.join(dir, 'state.json'), raw);
  const read = codes(await invoke(dir, [get()]), ['ok'])[0];
  assert.equal(read.writes, 0); assert.equal(read.view.boot_binding, ''); assert.equal(await readFile(path.join(dir, 'state.json'), 'utf8'), raw);
  codes(await invoke(dir, [prepare(await envelope(2))]), ['ok']);
  const upgraded = await snapshot(dir); assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.records.map(v => v.boot_binding), [null, null]);
}));
