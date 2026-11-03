import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { root } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile);

test('计划CLI丢响应后只查原键，404及篡改回执均不补POST', { timeout: 45000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'limeiot-plan-cli-')));
  const input = { type: 'plans.create', plan_id: 'cli-plan', generation: 'cli-generation', expires_at: new Date(Date.now() + 60000).toISOString(),
    stages: [{ steps: [{ step_id: 'one', device_id: 'one', model_revision: 'sha256:' + 'a'.repeat(64),
      operation: { type: 'property.set', path: 'light.level', value: 10 }, command_timeout_ms: 5000, completion: { type: 'command' } }] }] };
  const file = path.join(directory, 'change.json'); await writeFile(file, JSON.stringify(input));
  const request = { space_id: 'home', idempotency_key: 'original', change: input };
  const receipt = { operation_id: 'planop-test', request, request_digest: await documentDigest(request), status: 'applied', reason: null,
    result: { kind: 'execution_plan', id: input.plan_id, revision: 'sha256:' + 'b'.repeat(64) }, created_at: new Date().toISOString() };
  let posts = 0, gets = 0, mode = 'missing';
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { posts++; req.resume(); req.once('end', () => req.socket.destroy()); return; }
    gets++; res.setHeader('Content-Type', 'application/json');
    if (mode === 'missing') { res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'execution_plan_operation_not_found' } })); }
    else res.end(JSON.stringify(mode === 'tampered' ? { ...receipt, request_digest: 'sha256:' + '0'.repeat(64) } : receipt));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  async function call() {
    try {
      return { code: 0, ...await exec(process.execPath, ['packages/cli/src/main.mjs', 'execution-plan-changes', 'create', '--space-id', 'home', '--input', file,
        '--idempotency-key', 'original', '--state-dir', path.join(directory, 'state'), '--endpoint', endpoint, '--json'], {
        cwd: root, env: { ...process.env, LIMEIOT_TOKEN: 'local-test-token-not-a-production-secret', LIMEIOT_TOKEN_FILE: undefined }, timeout: 5000,
      }) };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  let result = await call();
  assert.equal(result.code, 6, result.stderr);
  assert.equal(posts, 1);
  result = await call();
  assert.equal(result.code, 6, result.stderr);
  assert.equal(posts, 1); assert.equal(gets, 1);
  mode = 'tampered'; result = await call();
  assert.equal(result.code, 6, result.stderr); assert.equal(posts, 1);
  mode = 'valid'; result = await call();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).operation_id, receipt.operation_id);
  assert.equal(posts, 1);
  await writeFile(file, JSON.stringify({ ...input, generation: 'changed' }));
  const before = gets;
  result = await call();
  assert.equal(result.code, 4, result.stderr);
  assert.equal(posts, 1); assert.equal(gets, before);
});
