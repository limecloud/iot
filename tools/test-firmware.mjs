import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result;
}
run('python3', ['tools/bootstrap-firmware.py']);
run('python3', ['firmware/tools/generate-bindings.py', '--check']);
const cjson = '.dev/firmware-tools/cjson-1.7.19';
const directory = path.join(root, '.dev/firmware-host'); fs.mkdirSync(directory, { recursive: true });
const options = spawnSync('pkg-config', ['--cflags', '--libs', 'openssl'], { encoding: 'utf8' });
if (options.status !== 0) throw new Error('OpenSSL development headers and pkg-config are required for host checks');
const core = 'firmware/components/limeiot_core';
const compiler = process.env.CC ?? 'clang';
const common = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE'] : []), '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g', '-I' + core + '/include', '-I' + core + '/src', '-Ifirmware/generated', '-I' + cjson, core + '/src/core.c', core + '/src/codec.c', core + '/src/ota_auth.c', core + '/src/ota_policy.c', core + '/src/ota_log.c', core + '/src/ota_device.c', core + '/src/ota_transfer.c', cjson + '/cJSON.c'];
const crypto = options.stdout.trim().split(/\s+/);
run(compiler, [...common, 'firmware/tests/core_test.c', ...crypto, '-lm', '-o', path.join(directory, 'core-checks')]);
run(path.join(directory, 'core-checks'), []);
if (!fs.existsSync(path.join(root, '.dev/tools/mosquitto-build/CMakeCache.txt'))) throw new Error('Run python3 tools/bootstrap-broker.py before firmware MQTT checks');
run('cmake', ['--build', '.dev/tools/mosquitto-build', '--target', 'libmosquitto', '-j', '4']);
const library = path.join(root, '.dev/tools/mosquitto-build/lib');
run(compiler, [...common, 'firmware/tests/host_device.c', '-I.dev/tools/mosquitto-2.0.22/include', '-L' + library, '-lmosquitto', '-Wl,-rpath,' + library, ...crypto, '-lm', '-o', path.join(directory, 'host-device')]);
run(process.execPath, ['--test', 'tests/firmware.test.mjs', 'tests/firmware-ota-device.test.mjs']);
