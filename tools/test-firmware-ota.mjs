import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2);
if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== '--idf-path' || !path.isAbsolute(arguments_[1])))
  throw new Error('Optional --idf-path requires an absolute fixed ESP-IDF SDK path');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
run('python3', ['tools/bootstrap-firmware.py']);
run('cargo', ['build', '--locked', '-p', 'limeiot-model-validator', '--bin', 'limeiot-ota']);
const options = spawnSync('pkg-config', ['--cflags', '--libs', 'openssl'], { encoding: 'utf8' });
if (options.status !== 0) throw new Error('OpenSSL development headers and pkg-config are required');
const directory = path.join(root, '.dev/firmware-host'); fs.mkdirSync(directory, { recursive: true });
const common = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []), '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g',
  '-Ifirmware/components/limeiot_core/include', '-I.dev/firmware-tools/cjson-1.7.19',
  'firmware/components/limeiot_core/src/ota_auth.c', '.dev/firmware-tools/cjson-1.7.19/cJSON.c'];
const libraries = [...options.stdout.trim().split(/\s+/), '-lm'];
run(process.env.CC ?? 'clang', [...common, 'firmware/tests/ota_auth_host.c', ...libraries, '-o', path.join(directory, 'ota-auth')]);
run(process.env.CC ?? 'clang', [...common, 'firmware/components/limeiot_core/src/ota_policy.c', 'firmware/tests/ota_policy_host.c', ...libraries, '-o', path.join(directory, 'ota-policy')]);
run(process.env.CC ?? 'clang', [...common, 'firmware/components/limeiot_core/src/ota_policy.c', 'firmware/components/limeiot_core/src/ota_log.c', 'firmware/tests/ota_log_host.c', ...libraries, '-o', path.join(directory, 'ota-log')]);
run(process.env.CC ?? 'clang', [...common, 'firmware/components/limeiot_core/src/ota_policy.c', 'firmware/components/limeiot_core/src/ota_transfer.c', 'firmware/tests/ota_transfer_host.c', ...libraries, '-o', path.join(directory, 'ota-transfer')]);
run(process.env.CC ?? 'clang', [...common, '-Ifirmware/tests/esp_stubs', '-Ifirmware/components/limeiot_espidf/include', 'firmware/components/limeiot_espidf/src/image_health.c', 'firmware/tests/esp_image_health_host.c', ...libraries, '-o', path.join(directory, 'image-health')]);
run(process.execPath, ['--test', 'tests/firmware-ota-auth.test.mjs', 'tests/firmware-ota-policy.test.mjs', 'tests/firmware-ota-config.test.mjs', 'tests/firmware-ota-log.test.mjs', 'tests/firmware-ota-transfer.test.mjs', 'tests/firmware-image-health.test.mjs', 'tests/provisioning.test.mjs']);
if (arguments_.length) run('python3', ['firmware/tests/nvs_policy_roundtrip.py', '--idf-path', arguments_[1]]);
