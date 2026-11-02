// 独立AVD/ADB、实际Android App、真实HTTPS与MQTT模拟设备；不连接手机。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from './dev-stack.mjs';

const directory = path.join(root, '.dev', 'android-runtime-' + crypto.randomUUID());
await mkdir(directory, { mode: 0o700 });
const sdk = path.resolve(process.env.ANDROID_HOME ?? path.join(root, '.dev/android-toolchain/sdk'));
const java = process.env.JAVA_HOME;
assert.ok(java && path.isAbsolute(java), 'JAVA_HOME must point to an existing JDK 21');
const adb = path.join(sdk, 'platform-tools/adb'), emulator = path.join(sdk, 'emulator/emulator');
const avdName = 'limeiot_' + crypto.randomUUID().replaceAll('-', '');
const adbPort = await freePort();
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
  ANDROID_USER_HOME: path.join(directory, 'android-user'), ANDROID_EMULATOR_HOME: path.join(directory, 'emulator-home'),
  ANDROID_AVD_HOME: path.join(directory, 'avds'), ANDROID_ADB_SERVER_PORT: String(adbPort),
  ADB_SERVER_SOCKET: `tcp:127.0.0.1:${adbPort}` };
for (const key of ['ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_AVD_HOME']) await mkdir(env[key], { recursive: true });
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user', native_app_runtime: false,
  production_published: false, platform: 'android', avd: avdName, phases: [], checks: [] };
let virtualDevice, stack, edge, adbStarted = false;
async function run(command, args, name, { input, binary = false, allowFailure = false, timeout = 180000, cwd = root } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  let code;
  try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
  const output = Buffer.concat(stdout), errors = Buffer.concat(stderr);
  if (name) await writeFile(path.join(directory, name), binary ? errors : Buffer.concat([output, errors]));
  if (!allowFailure && code !== 0) throw new Error(`${name ?? path.basename(command)} failed; see private runtime evidence`);
  return { code, stdout: binary ? output : output.toString(), stderr: errors.toString() };
}
async function available(port) {
  const server = net.createServer();
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve)); return true; }
  catch { return false; } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
try {
  await Promise.all([access(adb), access(emulator), access(path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a/package.xml'))]);
  report.emulator_properties = (await readFile(path.join(sdk, 'emulator/source.properties'), 'utf8')).trim();
  report.system_image_properties = (await readFile(path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a/source.properties'), 'utf8')).trim();
  let consolePort;
  for (let port = 5560; port < 5680; port += 2) if (await available(port) && await available(port + 1)) { consolePort = port; break; }
  assert.ok(consolePort, 'no isolated emulator port available');
  const serial = `emulator-${consolePort}`;
  const adbCall = (args, name, options) => run(adb, ['-P', String(adbPort), '-s', serial, ...args], name, options);
  const tlsPort = await freePort(), origin = `https://10.0.2.2:${tlsPort}`, control = randomBytes(32).toString('hex');
  const state = path.join(directory, 'nas');
  await run('python3', ['deploy/nas/manage.py', 'init', '--directory', state, '--origin', origin], 'nas-init.log');
  stack = await startStack({ directory: path.join(directory, 'stack') });
  await stop(stack.gateway);
  stack.gateway = stack.launch('gateway-https', path.join(root, 'target/debug/limeiot-gateway'), [], { LIMEIOT_PUBLIC_ORIGIN: origin });
  const internal = new URL(stack.env.LIMEIOT_ENDPOINT), authority = new URL(origin).host;
  await until(() => new Promise(resolve => {
    const call = httpRequest(new URL('/healthz', internal), { headers: { Host: authority }, timeout: 2000 }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode === 200));
    });
    call.on('error', () => resolve(false)); call.on('timeout', () => call.destroy()); call.end();
  }));
  const counters = { apiRequests: 0, loginPosts: 0, commandPosts: 0 }; let offline = false;
  report.counters = counters;
  report.http_trace = [];
  edge = httpsServer({ key: await readFile(path.join(state, 'tls/server.key')), cert: await readFile(path.join(state, 'tls/server.crt')) }, async (req, res) => {
    res.once('finish', () => report.http_trace.push({ method: req.method, path: req.url, status: res.statusCode }));
    if (req.url === '/__fixture') {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${control}`) { res.writeHead(403).end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const action = JSON.parse(Buffer.concat(chunks)).action;
      if (action === 'offline') offline = true; else if (action === 'online') offline = false;
      else if (action !== 'stats') { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(counters)); return;
    }
    counters.apiRequests++;
    if (req.method === 'POST' && req.url === '/api/v1/auth/session') counters.loginPosts++;
    if (req.method === 'POST' && /^\/api\/v1\/spaces\/[^/]+\/commands$/.test(req.url)) counters.commandPosts++;
    if (offline) { res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":{"code":"fixture_offline"}}'); return; }
    const upstream = httpRequest(new URL(req.url, internal), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  // 与NAS反向代理相同的空闲窗口，避免Node默认5秒连接关闭干扰前后台检查。
  edge.keepAliveTimeout = 75000;
  edge.listen(tlsPort, '127.0.0.1'); await once(edge, 'listening');
  const resources = path.join(directory, 'debug-res');
  await mkdir(path.join(resources, 'raw'), { recursive: true }); await mkdir(path.join(resources, 'xml'));
  await copyFile(path.join(state, 'authority/ca.crt'), path.join(resources, 'raw/limeiot_runtime_ca.pem'));
  await writeFile(path.join(resources, 'xml/network_security_config.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/><certificates src="user"/></trust-anchors></base-config><debug-overrides><trust-anchors><certificates src="@raw/limeiot_runtime_ca"/></trust-anchors></debug-overrides></network-security-config>\n');
  await run('sh', ['gradlew', '--no-daemon', `-Plimeiot.instrumentationResources=${resources}`,
    ':app:assembleDebug', ':app:assembleDebugAndroidTest'], 'android-build.log', { cwd: path.join(root, 'apps/android'), timeout: 900000 });
  const app = path.join(root, 'apps/android/app/build/outputs/apk/debug/app-debug.apk');
  const tests = path.join(root, 'apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
  report.apk_sha256 = createHash('sha256').update(await readFile(app)).digest('hex');
  await copyFile(app, path.join(directory, 'app-runtime-debug.apk'));
  await copyFile(tests, path.join(directory, 'app-runtime-test.apk'));
  await run(path.join(sdk, 'cmdline-tools/latest/bin/avdmanager'), ['create', 'avd', '--name', avdName,
    '--package', 'system-images;android-36;google_apis;arm64-v8a', '--device', 'pixel_7',
    '--path', path.join(directory, 'avds', avdName + '.avd')], 'avd-create.log', { input: 'no\n' });
  await run(adb, ['-P', String(adbPort), 'start-server'], 'adb-start.log'); adbStarted = true;
  virtualDevice = spawn(emulator, ['-avd', avdName, '-port', String(consolePort), '-no-window', '-no-audio',
    '-no-boot-anim', '-no-snapshot', '-gpu', 'auto', '-memory', '4096', '-cores', '4', '-no-metrics'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const emulatorLog = createWriteStream(path.join(directory, 'emulator.log'));
  virtualDevice.stdout.pipe(emulatorLog); virtualDevice.stderr.pipe(emulatorLog);
  virtualDevice.once('exit', () => emulatorLog.end());
  await until(async () => {
    const result = await adbCall(['shell', 'getprop', 'sys.boot_completed'], null, { allowFailure: true, timeout: 4000 });
    return result.stdout.trim() === '1';
  }, 180000);
  assert.equal((await adbCall(['shell', 'getprop', 'ro.kernel.qemu'])).stdout.trim(), '1');
  assert.equal((await adbCall(['emu', 'avd', 'name'])).stdout.split('\n')[0].trim(), avdName);
  report.serial = serial;
  report.android_release = (await adbCall(['shell', 'getprop', 'ro.build.version.release'])).stdout.trim();
  report.api_level = (await adbCall(['shell', 'getprop', 'ro.build.version.sdk'])).stdout.trim();
  report.checks.push('owned_isolated_avd_and_adb_only');
  await adbCall(['install', app], 'app-install.log'); await adbCall(['install', tests], 'test-install.log');
  await adbCall(['shell', 'run-as', 'run.limeai.iot', 'mkdir', '-p', 'files']);
  await adbCall(['shell', "run-as run.limeai.iot sh -c 'cat > files/runtime-fixture.json'"], null,
    { input: JSON.stringify({ origin, owner: stack.env.LIMEIOT_TOKEN, control }) });
  for (const [name, testClass, expected] of [['keystore', 'SecureStoreRuntimeTest', 2], ['home', 'HomeRuntimeTest', 1], ['resume', 'HomeResumeRuntimeTest', 1]]) {
    if (name === 'resume') {
      await adbCall(['shell', 'am', 'force-stop', 'run.limeai.iot']);
      assert.equal((await adbCall(['shell', 'pidof', 'run.limeai.iot'], null, { allowFailure: true })).stdout.trim(), '');
    }
    const result = await adbCall(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', `run.limeai.iot.${testClass}`,
      'run.limeai.iot.test/androidx.test.runner.AndroidJUnitRunner'], `${name}-instrumentation.log`, { timeout: 240000 });
    assert.match(result.stdout, new RegExp(`OK \\(${expected} tests?\\)`), `${name} instrumentation did not pass; see evidence`);
    report.phases.push({ name, passed: true, tests: expected });
    if (name === 'home') {
      for (const artifact of ['nas-runtime.json', 'nas-connected.png', 'nas-offline.png']) {
        const value = await adbCall(['exec-out', 'run-as', 'run.limeai.iot', 'cat', `files/${artifact}`], null, { binary: true });
        await writeFile(path.join(directory, artifact), value.stdout);
      }
    }
  }
  for (const name of ['nas-runtime', 'nas-resume']) {
    const value = JSON.parse((await adbCall(['exec-out', 'run-as', 'run.limeai.iot', 'cat', `files/${name}.json`])).stdout);
    assert.equal(value.passed, true); report[name] = value;
  }
  for (const name of ['nas-connected', 'nas-offline', 'nas-restored']) {
    const screenshot = await adbCall(['exec-out', 'run-as', 'run.limeai.iot', 'cat', `files/${name}.png`], null, { binary: true });
    await writeFile(path.join(directory, name + '.png'), screenshot.stdout);
  }
  report.counters = counters;
  assert.equal(counters.loginPosts, 1); assert.equal(counters.commandPosts, 1);
  report.checks.push('actual_android_keystore_encryption_origin_binding_and_corruption_rejection',
    'explicit_debug_ca_real_https_no_cleartext_or_tls_bypass', 'actual_compose_login_and_single_mqtt_device_command',
    'offline_controls_disabled', 'background_has_no_refresh_polling', 'foreground_refresh_resumes',
    'fresh_process_session_restore_without_login_or_command_replay', 'logout_clears_actual_secure_store');
  report.native_app_runtime = true; report.passed = true;
} catch (error) {
  report.error = error.message;
  if (report.serial) {
    const screenshot = await run(adb, ['-P', String(adbPort), '-s', report.serial, 'exec-out', 'screencap', '-p'],
      null, { binary: true, allowFailure: true, timeout: 10000 }).catch(() => null);
    if (screenshot?.code === 0) await writeFile(path.join(directory, 'failure.png'), screenshot.stdout);
    const diagnostics = await run(adb, ['-P', String(adbPort), '-s', report.serial, 'exec-out', 'run-as',
      'run.limeai.iot', 'cat', 'files/nas-login-failure.json'], null, { allowFailure: true, timeout: 10000 }).catch(() => null);
    if (diagnostics?.code === 0) {
      try { report.login_diagnostics = JSON.parse(diagnostics.stdout); } catch { /* 未产生登录诊断时保留原失败。 */ }
    }
    await run(adb, ['-P', String(adbPort), '-s', report.serial, 'logcat', '-b', 'crash', '-d', '-v', 'brief'],
      'crash-logcat.log', { allowFailure: true, timeout: 10000 }).catch(() => null);
    await run(adb, ['-P', String(adbPort), '-s', report.serial, 'shell', 'dumpsys', 'activity', 'exit-info', 'run.limeai.iot'],
      'process-exit.log', { allowFailure: true, timeout: 10000 }).catch(() => null);
    for (const name of ['nas-connected', 'nas-offline', 'nas-login-failure']) {
      const artifact = await run(adb, ['-P', String(adbPort), '-s', report.serial, 'exec-out', 'run-as',
        'run.limeai.iot', 'cat', `files/${name}.png`], null, { binary: true, allowFailure: true, timeout: 10000 }).catch(() => null);
      if (artifact?.code === 0) await writeFile(path.join(directory, `${name}.png`), artifact.stdout);
    }
  }
  throw error;
}
finally {
  edge?.closeAllConnections(); if (edge) await new Promise(resolve => edge.close(resolve));
  await stack?.close();
  if (virtualDevice) await stop(virtualDevice);
  if (adbStarted) await run(adb, ['-P', String(adbPort), 'kill-server'], 'adb-stop.log', { allowFailure: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, hardware: false, report: path.relative(root, path.join(directory, 'report.json')) }) + '\n');
}
