import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root } from './dev-stack.mjs';

const exec = promisify(execFile);
if (process.argv.slice(2).some(value => !['--build-only', '--recovery', '--ota-recovery', '--ota-install'].includes(value))) throw new Error('只接受--build-only、--recovery、--ota-recovery、--ota-install或无参数');
const installation = process.argv.includes('--ota-install');
const otaRecovery = process.argv.includes('--ota-recovery');
const recovery = process.argv.includes('--recovery') || otaRecovery;
if (installation && recovery) throw new Error('--ota-install不能与恢复专项合并');
const sdk = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
if (!sdk) throw new Error('设置LIMEIOT_IDF_PATH或IDF_PATH，指向固定ESP-IDF SDK');
const revision = (await exec('git', ['-C', sdk, 'rev-parse', 'HEAD'])).stdout.trim();
if (revision !== 'fff9895c82d744c7237be8847347bdd1b07c6643') throw new Error('固定ESP-IDF修订不匹配');
const source = path.join(sdk, 'components/mbedtls/mbedtls');
const crypto = path.join(root, '.dev/identity-crypto-host');
const libraries = [path.join(crypto, 'library/libmbedx509.a'), path.join(crypto, 'tf-psa-crypto/core/libtfpsacrypto.a')];
for (const file of libraries) await stat(file).catch(() => { throw new Error('先运行test:firmware:identity构建固定SDK密码库'); });
const directory = path.join(root, installation ? '.dev/esp-install-host' : recovery ? '.dev/esp-recovery-host' : '.dev/esp-runtime-host'); await mkdir(directory, { recursive: true });
const cjson = '.dev/firmware-tools/cjson-1.7.19';
const core = 'firmware/components/limeiot_core';
const sdkIncludes = [path.join(source, 'include'), path.join(source, 'tf-psa-crypto/include'), path.join(source, 'tf-psa-crypto/drivers/builtin/include'), path.join(crypto, 'tf-psa-crypto/include')];
const includes = [...(recovery ? ['firmware/tests/esp_recovery_stubs'] : []), 'firmware/tests/esp_runtime_stubs', 'firmware/tests/identity_stubs', ...sdkIncludes, core + '/include', core + '/src', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', 'firmware/generated', cjson, '.dev/tools/mosquitto-2.0.22/include'];
const mqtt = path.join(root, '.dev/tools/mosquitto-build/lib');
let opensslPackages = process.env.LIMEIOT_OPENSSL_PKG_CONFIG_PATH;
let opensslLibrary;
if (!opensslPackages && process.platform === 'darwin') {
  // SSL_CTX只允许在同一ABI内传递；宿主默认openssl可能已升级，旧libmosquitto仍链接另一主版本。
  const linked = (await exec('otool', ['-L', path.join(mqtt, 'libmosquitto.2.0.22.dylib')])).stdout;
  const library = linked.match(/^\s*(\/\S*\/libssl\.\d+\.dylib)\s/m)?.[1];
  if (!library) throw new Error('无法核对libmosquitto的OpenSSL ABI');
  opensslLibrary = library;
  opensslPackages = path.join(path.dirname(library), 'pkgconfig');
}
const openssl = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'], { env: { ...process.env, ...(opensslPackages ? { PKG_CONFIG_PATH: opensslPackages } : {}) } })).stdout.trim().split(/\s+/);
const binary = path.join(directory, installation ? 'esp-install-host' : recovery ? 'esp-recovery-host' : 'esp-runtime-host');
const identityBinary = path.join(directory, 'device-identity-host');
const flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []), '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'];
const sources = ['core', 'codec', 'ota_auth', 'ota_policy', 'ota_log', 'ota_device', 'ota_transfer'].map(name => core + '/src/' + name + '.c');
const inputs = new Set([...sources, 'firmware/tests/esp_runtime_host.c', 'firmware/tests/ota_host_crypto.h', 'firmware/generated/lamp.h', 'firmware/components/limeiot_espidf/src/espidf.c', 'firmware/components/limeiot_espidf/src/credential_window.c', 'firmware/components/limeiot_espidf/src/identity_crypto.c', 'tests/firmware-runtime.test.mjs', 'tools/test-firmware-runtime.mjs']);
if (installation) for (const file of ['firmware/tests/esp_install_host.c', 'firmware/tests/ota_transfer_fixture.h', 'tests/firmware-ota-install-credentials.test.mjs', 'contracts/examples/ota-firmware.json', 'contracts/ota-tasks.schema.json', 'packages/protocol/model-validation.mjs', 'tests/support/mqtt-probe.mjs', 'tools/dev-stack.mjs', 'deploy/nas/device_identity.py', 'deploy/nas/csr_enrollment.py', 'deploy/dev/config.json', 'package.json']) inputs.add(file);
const identitySources = ['storage', 'identity', 'identity_crypto'].map(name => 'firmware/components/limeiot_espidf/src/' + name + '.c');
if (recovery) for (const file of [...identitySources, 'firmware/tests/esp_recovery_host.c', 'firmware/tests/device_identity_host.c', 'tests/firmware-recovery.test.mjs', 'tests/support/firmware-recovery.mjs', ...(otaRecovery ? ['tests/firmware-ota-recovery.test.mjs'] : []), 'firmware/tools/nvs_hmac.py', 'deploy/nas/device_identity.py', 'deploy/nas/csr_enrollment.py', 'contracts/examples/ota-firmware.json', 'contracts/models/lamp.json', 'packages/protocol/model-validation.mjs', 'tests/support/mqtt-probe.mjs', 'tools/dev-stack.mjs', 'deploy/dev/config.json']) inputs.add(file);
for (const folder of [core + '/include', core + '/src', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src', 'firmware/tests/esp_runtime_stubs', 'firmware/tests/identity_stubs', ...(recovery ? ['firmware/tests/esp_recovery_stubs', 'firmware/tests/storage_stubs'] : [])]) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.h')) inputs.add(path.relative(root, path.join(entry.parentPath, entry.name)));
  }
}
async function digests(files = inputs) {
  return Object.fromEntries(await Promise.all([...files].sort().map(async file => [file, createHash('sha256').update(await readFile(path.isAbsolute(file) ? file : path.join(root, file))).digest('hex')])));
}
const sourceDigests = await digests();
const externalInputs = [...libraries, cjson + '/cJSON.c', path.join(mqtt, process.platform === 'darwin' ? 'libmosquitto.2.0.22.dylib' : 'libmosquitto.so'), ...(opensslLibrary ? [opensslLibrary, opensslLibrary.replace('libssl.', 'libcrypto.')] : [])];
const externalDigests = await digests(externalInputs);
async function compile(args, name) {
  try {
    const result = await exec(process.env.CC ?? 'clang', args, { cwd: root, timeout: 60000 });
    await writeFile(path.join(directory, name), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(path.join(directory, name), (error.stdout ?? '') + (error.stderr ?? ''));
    throw error;
  }
}
await compile([...flags, ...(recovery ? ['-DLI_ESP_RECOVERY_HOST'] : []), ...(installation ? ['-DLI_ESP_INSTALL_HOST'] : []), ...includes.map(value => '-I' + value), ...sources, cjson + '/cJSON.c', 'firmware/components/limeiot_espidf/src/credential_window.c', 'firmware/components/limeiot_espidf/src/identity_crypto.c', ...(recovery ? identitySources.filter(file => !file.endsWith('/identity_crypto.c')) : []), installation ? 'firmware/tests/esp_install_host.c' : recovery ? 'firmware/tests/esp_recovery_host.c' : 'firmware/tests/esp_runtime_host.c', ...libraries, '-L' + mqtt, '-lmosquitto', '-Wl,-rpath,' + mqtt, ...openssl, '-lm', '-o', binary], 'compile.log');
if (recovery) {
  const identityIncludes = ['firmware/tests/identity_stubs', ...sdkIncludes, 'firmware/tests/storage_stubs', core + '/include', 'firmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src'];
  await compile([...flags, ...identityIncludes.map(value => '-I' + value), ...identitySources, 'firmware/tests/device_identity_host.c', ...libraries, ...openssl, '-o', identityBinary], 'identity-compile.log');
}
if (JSON.stringify(sourceDigests) !== JSON.stringify(await digests())) throw new Error('构建期间受测源码已变化，不能归档本次结果');
if (JSON.stringify(externalDigests) !== JSON.stringify(await digests(externalInputs))) throw new Error('构建期间受测依赖已变化，不能归档本次结果');
const buildInfo = { sdk_revision: revision, source_sha256: sourceDigests, binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'), sanitizers: ['address', 'undefined'], production_adapter_worker: true, identity_crypto: 'fixed-sdk-mbedtls', transport: 'libmosquitto-openssl', fixtures: ['freertos-queue-task', 'file-backed-nvs', 'lamp-driver', 'ota-crypto-and-ports'], esp_mqtt_runtime: false, hardware: false };
buildInfo.openssl_pkg_config_path = opensslPackages ?? null;
buildInfo.openssl_flags = openssl;
buildInfo.external_sha256 = externalDigests;
if (installation) {
  buildInfo.production_installation_consumer = true;
  buildInfo.production_transfer = true;
  buildInfo.fixtures = ['freertos-queue-task', 'file-backed-nvs', 'lamp-driver', 'openssl-ota-signature', 'openssl-https', 'spare-file', 'baseline-image', 'boot-selection-binding', 'restart-request', 'unavailable-boot-observer'];
  buildInfo.actual_installation = false;
}
if (recovery) {
  buildInfo.same_process_identity_tls = true;
  buildInfo.identity_binary_sha256 = createHash('sha256').update(await readFile(identityBinary)).digest('hex');
}
await writeFile(path.join(directory, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
if (!process.argv.includes('--build-only')) {
  await exec('cargo', ['build', '--locked', '-p', 'limeiot-gateway', '-p', 'limeiot-simulator'], { cwd: root, timeout: 120000 });
  const fixtureOutput = path.join(directory, 'ota-recovery-source.json');
  // 身份/控制与未决OTA按独立进程验收；单条60秒和每进程120秒的边界保持不变。
  const suites = recovery ? [
    { file: 'tests/firmware-recovery.test.mjs', pattern: '原命令与明确新命令|换证后命令意图' },
    { file: 'tests/firmware-recovery.test.mjs', pattern: '原命令及未决OTA占用' },
    ...(otaRecovery ? [{ file: 'tests/firmware-ota-recovery.test.mjs' }] : []),
  ] : installation ? ['transfer', 'staging', 'activation'].map(group => ({ file: 'tests/firmware-ota-install-credentials.test.mjs', group })) : [{ file: 'tests/firmware-runtime.test.mjs' }];
  const installationGroups = [];
  for (const suite of suites) try {
    const pointer = path.join(directory, 'install-' + suite.group + '-source.json');
    const result = await exec(process.execPath, ['--test', '--test-concurrency=1', ...(suite.pattern ? ['--test-name-pattern', suite.pattern] : []), suite.file], { cwd: root, timeout: 120000, env: { ...process.env, LIMEIOT_ESP_RUNTIME_BINARY: binary, ...(installation ? { LIMEIOT_ESP_INSTALL_BINARY: binary, LIMEIOT_OTA_INSTALL_GROUP: suite.group, LIMEIOT_OTA_INSTALL_REPORT: pointer } : {}), ...(recovery ? { LIMEIOT_IDENTITY_HOST_BINARY: identityBinary } : {}), ...(otaRecovery ? { LIMEIOT_RECOVERY_FIXTURE_OUTPUT: fixtureOutput } : {}), ...(suite.file.endsWith('firmware-ota-recovery.test.mjs') ? { LIMEIOT_OTA_RECOVERY_SOURCE: fixtureOutput } : {}) }, maxBuffer: 1024 * 1024 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    if (JSON.stringify(sourceDigests) !== JSON.stringify(await digests())) throw new Error('运行期间受测源码已变化，不能将结果标为当前源码通过');
    if (JSON.stringify(externalDigests) !== JSON.stringify(await digests(externalInputs))) throw new Error('运行期间受测依赖已变化，不能将结果标为当前通过');
    if (createHash('sha256').update(await readFile(binary)).digest('hex') !== buildInfo.binary_sha256 || (recovery && createHash('sha256').update(await readFile(identityBinary)).digest('hex') !== buildInfo.identity_binary_sha256)) throw new Error('运行期间受测二进制已变化');
    if (installation) {
      await writeFile(path.join(directory, 'install-' + suite.group + '.log'), result.stdout + result.stderr);
      const location = JSON.parse(await readFile(pointer, 'utf8')), report = JSON.parse(await readFile(location.report, 'utf8'));
      const expected = { transfer: 3, staging: 4, activation: 5 }[suite.group];
      if (location.group !== suite.group || report.status !== 'passed' || report.group !== suite.group || report.cases.length !== expected) throw new Error('完整安装凭据组报告不完整');
      installationGroups.push({ group: suite.group, report: path.relative(root, location.report), sha256: createHash('sha256').update(await readFile(location.report)).digest('hex'), cases: report.cases.map(value => value.name) });
    }
  } catch (error) { process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
  if (installation) {
    if (new Set(installationGroups.flatMap(value => value.cases)).size !== 12) throw new Error('完整安装凭据案例缺失或重复');
    await writeFile(path.join(directory, 'install-report.json'), JSON.stringify({ status: 'passed', cases: 12, groups: installationGroups, production_adapter_worker: true, production_installation_consumer: true, actual_installation: false, esp_mqtt_runtime: false, hardware: false, full_goal_completed: false }, null, 2) + '\n');
  }
}
