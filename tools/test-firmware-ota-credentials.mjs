import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './dev-stack.mjs';

const exec = promisify(execFile);
if (process.argv.slice(2).some(value => value !== '--build-only')) throw new Error('只接受--build-only或无参数');
const sdk = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
if (!sdk) throw new Error('设置LIMEIOT_IDF_PATH或IDF_PATH，指向固定ESP-IDF SDK');
const revision = (await exec('git', ['-C', sdk, 'rev-parse', 'HEAD'])).stdout.trim();
if (revision !== 'fff9895c82d744c7237be8847347bdd1b07c6643') throw new Error('固定ESP-IDF修订不匹配');
const source = path.join(sdk, 'components/mbedtls/mbedtls'), crypto = path.join(root, '.dev/identity-crypto-host');
const libraries = [path.join(crypto, 'library/libmbedx509.a'), path.join(crypto, 'tf-psa-crypto/core/libtfpsacrypto.a')];
const directory = path.join(root, '.dev/ota-credential-transfer-host'); await mkdir(directory, { recursive: true });
const includes = ['firmware/tests/identity_stubs', path.join(source, 'include'), path.join(source, 'tf-psa-crypto/include'), path.join(source, 'tf-psa-crypto/drivers/builtin/include'), path.join(crypto, 'tf-psa-crypto/include'), 'firmware/tests/storage_stubs', 'firmware/components/limeiot_core/include', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', '.dev/firmware-tools/cjson-1.7.19'];
const sources = ['firmware/components/limeiot_core/src/ota_auth.c', 'firmware/components/limeiot_core/src/ota_policy.c', 'firmware/components/limeiot_core/src/ota_transfer.c', 'firmware/components/limeiot_espidf/src/credential_window.c', 'firmware/components/limeiot_espidf/src/identity_crypto.c', 'firmware/tests/ota_credential_transfer_host.c', '.dev/firmware-tools/cjson-1.7.19/cJSON.c'];
const inputs = new Set([...sources, 'firmware/components/limeiot_core/src/ota_internal.h', '.dev/firmware-tools/cjson-1.7.19/cJSON.h', 'firmware/tests/ota_transfer_fixture.h', 'firmware/tests/runtime_certificates.py', 'tests/firmware-ota-credentials.test.mjs', 'tools/test-firmware-ota-credentials.mjs']);
for (const folder of ['firmware/components/limeiot_core/include', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', 'firmware/tests/identity_stubs', 'firmware/tests/storage_stubs']) {
  for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.h')) inputs.add(folder + '/' + entry.name);
}
async function digests(files) {
  return Object.fromEntries(await Promise.all([...files].sort().map(async name => [name, createHash('sha256').update(await readFile(path.isAbsolute(name) ? name : path.join(root, name))).digest('hex')])));
}
const openssl = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'])).stdout.trim().split(/\s+/);
const libraryDirectory = (await exec('pkg-config', ['--variable=libdir', 'openssl'])).stdout.trim();
const external = [...libraries];
if (process.platform === 'darwin') for (const name of ['libssl.dylib', 'libcrypto.dylib']) external.push(path.join(libraryDirectory, name));
const sourceDigests = await digests(inputs), externalDigests = await digests(external);
const binary = path.join(directory, 'ota-credential-transfer-host');
const flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []), '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'];
try {
  const result = await exec(process.env.CC ?? 'clang', [...flags, ...includes.map(value => '-I' + value), ...sources, ...libraries, ...openssl, '-lm', '-o', binary], { cwd: root, timeout: 60000 });
  await writeFile(path.join(directory, 'compile.log'), result.stdout + result.stderr);
} catch (error) { await writeFile(path.join(directory, 'compile.log'), (error.stdout ?? '') + (error.stderr ?? '')); throw error; }
const info = { sdk_revision: revision, source_sha256: sourceDigests, external_sha256: externalDigests, binary_sha256: (await digests([binary]))[binary], sanitizers: ['address', 'undefined'], production_transfer: true, production_credential_window: true, transport: 'host-openssl-https', fixtures: ['spare-file', 'native-image-finish'], installation_dispatcher: false, esp_mqtt_runtime: false, hardware: false };
async function unchanged() {
  if (JSON.stringify(await digests(inputs)) !== JSON.stringify(sourceDigests) || JSON.stringify(await digests(external)) !== JSON.stringify(externalDigests) || (await digests([binary]))[binary] !== info.binary_sha256) throw new Error('受测源码/依赖/二进制已变化，拒绝归档为当前通过');
}
await unchanged(); await writeFile(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
if (!process.argv.includes('--build-only')) {
  try {
    const result = await exec(process.execPath, ['--test', '--test-concurrency=1', 'tests/firmware-ota-credentials.test.mjs'], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, LIMEIOT_OTA_CREDENTIAL_BINARY: binary } });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  } catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
  await unchanged();
}
