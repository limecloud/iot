// 显式运行真实本地模型；不启动夹具、不自动下载模型、不切换提供方或重试生成。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, until } from './dev-stack.mjs';

const model = process.env.LIMEIOT_OLLAMA_MODEL;
if (!model) throw new Error('set LIMEIOT_OLLAMA_MODEL to an installed local model');
const stack = await startStack();
const base = '/api/v1/spaces/space-demo';
const report = { model, cases: [], passed: false };
const post = (body, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
async function generate(prompt, key) {
  const input = { prompt, expires_at: new Date(Date.now() + 120000).toISOString() };
  const accepted = await stack.request(`${base}/rule-drafts`, post(input, key));
  assert.equal(accepted.status, 202);
  const draft = await until(async () => {
    const response = await stack.request(`${base}/rule-drafts/by-key/${key}`);
    return response.status === 200 && response.value.status !== 'running' && response.value;
  }, 100000);
  report.cases.push({ prompt, status: draft.status, error: draft.error, rule: draft.rule, usage: draft.usage });
  assert.equal((await stack.request(`${base}/rule-drafts`, post(input, key))).value.draft_id, draft.draft_id);
  return draft;
}
try {
  const capabilities = (await stack.request(`${base}/capabilities`)).value;
  assert.equal(capabilities.inference.configured, true);
  const draft = await generate('按下按钮时将环境灯亮度设为37，冷却10秒。', 'live-light');
  assert.equal(draft.status, 'completed');
  assert.deepEqual(draft.rule.trigger, { device: 'device-button', event: 'button.pressed' });
  assert.deepEqual(draft.rule.actions, [{ device: 'device-lamp', set: { path: 'light.brightness', value: 37 } }]);
  assert.equal(draft.rule.cooldown_ms, 10000);
  assert.equal((await stack.request(`${base}/commands`)).value.items.length, 0);
  assert.equal((await stack.request(`${base}/rule-deployments`)).value.items.length, 0);
  const unsupported = await generate('按下按钮时用摄像头识别月球基地，然后让玩具飞到月球。', 'live-unsupported');
  assert.equal(unsupported.status, 'rejected');
  assert.equal(unsupported.error, 'unsupported_intent');
  assert.equal(unsupported.rule, null);
  const proof = await stack.request(`${base}/rules:simulate`, post({ rule: draft.rule, event: { device_id: 'device-button', path: 'button.pressed', historical: false, data: { count: 1 } } }));
  assert.equal(proof.value.matched, true);
  assert.equal(proof.value.executed, false);
  assert.equal(proof.value.revision, draft.rule_revision);
  assert.equal((await stack.request(`${base}/commands`)).value.items.length, 0);
  assert.equal((await stack.request(`${base}/rule-deployments`, post(draft.rule))).status, 200);
  stack.button.stdin.write(JSON.stringify({ data: { count: 1 } }) + '\n');
  await until(async () => (await stack.request(`${base}/commands`)).value.items.some(command => command.status === 'confirmed' && command.request.operation.value === 37));
  await stack.restartGateway();
  assert.equal((await stack.request(`${base}/rule-drafts/by-key/live-light`)).value.draft_id, draft.draft_id);
  report.passed = true;
  console.log(JSON.stringify({ model, passed: true, cases: report.cases.length, transport: 'actual_ollama_and_mqtt_simulated_devices', hardware: false }));
} finally {
  try {
    await mkdir(path.join(root, '.dev/ollama'), { recursive: true });
    await writeFile(path.join(root, '.dev/ollama/verification.json'), JSON.stringify(report, null, 2) + '\n');
  } finally { await stack.close(); }
}
