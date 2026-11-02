import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function nasVerificationPlatform(requested, daemon) {
  const target = requested ?? daemon;
  assert.match(target, /^linux\/(amd64|arm64)$/, 'supported platforms: linux/amd64, linux/arm64');
  return target;
}

// 核对实际镜像元数据，避免将宿主架构或目标参数当成构建结果。
export async function inspectNasImages(services, expected) {
  const references = [...new Set(Object.values(services))];
  const images = JSON.parse((await exec('docker', ['image', 'inspect', ...references], { timeout: 15000, maxBuffer: 4_000_000 })).stdout);
  const byReference = new Map(references.map((reference, index) => [reference, images[index]]));
  return Object.fromEntries(Object.entries(services).map(([service, reference]) => {
    const image = byReference.get(reference), platform = `${image.Os}/${image.Architecture}`;
    assert.equal(platform, expected, `verification_image_platform_mismatch: ${service} (${reference})`);
    return [service, { id: image.Id, reference, platform }];
  }));
}

export function nasImageOverrides(images, platform) {
  return Object.fromEntries(Object.entries(images).map(([service, image]) => [service, {
    image: image.id, platform, pull_policy: 'never',
  }]));
}

export function verifyNasMachine(machine, platform, service) {
  const expected = platform === 'linux/amd64' ? 'x86_64' : 'aarch64';
  assert.equal(machine.trim(), expected, `verification_runtime_platform_mismatch: ${service}`);
  return machine.trim();
}
