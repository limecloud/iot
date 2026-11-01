import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startStack, until, root } from '../tools/dev-stack.mjs';
import { ollamaFixture } from './support/ollama-fixture.mjs';
const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
const input = prompt => ({ prompt, expires_at: new Date(Date.now() + 120000).toISOString() });
const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(value) });
async function finished(stack, key) { return until(async () => { const result = (await stack.request(`${base}/rule-drafts/by-key/${key}`)).value; return result.status && result.status !== 'running' && result; }); }

test('本地推理合同：CLI发现、幂等、草案校验/预演、显式部署后真实MQTT执行', { timeout: 30000 }, async () => {
  const provider = await ollamaFixture(); const stack = await startStack({ gatewayEnv: { LIMEIOT_OLLAMA_MODEL: 'fixture-local', LIMEIOT_OLLAMA_URL: provider.origin, LIMEIOT_OLLAMA_CA_FILE: '' } });
  try {
    assert.equal((await stack.request('/api/v1/spaces/other/rule-drafts', post(input('不允许'), 'foreign'))).status, 403);
    assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT + base + '/rule-drafts', post(input('未认证'), 'anonymous'))).status, 401);
    assert.equal(provider.requests.length, 0);
    const cli = async args => JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', ...args], { cwd: root, env: stack.env })).stdout);
    assert.equal((await cli(['schema', 'drafts.create'])).recovery_operation, 'drafts.resolve');
    const request = { ...input('按下按钮时把环境灯亮度设为37'), space_id: 'space-demo', idempotency_key: 'original-draft' };
    const filename = path.join(stack.directory, 'draft-request.json'); await writeFile(filename, JSON.stringify(request));
    const accepted = await cli(['drafts', 'create', '--space-id', 'space-demo', '--input', filename]);
    const draft = await finished(stack, 'original-draft');
    assert.equal(draft.status, 'completed'); assert.equal(draft.rule.id, `ai-${accepted.draft_id}`);
    assert.equal((await cli(['drafts', 'resolve', '--space-id', 'space-demo', 'original-draft'])).draft_id, accepted.draft_id);
    assert.equal((await cli(['drafts', 'create', '--space-id', 'space-demo', '--input', filename])).draft_id, accepted.draft_id);
    assert.equal(provider.requests.length, 1);
    const transcript = JSON.stringify(provider.requests[0]);
    assert.ok(!transcript.includes(stack.env.LIMEIOT_TOKEN) && !transcript.includes(stack.env.LIMEIOT_MQTT_PASSWORD) && !transcript.includes('reported'));
    assert.equal(provider.requests[0].options.num_predict, 1024); assert.equal(provider.requests[0].stream, false);
    assert.equal((await stack.request(`${base}/rule-drafts`, post(input('改成关闭灯'), 'original-draft'))).status, 409);
    assert.equal((await stack.request(`${base}/commands`)).value.items.length, 0);
    assert.equal((await stack.request(`${base}/rule-deployments`)).value.items.length, 0);
    const simulation = await stack.request(`${base}/rules:simulate`, post({ rule: draft.rule, event: { device_id: 'device-button', path: 'button.pressed', historical: false, data: { count: 1 } } }));
    assert.equal(simulation.value.executed, false); assert.equal(simulation.value.revision, draft.rule_revision);
    assert.equal((await stack.request(`${base}/commands`)).value.items.length, 0);
    assert.equal((await stack.request(`${base}/rule-deployments`, post(draft.rule))).status, 200);
    stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
    await until(async () => (await stack.request(`${base}/commands`)).value.items.some(command => command.status === 'confirmed' && command.request.operation.value === 37));
    await stack.restartGateway();
    assert.equal((await finished(stack, 'original-draft')).draft_id, accepted.draft_id); assert.equal(provider.requests.length, 1);
  } finally { await stack.close(); await provider.close(); }
});

test('恶意/不完整结果、断流、并发与重启：不自动执行或重试，模型关闭仍可控制', { timeout: 45000 }, async () => {
  const provider = await ollamaFixture(); const stack = await startStack({ gatewayEnv: { LIMEIOT_OLLAMA_MODEL: 'fixture-local', LIMEIOT_OLLAMA_URL: provider.origin } });
  try {
    for (const mode of ['foreign', 'tool', 'unsupported', 'truncated', 'oversize', 'redirect', 'disconnect']) {
      provider.mode = mode; const request = input(`测试 ${mode}`);
      assert.equal((await stack.request(`${base}/rule-drafts`, post(request, mode))).status, 202);
      const draft = await finished(stack, mode);
      assert.ok(['rejected', 'unknown'].includes(draft.status)); assert.equal(draft.rule, null);
      const calls = provider.requests.length;
      assert.equal((await stack.request(`${base}/rule-drafts`, post(request, mode))).value.draft_id, draft.draft_id);
      assert.equal(provider.requests.length, calls);
    }
    assert.equal((await stack.request(`${base}/commands`)).value.items.length, 0);
    assert.equal((await stack.request(`${base}/rule-deployments`)).value.items.length, 0);
    provider.mode = 'hold'; const request = input('正在生成时重启');
    assert.ok(!provider.paths.includes('/redirect-target'));
    const accepted = await stack.request(`${base}/rule-drafts`, post(request, 'interrupted'));
    await until(() => provider.requests.length === 8);
    assert.equal((await stack.request(`${base}/rule-drafts`, post(input('并发请求'), 'busy'))).status, 429);
    await stack.restartGateway(); provider.release();
    const recovered = await finished(stack, 'interrupted');
    assert.equal(recovered.status, 'unknown'); assert.equal(recovered.draft_id, accepted.value.draft_id);
    assert.equal((await stack.request(`${base}/rule-drafts`, post(request, 'interrupted'))).value.status, 'unknown');
    assert.equal(provider.requests.length, 8);
    await provider.close();
    await until(async () => (await stack.request(`${base}/devices/device-lamp`)).value.ready);
    const lamp = (await stack.request(`${base}/devices/device-lamp`)).value;
    const controlled = await stack.request(`${base}/commands`, post({ device_id: lamp.device_id, model_revision: lamp.model_revision, expires_at: new Date(Date.now() + 5000).toISOString(), operation: { type: 'property.set', path: 'light.power', value: true } }, 'without-model'));
    assert.equal(controlled.status, 202);
    await until(async () => (await stack.request(`${base}/commands/${controlled.value.command_id}`)).value.status === 'confirmed');
  } finally { await stack.close(); await provider.close(); }
});
