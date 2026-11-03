import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './dev-stack.mjs';

const exec = promisify(execFile);
if (process.argv.slice(2).some(value => value !== '--build-only')) throw new Error('只接受--build-only或无参数');
const sdk = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
if (!sdk) throw new Error('设置LIMEIOT_IDF_PATH或IDF_PATH，指向固定ESP-IDF SDK');
const revision = (await exec('git', ['-C', sdk, 'rev-parse', 'HEAD'])).stdout.trim();
if (revision !== 'fff9895c82d744c7237be8847347bdd1b07c6643') throw new Error('固定ESP-IDF修订不匹配');
const source = path.join(sdk, 'components/mbedtls/mbedtls');
const crypto = path.join(root, '.dev/identity-crypto-host');
const libraries = [path.join(crypto, 'library/libmbedx509.a'), path.join(crypto, 'tf-psa-crypto/core/libtfpsacrypto.a')];
for (const file of libraries) await stat(file).catch(() => { throw new Error('先运行test:firmware:identity准备固定SDK宿主密码库'); });
const directory = path.join(root, '.dev/esp-dispatch-host'); await mkdir(directory, { recursive: true });
const core = 'firmware/components/limeiot_core', cjson = '.dev/firmware-tools/cjson-1.7.19';
const includes = ['firmware/tests/esp_runtime_stubs', 'firmware/tests/identity_stubs', path.join(source, 'include'), path.join(source, 'tf-psa-crypto/include'), path.join(source, 'tf-psa-crypto/drivers/builtin/include'), path.join(crypto, 'tf-psa-crypto/include'), core + '/include', core + '/src', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', 'firmware/generated', cjson];
const sources = ['core', 'codec', 'ota_auth', 'ota_policy', 'ota_log', 'ota_device', 'ota_transfer'].map(name => core + '/src/' + name + '.c');
sources.push(cjson + '/cJSON.c', 'firmware/components/limeiot_espidf/src/credential_window.c', 'firmware/components/limeiot_espidf/src/identity_crypto.c', 'firmware/tests/esp_dispatch_host.c');
const inputs = new Set([...sources, 'firmware/components/limeiot_espidf/src/espidf.c', 'firmware/tests/ota_host_crypto.h', 'firmware/generated/lamp.h', 'firmware/tests/runtime_certificates.py', 'tests/firmware-dispatch.test.mjs', 'tools/test-firmware-dispatch.mjs']);
for (const folder of [core + '/include', core + '/src', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', 'firmware/tests/esp_runtime_stubs', 'firmware/tests/identity_stubs', cjson]) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.h')) inputs.add(path.relative(root, path.join(entry.parentPath, entry.name)));
  }
}
const hash = data => createHash('sha256').update(data).digest('hex');
async function digests() {
  return Object.fromEntries(await Promise.all([...inputs].sort().map(async name => [name, hash(await readFile(path.join(root, name)))])));
}
const sourceDigests = await digests();
const openssl = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'])).stdout.trim().split(/\s+/);
const flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []), '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'];
const binary = path.join(directory, 'esp-dispatch-host');
try {
  const result = await exec(process.env.CC ?? 'clang', [...flags, ...includes.map(name => '-I' + name), ...sources, ...libraries, ...openssl, '-lm', '-o', binary], { cwd: root, timeout: 60000 });
  await writeFile(path.join(directory, 'compile.log'), result.stdout + result.stderr);
} catch (error) {
  await writeFile(path.join(directory, 'compile.log'), (error.stdout ?? '') + (error.stderr ?? '')); throw error;
}
if (JSON.stringify(sourceDigests) !== JSON.stringify(await digests())) throw new Error('构建期间输入变化，不能归档为当前源码通过');
const info = { sdk_revision: revision, source_sha256: sourceDigests, binary_sha256: hash(await readFile(binary)), library_sha256: Object.fromEntries(await Promise.all(libraries.map(async name => [path.relative(root, name), hash(await readFile(name))]))), sanitizers: ['address', 'undefined'], production_worker: true, real_certificate_dates: true, real_monotonic_clock: true, mqtt_transport_runtime: false, freertos_scheduler_runtime: false, flash_runtime: false, ota_installation_runtime: false, hardware: false };
await writeFile(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
if (!process.argv.includes('--build-only')) {
  try {
    const result = await exec(process.execPath, ['--test', '--test-concurrency=1', 'tests/firmware-dispatch.test.mjs'], { cwd: root, timeout: 90000, env: { ...process.env, LIMEIOT_ESP_DISPATCH_BINARY: binary }, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    if (JSON.stringify(sourceDigests) !== JSON.stringify(await digests())) throw new Error('运行期间输入变化，结果不能标为当前源码通过');
  } catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
}
