import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), exec = promisify(execFile);
if (process.argv.slice(2).some(value => !['--build-only', '--integration'].includes(value))) throw new Error('只接受--build-only、--integration或无参数');
const integration = process.argv.includes('--integration');
const sdk = process.env.LIMEIOT_IDF_PATH ?? process.env.IDF_PATH;
if (!sdk || !path.isAbsolute(sdk)) throw new Error('LIMEIOT_IDF_PATH须指向固定ESP-IDF SDK绝对路径');
const revision = (await exec('git', ['-C', sdk, 'rev-parse', 'HEAD'])).stdout.trim();
if (revision !== 'fff9895c82d744c7237be8847347bdd1b07c6643') throw new Error('固定ESP-IDF修订不匹配');
const directory = path.join(root, integration ? '.dev/esp-native-install-host' : '.dev/esp-native-ota-host'); await mkdir(directory, { recursive: true });
const mbedtls = path.join(sdk, 'components/mbedtls/mbedtls'), crypto = path.join(root, '.dev/identity-crypto-host');
const libraries = [path.join(crypto, 'library/libmbedx509.a'), path.join(crypto, 'tf-psa-crypto/core/libtfpsacrypto.a')];
const core = 'firmware/components/limeiot_core', native = 'firmware/components/limeiot_espidf';
const cjson = '.dev/firmware-tools/cjson-1.7.19';
const includes = ['firmware/tests/esp_native_ota_stubs', 'firmware/tests/identity_stubs',
  path.join(sdk, 'components/esp_common/include'), path.join(sdk, 'components/esp_app_format/include'),
  path.join(sdk, 'components/bootloader_support/include'), path.join(sdk, 'components/esp_rom/include'),
  path.join(mbedtls, 'include'), path.join(mbedtls, 'tf-psa-crypto/include'), path.join(mbedtls, 'tf-psa-crypto/drivers/builtin/include'),
  path.join(crypto, 'tf-psa-crypto/include'), 'firmware/tests/storage_stubs', core + '/include', native + '/include', native + '/src', cjson];
const sources = [core + '/src/ota_auth.c', core + '/src/ota_policy.c', core + '/src/ota_transfer.c',
  native + '/src/ota_transfer.c', native + '/src/credential_window.c', native + '/src/identity_crypto.c',
  'firmware/tests/esp_native_ota_host.c', cjson + '/cJSON.c', path.join(sdk, 'components/esp_rom/linux/esp_rom_crc.c')];
if (integration) {
  sources.push(...['core', 'codec', 'ota_log', 'ota_device'].map(name => core + '/src/' + name + '.c'));
  includes.splice(includes.indexOf('firmware/tests/identity_stubs'), 1);
  includes.splice(includes.indexOf('firmware/tests/storage_stubs'), 0, 'firmware/tests/esp_runtime_stubs', 'firmware/tests/identity_stubs');
  includes.push('firmware/generated', '.dev/tools/mosquitto-2.0.22/include');
}
const inputs = new Set([...sources.filter(name => !path.isAbsolute(name)), core + '/src/ota_internal.h', cjson + '/cJSON.h',
  'firmware/tests/runtime_certificates.py', 'firmware/tests/storage_stubs/sodium.h', 'tests/firmware-native-ota.test.mjs', 'tools/test-firmware-native-ota.mjs', 'package.json']);
if (integration) for (const name of ['firmware/tests/esp_native_install_host.c', 'firmware/tests/esp_runtime_host.c', 'firmware/tests/ota_host_crypto.h',
  'firmware/generated/lamp.h', native + '/src/espidf.c', 'tests/firmware-native-install.test.mjs', 'contracts/examples/ota-firmware.json',
  'contracts/ota-tasks.schema.json', 'packages/protocol/model-validation.mjs', 'packages/protocol/ota-tasks.mjs', 'tests/support/mqtt-probe.mjs',
  'packages/protocol/products.mjs', 'packages/protocol/model-contracts.mjs', 'tools/dev-stack.mjs', 'deploy/nas/device_identity.py',
  'deploy/nas/csr_enrollment.py', 'deploy/dev/config.json', 'Cargo.toml', 'Cargo.lock', 'package-lock.json']) inputs.add(name);
if (integration) for (const folder of ['gateway', 'tools/simulator', 'contracts/models']) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.rs') || entry.name.endsWith('.json') || entry.name === 'Cargo.toml')) {
      inputs.add(path.relative(root, path.join(entry.parentPath, entry.name)));
    }
  }
}
for (const folder of [core + '/include', native + '/include', native + '/src', 'firmware/tests/esp_native_ota_stubs', 'firmware/tests/identity_stubs', ...(integration ? ['firmware/tests/esp_runtime_stubs'] : [])]) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.h')) inputs.add(path.relative(root, path.join(entry.parentPath, entry.name)));
  }
}
const flags = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []),
  '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'];
const mqtt = path.join(root, '.dev/tools/mosquitto-build/lib');
let opensslPackages = process.env.LIMEIOT_OPENSSL_PKG_CONFIG_PATH;
if (integration && !opensslPackages && process.platform === 'darwin') {
  const linked = (await exec('otool', ['-L', path.join(mqtt, 'libmosquitto.2.0.22.dylib')])).stdout;
  const library = linked.match(/^\s*(\/\S*\/libssl\.\d+\.dylib)\s/m)?.[1];
  if (!library) throw new Error('无法核对libmosquitto的OpenSSL ABI');
  opensslPackages = path.join(path.dirname(library), 'pkgconfig');
}
const opensslEnv = { ...process.env, ...(opensslPackages ? { PKG_CONFIG_PATH: opensslPackages } : {}) };
const openssl = (await exec('pkg-config', ['--cflags', '--libs', 'openssl'], { env: opensslEnv })).stdout.trim().split(/\s+/);
const libraryDirectory = (await exec('pkg-config', ['--variable=libdir', 'openssl'], { env: opensslEnv })).stdout.trim();
const external = [...libraries, ...sources.filter(name => path.isAbsolute(name)), ...[
  'components/esp_app_format/include/esp_app_desc.h', 'components/bootloader_support/include/esp_flash_partitions.h',
  'components/bootloader_support/src/bootloader_common_loader.c', 'components/esp_rom/include/esp_rom_crc.h', 'components/esp_common/include/esp_types.h',
].map(name => path.join(sdk, name))];
if (process.platform === 'darwin') for (const name of ['libssl.dylib', 'libcrypto.dylib']) external.push(path.join(libraryDirectory, name));
if (integration) external.push(path.join(mqtt, process.platform === 'darwin' ? 'libmosquitto.2.0.22.dylib' : 'libmosquitto.so'),
  process.env.LIMEIOT_MOSQUITTO ?? path.join(root, '.dev/tools/mosquitto-build/src/mosquitto'),
  path.join(root, '.dev/tools/mosquitto-2.0.22/include/mosquitto.h'), path.join(root, '.dev/tools/mosquitto-2.0.22/include/mqtt_protocol.h'), process.execPath);
async function digests(files) {
  return Object.fromEntries(await Promise.all([...files].sort().map(async name => [name,
    createHash('sha256').update(await readFile(path.isAbsolute(name) ? name : path.join(root, name))).digest('hex')])));
}
const sourceDigests = await digests(inputs), externalDigests = await digests(external), binary = path.join(directory, integration ? 'esp-native-install-host' : 'esp-native-ota-host');
try {
  let compiling = sources, extra = [], defines = [];
  if (integration) {
    const provider = path.join(directory, 'native-provider.o');
    const built = await exec(process.env.CC ?? 'clang', [...flags, ...includes.filter(name => name !== 'firmware/tests/esp_runtime_stubs').map(name => '-I' + name),
      '-Dli_espidf_ota_stage=li_test_native_stage', '-Dli_esp_ota_activate=li_test_native_activate', '-Dli_esp_ota_observe=li_test_native_observe',
      '-c', native + '/src/ota_transfer.c', '-o', provider], { cwd: root, timeout: 60000 });
    await writeFile(path.join(directory, 'provider-compile.log'), built.stdout + built.stderr);
    compiling = sources.filter(name => ![native + '/src/ota_transfer.c', 'firmware/tests/esp_native_ota_host.c'].includes(name));
    compiling.push('firmware/tests/esp_native_install_host.c');
    defines = ['-DLI_ESP_INSTALL_HOST', '-DLI_ESP_NATIVE_INSTALL_HOST'];
    extra = [provider, '-L' + mqtt, '-lmosquitto', '-Wl,-rpath,' + mqtt];
  }
  const result = await exec(process.env.CC ?? 'clang', [...flags, ...defines, ...includes.map(name => '-I' + name), ...compiling, ...libraries, ...extra, ...openssl, '-lm', '-o', binary], { cwd: root, timeout: 60000 });
  await writeFile(path.join(directory, 'compile.log'), result.stdout + result.stderr);
} catch (error) { await writeFile(path.join(directory, 'compile.log'), (error.stdout ?? '') + (error.stderr ?? '')); throw error; }
const info = {
  sdk_revision: revision, source_sha256: sourceDigests, external_sha256: externalDigests, binary_sha256: (await digests([binary]))[binary],
  sanitizers: ['address', 'undefined'], production_native_stage: true, production_native_activation: true, production_native_observer: true,
  production_credential_window: true, sdk_psa_and_crc: true, sdk_descriptor_and_otadata_types: true,
  fixtures: ['openssl-https-api-bridge', 'file-partitions', 'native-image-verifier', 'scripted-boot-selection-and-metadata'],
  production_worker: integration, installation_consumer: integration, esp_mqtt_runtime: false, actual_installation: false, hardware: false,
};
if (integration) info.fixtures.push('freertos-queue-task', 'file-backed-nvs', 'libmosquitto-openssl-mqtt', 'openssl-firmware-signature', 'restart-request');
const integrationArtifacts = ['target/debug/limeiot-gateway', 'target/debug/limeiot-simulator'];
async function unchanged() {
  if (JSON.stringify(await digests(inputs)) !== JSON.stringify(sourceDigests) || JSON.stringify(await digests(external)) !== JSON.stringify(externalDigests)
    || (await digests([binary]))[binary] !== info.binary_sha256) throw new Error('源码/依赖/宿主制品变化，拒绝归档为当前通过');
  if (info.integration_artifact_sha256 && JSON.stringify(await digests(integrationArtifacts)) !== JSON.stringify(info.integration_artifact_sha256)) {
    throw new Error('网关或模拟器制品变化，拒绝归档为当前通过');
  }
}
await unchanged(); await writeFile(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
if (!process.argv.includes('--build-only')) {
  if (integration) {
    try {
      const built = await exec('cargo', ['build', '--locked', '-p', 'limeiot-gateway', '-p', 'limeiot-simulator'], { cwd: root, timeout: 120000 });
      await writeFile(path.join(directory, 'gateway-build.log'), built.stdout + built.stderr);
    } catch (error) { await writeFile(path.join(directory, 'gateway-build.log'), (error.stdout ?? '') + (error.stderr ?? '')); throw error; }
    info.integration_artifact_sha256 = await digests(integrationArtifacts);
    await unchanged(); await writeFile(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  }
  const groups = integration ? ['normal', 'transfer', 'activation'] : ['provider'];
  const reports = [];
  for (const group of groups) {
  const pointer = path.join(directory, 'results-source.json');
  try {
    const result = await exec(process.execPath, ['--test', '--test-concurrency=1', integration ? 'tests/firmware-native-install.test.mjs' : 'tests/firmware-native-ota.test.mjs'], {
      cwd: root, timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, LIMEIOT_NATIVE_OTA_BINARY: binary, LIMEIOT_NATIVE_OTA_RESULTS: pointer, LIMEIOT_NATIVE_INSTALL_GROUP: group },
    });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    await writeFile(path.join(directory, integration ? group + '-test.log' : 'test.log'), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(path.join(directory, integration ? group + '-test.log' : 'test.log'), (error.stdout ?? '') + (error.stderr ?? ''));
    process.stdout.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error;
  }
  await unchanged();
  const reportPath = JSON.parse(await readFile(pointer, 'utf8')).report;
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.status !== 'passed') throw new Error('原生提供方报告尚未通过');
  reports.push({ ...report, source_report: path.relative(root, reportPath), source_report_sha256: (await digests([reportPath]))[reportPath] });
  }
  const result = integration ? { status: 'passed', scope: 'production-worker-consumer-native-provider-integration', groups: reports,
    cases: reports.reduce((count, report) => count + report.cases.length, 0) } : reports[0];
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ...result, build_info: info, build_inputs_and_binary_match: true }, null, 2) + '\n');
}
