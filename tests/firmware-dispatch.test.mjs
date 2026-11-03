import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';

const exec = promisify(execFile);
const binary = process.env.LIMEIOT_ESP_DISPATCH_BINARY;
const python = process.env.LIMEIOT_IDENTITY_PYTHON ?? path.join(root, '.dev/firmware-tools/venv/bin/python');
const cases = [
  ['generation', 'valid', '新连接不能消费旧队列代次，旧提交上下文拒绝驱动/发布/OTA'],
  ['reconnect', 'valid', '连接连续失败仍按真实五秒间隔重试，成功后仅发布一次握手'],
  ['clock', 'valid', '失信时丢弃原队列，停止失败重试且成功后不再停止，时间恢复不解锁'],
  ['expiry', 'short-leaf', '叶证书实际到期后拒绝已排队握手、迟到接收和全部提交端口'],
  ['expiry', 'short-ca', 'CA实际到期后拒绝已排队握手、迟到接收和全部提交端口'],
];
for (const [mode, kind, title] of cases) test('生产ESP worker边界：' + title, { timeout: 25000 }, async t => {
  assert.ok(binary, '通过固件运行期工具构建生产适配器边界宿主');
  const directory = await mkdtemp(path.join(root, '.dev/esp-dispatch-'));
  await exec(python, ['firmware/tests/runtime_certificates.py', directory, kind], { cwd: root, timeout: 5000 });
  const { stdout, stderr } = await exec(binary, [directory, mode], { cwd: root, timeout: 20000 });
  assert.equal(stderr, ''); assert.ok(!stdout.includes('PRIVATE KEY'));
  const result = JSON.parse(stdout);
  assert.equal(result.mode, mode); assert.equal(result.driver_calls, 0);
  assert.equal(result.production_worker, true); assert.equal(result.real_monotonic_clock, true);
  const connected = mode === 'generation' || mode === 'reconnect';
  assert.equal(result.locked, !connected); assert.equal(result.published, connected ? 1 : 0);
  assert.equal(result.stale_submission_rejections, connected ? 1 : 0);
  assert.equal(result.reconnects, mode === 'reconnect' ? 3 : mode === 'generation' ? 1 : 0);
  assert.equal(result.stops, mode === 'clock' ? 3 : mode === 'expiry' ? 1 : 0);
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ...result, status: 'passed', certificate_kind: kind,
    mqtt_transport_runtime: false, freertos_scheduler_runtime: false, flash_runtime: false,
    ota_installation_runtime: false, hardware_status: '用户要求跳过' }, null, 2) + '\n');
  t.diagnostic('证据目录：' + directory);
});
