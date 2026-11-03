import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const base = '/api/v1/spaces/space-demo';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));

// 宿主轮询只看最终文件；先写完再交接，避免读取创建后尚未写入的空文件。
export async function publishFixture(directory, name, value) {
  const destination = path.join(directory, name), temporary = destination + '.pending';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, destination);
}

export function commands(stack, host) {
  return async (key, fault, value, deviceDirectory = host) => {
    await writeFile(path.join(deviceDirectory, 'driver-mode'), fault + '\n');
    const current = (await stack.request(base + '/devices/device-lamp')).value;
    const response = await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ device_id: 'device-lamp', model_revision: current.model_revision, expires_at: new Date(Date.now() + 29000).toISOString(), operation: { type: 'property.set', path: 'light.power', value } }) });
    assert.equal(response.status, 202); return response.value;
  };
}

export async function persistentSnapshot(directory) {
  const names = (await readdir(directory)).filter(name => name === 'identity.blob' || /^nvs-\d-/.test(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(path.join(directory, name)))])));
}

export async function cloneHost(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  const fixed = ['ca.crt', 'root.bin', 'binding.bin', 'identity.blob', 'driver-mode', 'effects-total.json', 'old-command.json'];
  for (const name of await readdir(source)) {
    if (fixed.includes(name) || /^nvs-\d-/.test(name)) await cp(path.join(source, name), path.join(destination, name));
  }
}
