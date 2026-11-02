import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
async function check(mode, confirmed, marks, nativeValid) {
  let result;
  try { result = { ...await exec(path.join(root, '.dev/firmware-host/image-health'), [mode]), code: 0 }; }
  catch (error) { result = error; }
  assert.equal(result.stderr, '', mode);
  assert.equal(result.code, confirmed ? 0 : 2, mode);
  const output = JSON.parse(result.stdout);
  assert.equal(output.confirmed, confirmed, mode);
  assert.equal(output.mark_calls, marks, mode);
  assert.equal(output.hardware, false);
  if (nativeValid !== undefined) assert.equal(output.native_valid, nativeValid, mode);
  return output;
}
test('首次原生VALID镜像核对实际运行和镜像，重复确认不选择分区或重写原生状态', async () => {
  const result = await check('valid', true, 0, true);
  assert.equal(result.image_checks, 1); assert.equal(result.state_reads, 2);
  const repeated = await check('repeat-confirm', true, 1, true);
  assert.equal(repeated.image_checks, 2); assert.equal(repeated.state_reads, 4);
});
test('待确认镜像须原生确认成功并重新读取VALID才通过产品健康门禁', async () => {
  const result = await check('pending', true, 1, true);
  assert.equal(result.image_checks, 1); assert.equal(result.state_reads, 2);
});
test('缺失/未知/不匹配启动与坏镜像均不写启动元数据或确认成功', async () => {
  for (const mode of ['missing-running', 'missing-chosen', 'selected-other', 'factory', 'data', 'missing-state',
    'new', 'invalid', 'aborted', 'undefined', 'image-invalid', 'image-empty', 'image-too-big', 'selection-changed-before-confirm'])
    await check(mode, false, 0);
  await check('valid-final-lost', false, 0);
});
test('原生确认前后报错、未实际VALID、最终读取失败或选择变化都不能开放OTA', async () => {
  await check('failed-confirm', false, 1, false);
  await check('committed-error', false, 1, true);
  await check('confirm-not-valid', false, 1, false);
  await check('final-state-read-failed', false, 1, true);
  await check('selection-changed-after-confirm', false, 1, true);
});
