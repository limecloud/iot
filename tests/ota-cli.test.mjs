import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
async function workspace(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'limeiot-ota-cli-'));
  try {
    await writeFile(path.join(dir, 'request.json'), JSON.stringify(fixture.request));
    await writeFile(path.join(dir, 'image.bin'), Buffer.from(fixture.image_base64, 'base64'));
    await run(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function cli(args, env = {}) {
  try {
    const result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'ota', ...args], {
      cwd: root, timeout: 12000,
      env: { ...process.env, LIMEIOT_OTA_TOOL: path.join(root, 'target/debug/limeiot-ota'), HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ...env },
    });
    return { ...result, code: 0 };
  } catch (error) { return error; }
}
const verifyArgs = dir => ['verify', '--input', path.join(dir, 'request.json'), '--image', path.join(dir, 'image.bin')];

test('OTA发现和离线校验使用共享Rust规则，报告绑定完整请求且不写原文件', async () => {
  const schema = await cli(['schema']);
  assert.equal(schema.code, 0, schema.stderr);
  const catalog = JSON.parse(schema.stdout);
  assert.equal(catalog.mode, 'local');
  assert.equal(catalog.operations[0].network, false);
  assert.equal(catalog.operations[1].operation_id, 'ota.download');
  assert.equal(catalog.operations[0].operation_id, 'ota.verify');
  assert.deepEqual(catalog.schemas.verification, JSON.parse(await readFile(path.join(root, 'contracts/ota.schema.json'), 'utf8')));
  await workspace(async dir => {
    const before = await readFile(path.join(dir, 'request.json'), 'utf8');
    const result = await cli(verifyArgs(dir));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.request_digest, await documentDigest(fixture.request));
    assert.equal(report.image_sha256, fixture.request.manifest.statement.sha256);
    assert.equal(report.image_size_bytes, Buffer.from(fixture.image_base64, 'base64').length);
    assert.deepEqual(report.issues, []);
    assert.equal(await readFile(path.join(dir, 'request.json'), 'utf8'), before);
    assert.deepEqual((await readdir(dir)).sort(), ['image.bin', 'request.json']);
  });
});

test('篡改镜像、撤销与不兼容快照保持失败，不能把验签成功当作可升级', async () => {
  await workspace(async dir => {
    for (const [change, expected] of [
      [value => { value.manifest.statement.version = '0.3.0'; }, 'invalid_ota_signature'],
      [value => { value.trust.revoked_artifact_ids = [value.manifest.statement.artifact_id]; }, 'ota_artifact_revoked'],
      [value => { value.device.board = 'another-board'; }, 'ota_target_mismatch'],
      [value => { value.device.pending_update = true; }, 'ota_device_busy'],
    ]) {
      const request = structuredClone(fixture.request); change(request);
      await writeFile(path.join(dir, 'request.json'), JSON.stringify(request));
      const result = await cli(verifyArgs(dir));
      assert.equal(result.code, 2, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.valid, false);
      assert.equal(report.issues[0].code, expected);
      assert.equal(report.request_digest, await documentDigest(request));
    }
    await writeFile(path.join(dir, 'request.json'), JSON.stringify(fixture.request));
    await writeFile(path.join(dir, 'image.bin'), Buffer.alloc(Buffer.from(fixture.image_base64, 'base64').length));
    const result = await cli(verifyArgs(dir));
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).issues[0].code, 'ota_image_digest_mismatch');
    assert.deepEqual((await readdir(dir)).sort(), ['image.bin', 'request.json']);
  });
});

test('参数、坏JSON和组件故障有明确退出码，不输出输入路径', async () => {
  await workspace(async dir => {
    for (const raw of ['{"manifest":{},"manifest":{}}', ' '.repeat(32769)]) {
      await writeFile(path.join(dir, 'request.json'), raw);
      const result = await cli(verifyArgs(dir));
      assert.equal(result.code, 2);
      assert.equal(JSON.parse(result.stdout).issues[0].code, 'invalid_ota_document');
    }
    for (const [env, code] of [
      [{ LIMEIOT_OTA_TOOL: 'relative/path' }, 'absolute_ota_tool_path_required'],
      [{ LIMEIOT_OTA_TOOL: path.join(dir, 'private-missing-component') }, 'ota_component_unavailable'],
    ]) {
      const result = await cli(verifyArgs(dir), env);
      assert.equal(result.code, 5);
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), { error: { code } });
      assert.equal(result.stderr.includes(dir), false);
    }
    const result = await cli(['install']);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'ota_arguments_required' } });
  });
});
