import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root, cli, signedWorkspace, publishArgs } from './helpers/ota-release.mjs';

test('仓库重验并复制完整签名快照，发现/Schema一致，重复和并发写入不覆盖', async () => {
  const w = await signedWorkspace(), args = publishArgs(w);
  const both = await Promise.all([cli(args), cli(args)]);
  assert.deepEqual(both.map(v => v.code).sort(), [0, 4]);
  const result = JSON.parse(both.find(v => v.code === 0).stdout);
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  ajv.addSchema(JSON.parse(await readFile(path.join(root, 'contracts/ota.schema.json'), 'utf8')), 'ota.schema.json');
  ajv.addSchema(JSON.parse(await readFile(path.join(root, 'contracts/ota-release.schema.json'), 'utf8')), 'release.json');
  const validate = ajv.compile({ $ref: 'release.json#/$defs/publication' });
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  const catalog = JSON.parse((await cli(['schema'])).stdout);
  assert.equal(catalog.operations.find(v => v.operation_id === 'ota.publish').network, false);
  const output = path.join(w.dir, 'repository/artifacts', w.receipt.artifact_id);
  for (const name of ['release.json', 'firmware.bin', 'manifest.json', 'receipt.json'])
    assert.deepEqual(await readFile(path.join(output, name)), await readFile(path.join(w.dir, 'bundle', name)));
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'published.json'), 'utf8')), result);
  assert.deepEqual((await readdir(output)).sort(), ['firmware.bin', 'manifest.json', 'publication.pending.json', 'published.json', 'receipt.json', 'release.json']);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o700);
  const before = await readFile(path.join(output, 'published.json'));
  assert.equal((await cli(args)).code, 4);
  assert.deepEqual(await readFile(path.join(output, 'published.json')), before);
});

test('不能只信ready：配方、镜像、签名、回执和当前独立策略任一不符均在仓库写入前拒绝', async () => {
  for (const change of [
    async w => writeFile(path.join(w.dir, 'bundle/release.json'), JSON.stringify({ ...w.recipe, firmware_version: '0.3.0' })),
    async w => writeFile(path.join(w.dir, 'bundle/firmware.bin'), Buffer.from('broken')),
    async w => writeFile(path.join(w.dir, 'bundle/manifest.json'), JSON.stringify({ ...w.manifest, signature: 'A'.repeat(86)+'==' })),
    async w => writeFile(path.join(w.dir, 'bundle/receipt.json'), JSON.stringify({ ...w.receipt, extra: true })),
    async w => writeFile(path.join(w.dir, 'trust.json'), JSON.stringify({ ...w.trust, revoked_artifact_ids: [w.receipt.artifact_id] })),
    async w => writeFile(path.join(w.dir, 'trust.json'), JSON.stringify({ ...w.trust, minimum_security_epoch: 2 })),
    async w => writeFile(path.join(w.dir, 'bundle/extra.json'), '{}'),
    async w => { w.recipe.download_base_url = 'https://other.example.test/artifacts/'; },
  ]) {
    const w = await signedWorkspace(); await change(w);
    const result = await cli(publishArgs(w)); assert.equal(result.code, 2, result.stderr); assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(path.join(w.dir, 'repository')), []);
  }
});

test('中断留下的目录不续写，符号链接/不安全仓库和非法参数拒绝', async () => {
  const w = await signedWorkspace(), output = path.join(w.dir, 'repository/artifacts', w.receipt.artifact_id);
  await mkdir(output, { recursive: true, mode: 0o700 }); await writeFile(path.join(output, 'firmware.bin'), 'partial');
  assert.equal((await cli(publishArgs(w))).code, 4);
  assert.equal(await readFile(path.join(output, 'firmware.bin'), 'utf8'), 'partial');
  await assert.rejects(stat(path.join(output, 'published.json')), { code: 'ENOENT' });
  assert.equal((await cli(['publish'])).code, 2);
  const args = publishArgs(w); args[args.indexOf('--base-url')] = '--repository';
  assert.equal((await cli(args)).code, 2);
  if (process.platform !== 'win32') {
    const linked = path.join(w.dir, 'linked'); await symlink(path.join(w.dir, 'repository'), linked);
    const linkArgs = publishArgs(w); linkArgs[linkArgs.indexOf('--repository') + 1] = linked;
    assert.equal((await cli(linkArgs)).code, 2);
    await chmod(path.join(w.dir, 'repository'), 0o777);
    assert.equal((await cli(publishArgs(w))).code, 2);
    await chmod(path.join(w.dir, 'repository'), 0o700);
  }
});
