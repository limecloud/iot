import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack } from '../tools/dev-stack.mjs';

test('HTTP与CLI在部署前拒绝阈值自写，重启保持原事件规则且不创建命令', { timeout: 30000 }, async t => {
  const stack = await startStack(); t.after(() => stack.close());
  const base = '/api/v1/spaces/space-demo';
  const rule = JSON.parse(await readFile(path.join(root, 'contracts/examples/environment-light.json')));
  rule.trigger = { device: 'device-lamp', property: { path: 'light.brightness', unit: 'percent', edge: 'rising', threshold: 50, hysteresis: 5 } };
  const before = (await stack.request(base + '/rule-deployments')).value;
  for (const suffix of ['/rules:validate', '/rules:simulate', '/rule-deployments']) {
    const input = suffix === '/rules:simulate' ? { rule, event: {} } : rule;
    const result = await stack.request(base + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(result.status, 422); assert.equal(result.value.error.code, 'rule_cycle');
  }
  const file = path.join(stack.directory, 'cyclic.json'); await writeFile(file, JSON.stringify(rule));
  try {
    await promisify(execFile)(process.execPath, ['packages/cli/src/main.mjs', 'invoke', 'rules.deploy', '--space-id', 'space-demo', '--input', file], { cwd: root, env: stack.env });
    assert.fail('CLI必须拒绝循环');
  } catch (error) { assert.match(error.stderr ?? '', /rule_cycle/); }
  assert.deepEqual((await stack.request(base + '/rule-deployments')).value, before);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await stack.restartGateway();
  assert.deepEqual((await stack.request(base + '/rule-deployments')).value, before);
  assert.equal((await stack.request(base + '/commands')).value.items.length, 0);
  await writeFile(path.join(stack.directory, 'rule-safety-result.json'), JSON.stringify({ passed: true, http_cli_rejection: true, no_commands: true, restart: true, hardware: false }));
});
