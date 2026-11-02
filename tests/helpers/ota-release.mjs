import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '../..');
export const exec = promisify(execFile);
export const fixture = JSON.parse(await readFile(path.join(root, 'contracts/examples/ota-firmware.json'), 'utf8'));
export const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export async function cli(args) {
  try { return { ...await exec(process.execPath, ['packages/cli/src/main.mjs', 'ota', ...args], {
    cwd: root, timeout: 40000,
    env: { ...process.env, LIMEIOT_OTA_TOOL: path.join(root, 'target/debug/limeiot-ota') },
  }), code: 0 }; } catch (error) { return error; }
}
// 仅供软件边界检查的合法格式夹具，不代表物理设备可以启动。
export function testImage() {
  const header = Buffer.alloc(32), data = Buffer.alloc(256);
  header[0] = 0xe9; header[1] = 1; header.writeUInt16LE(5, 12); header[23] = 1; header.writeUInt32LE(data.length, 28);
  data.writeUInt32LE(0xabcd5432); data.writeUInt32LE(1, 4); data.write('0.2.0', 16); data.write('limeiot_test', 48);
  const body = Buffer.concat([header, data, Buffer.alloc(16)]);
  body[body.length - 1] = data.reduce((sum, byte) => sum ^ byte, 0xef);
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}
export async function signedWorkspace({ baseURL = 'https://firmware.example.test/artifacts/', image = testImage(), role = 'lamp', directory } = {}) {
  const dir = directory ?? path.join(root, '.dev', 'ota-publish-' + crypto.randomUUID());
  await mkdir(dir, { mode: 0o700 }); await mkdir(path.join(dir, 'repository'), { mode: 0o700 });
  const generated = await cli(['keygen', '--output-dir', path.join(dir, 'key')]);
  if (generated.code !== 0) throw new Error(generated.stderr);
  const key = JSON.parse(generated.stdout), model = JSON.parse(await readFile(path.join(root, `contracts/models/${role}.json`), 'utf8'));
  const { documentDigest } = await import('../../packages/protocol/model-validation.mjs');
  const recipe = { schema: 'limeiot.ota-release', version: 1, image_format: 'esp32c3',
    target: { ...fixture.request.manifest.statement.target, product_id: 'desk-node-' + role },
    firmware_version: image.subarray(48, 80).toString().split('\0')[0],
    compatibility: { ...fixture.request.manifest.statement.compatibility, model_revisions: [await documentDigest(model)] },
    security_epoch: image.readUInt32LE(36), download_base_url: baseURL,
    issued_at: '2026-11-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' };
  const trust = { ...fixture.request.trust, public_key: key.public_key, signing_key_id: key.signing_key_id,
    product_ids: [recipe.target.product_id], minimum_security_epoch: recipe.security_epoch,
    download_origins: [new URL(baseURL).origin] };
  await writeFile(path.join(dir, 'recipe.json'), JSON.stringify(recipe));
  await writeFile(path.join(dir, 'trust.json'), JSON.stringify(trust));
  await writeFile(path.join(dir, 'image.bin'), image);
  const signed = await cli(['sign', '--input', path.join(dir, 'recipe.json'), '--trust', path.join(dir, 'trust.json'),
    '--key', path.join(dir, 'key/private.pk8'), '--image', path.join(dir, 'image.bin'), '--output-dir', path.join(dir, 'bundle')]);
  if (signed.code !== 0) throw new Error(signed.stderr);
  const receipt = JSON.parse(signed.stdout), manifest = JSON.parse(await readFile(path.join(dir, 'bundle/manifest.json'), 'utf8'));
  return { dir, key, recipe, trust, receipt, manifest, image };
}
export const publishArgs = w => ['publish', '--bundle', path.join(w.dir, 'bundle'), '--trust', path.join(w.dir, 'trust.json'),
  '--repository', path.join(w.dir, 'repository'), '--base-url', w.recipe.download_base_url];
