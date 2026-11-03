import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './dev-stack.mjs';

const exec = promisify(execFile);
const sdk = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
if (!sdk) throw new Error('设置LIMEIOT_IDF_PATH或IDF_PATH，指向完整固定ESP-IDF SDK');
const revision = (await exec('git', ['-C', sdk, 'rev-parse', 'HEAD'])).stdout.trim();
if (revision !== 'fff9895c82d744c7237be8847347bdd1b07c6643') throw new Error('固定ESP-IDF修订不匹配');
const source = path.join(sdk, 'components/mbedtls/mbedtls');
const output = path.join(root, '.dev/identity-crypto-host');
await mkdir(output, { recursive: true });
async function run(command, args, name, env = process.env) {
  const log = createWriteStream(path.join(root, '.dev', name));
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    child.once('error', error => { log.end(); reject(error); });
    child.once('close', code => log.end(() => code === 0 ? resolve() : reject(new Error(`${command}退出${code}，见.dev/${name}`))));
  });
}
await run('cmake', ['-S', source, '-B', output, '-DENABLE_PROGRAMS=OFF', '-DENABLE_TESTING=OFF', '-DGEN_FILES=OFF', '-DCMAKE_BUILD_TYPE=Debug', `-DCMAKE_C_FLAGS=-fsanitize=address,undefined -fno-omit-frame-pointer -I"${path.join(root, 'firmware/tests/identity_stubs')}"`], 'device-identity-crypto-configure.log');
await run('cmake', ['--build', output, '--target', 'mbedx509', 'tfpsacrypto', '--parallel', '4'], 'device-identity-crypto-build.log');
const openssl = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'])).stdout.trim().split(/\s+/);
const includes = ['firmware/tests/identity_stubs', path.join(source, 'include'), path.join(source, 'tf-psa-crypto/include'), path.join(source, 'tf-psa-crypto/drivers/builtin/include'), path.join(output, 'tf-psa-crypto/include'), 'firmware/tests/storage_stubs', 'firmware/components/limeiot_core/include', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src'];
const binary = path.join(output, 'device-identity-host');
await run(process.env.CC ?? 'clang', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g', ...includes.map(value => '-I'+value), 'firmware/components/limeiot_espidf/src/storage.c', 'firmware/components/limeiot_espidf/src/identity.c', 'firmware/components/limeiot_espidf/src/identity_crypto.c', 'firmware/tests/device_identity_host.c', path.join(output, 'library/libmbedx509.a'), path.join(output, 'tf-psa-crypto/core/libtfpsacrypto.a'), ...openssl, '-o', binary], 'device-identity-host-compile.log');
await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ sdk_revision: revision, sanitizers: ['address', 'undefined'], crypto: '固定SDK原始Mbed TLS/PSA源码及两份兼容头映射，未替换算法', hardware: false }, null, 2));
await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/firmware-device-identity.test.mjs'], 'device-identity-host-tests.log', { ...process.env, LIMEIOT_IDENTITY_HOST_BINARY: binary });
process.stdout.write('设备身份软件检查通过；原始日志.dev/device-identity-host-tests.log，hardware=false\n');
