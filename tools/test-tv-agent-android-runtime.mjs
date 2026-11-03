// 专用AVD/ADB与测试APK；不连接、安装或操作用户电视和手机。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import path from 'node:path';
import { root, freePort, startStack, stop, until } from './dev-stack.mjs';

assert.ok(process.argv.slice(2).every(argument => argument === '--boot-only'), 'only --boot-only is supported');
const bootOnly = process.argv.includes('--boot-only');
const directory = path.join(root, '.dev', 'tv-agent-android-runtime-' + randomUUID());
await mkdir(directory, { mode: 0o700 });
const sdk = path.resolve(process.env.ANDROID_HOME ?? path.join(root, '.dev/android-toolchain/sdk'));
assert.ok(process.env.JAVA_HOME && path.isAbsolute(process.env.JAVA_HOME), 'JAVA_HOME must point to JDK 21');
const adb = path.join(sdk, 'platform-tools/adb'), emulator = path.join(sdk, 'emulator/emulator');
const name = 'limeiot_tv_' + randomUUID().replaceAll('-', ''), adbPort = await freePort();
const appId = 'run.limeai.iot.television', fixtureId = appId + '.test';
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
  ANDROID_USER_HOME: path.join(directory, 'android-user'), ANDROID_EMULATOR_HOME: path.join(directory, 'emulator-home'),
  ANDROID_AVD_HOME: path.join(directory, 'avds'), ANDROID_ADB_SERVER_PORT: String(adbPort),
  ADB_SERVER_SOCKET: `tcp:127.0.0.1:${adbPort}`,
  LIMEIOT_MODEL_VALIDATOR: process.env.LIMEIOT_MODEL_VALIDATOR ?? path.join(root, 'target/debug/limeiot-model-validator') };
for (const key of ['ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME', 'ANDROID_AVD_HOME']) await mkdir(env[key]);
const report = { passed: false, hardware: false, hardware_acceptance: 'skipped_by_user', native_app_runtime: false,
  mode: bootOnly ? 'boot_diagnostic' : 'android_runtime',
  tv_agent: true, android_api_23: false, television_system_image: false, physical_same_device_proven: false,
  same_device_adb_coexistence: false, full_goal_completed: false, phases: [], checks: [] };
let stack, virtualDevice, instrumentationChild, adbStarted = false, targetOwned = false;
function launch(command, args, log, { input, timeout = 180000, cwd = root } = {}) {
  const started = performance.now(); let timedOut = false;
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes));
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      try {
        const stdout = Buffer.concat(output), stderr = Buffer.concat(errors);
        if (log) await writeFile(path.join(directory, log), Buffer.concat([stdout, stderr]));
        resolve({ code, signal, timed_out: timedOut, duration_ms: Math.round(performance.now() - started), stdout, stderr });
      } catch (error) { reject(error); }
    });
  }).finally(() => clearTimeout(timer));
  result.catch(() => {});
  return { child, result };
}
async function run(command, args, log, options = {}) {
  const result = await launch(command, args, log, options).result;
  if (!options.allowFailure) assert.equal(result.code, 0, `${log ?? path.basename(command)} failed; see private evidence`);
  return result;
}
async function portAvailable(port) {
  const server = net.createServer();
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve)); return true; }
  catch { return false; } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
let serial;
const adbArgs = args => ['-P', String(adbPort), '-s', serial, ...args];
const adbCall = (args, log, options) => run(adb, adbArgs(args), log, options);
const readPrivate = (file, packageName = appId) => adbCall(['exec-out', 'run-as', packageName, 'cat', 'files/' + file], null, { allowFailure: true, timeout: 4000 });
async function phase(value) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (instrumentationChild?.exitCode !== null && instrumentationChild?.exitCode !== undefined) throw new Error('instrumentation exited before phase');
    if ((await readPrivate('runtime-phase')).stdout.toString() === value) return;
    await delay(100);
  }
  throw new Error(`instrumentation phase timeout: ${value}`);
}
async function signal(value) {
  await adbCall(['shell', `run-as ${appId} sh -c 'cat > files/runtime-signal'`], null, { input: value });
}
async function effects() {
  const result = await readPrivate('runtime-launches.jsonl', fixtureId);
  if (result.code !== 0) return [];
  return result.stdout.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
}
function instrumentation(testClass, log) {
  const launched = launch(adb, adbArgs(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class',
    `run.limeai.iot.television.${testClass}`, fixtureId + '/androidx.test.runner.AndroidJUnitRunner']), log, { timeout: 180000 });
  instrumentationChild = launched.child;
  return launched.result;
}
function passed(result, count) {
  assert.equal(result.code, 0);
  assert.match(result.stdout.toString(), new RegExp(`OK \\(${count} tests?\\)`), 'instrumentation must pass every assertion');
}
async function startOwnedEmulator(consolePort) {
  report.stage = 'avd_creation';
  await run(path.join(sdk, 'cmdline-tools/latest/bin/avdmanager'), ['create', 'avd', '--name', name,
    '--package', 'system-images;android-36;google_apis;arm64-v8a', '--device', 'pixel_7', '--path', path.join(env.ANDROID_AVD_HOME, name + '.avd')],
    'avd-create.log', { input: 'no\n' });
  report.stage = 'adb_server_start';
  await run(adb, ['-P', String(adbPort), 'start-server'], 'adb-start.log'); adbStarted = true;
  virtualDevice = spawn(emulator, ['-avd', name, '-port', String(consolePort), '-no-window', '-no-audio', '-no-boot-anim',
    '-no-snapshot', '-gpu', 'auto', '-memory', '4096', '-cores', '4', '-no-metrics'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  report.emulator_resources = { memory_mib: 4096, cores: 4 };
  report.emulator_target = { serial, avd: name, adb_port: adbPort, console_port: consolePort };
  let emulatorError;
  virtualDevice.once('error', error => { emulatorError = error.message; });
  const emulatorLog = createWriteStream(path.join(directory, 'emulator.log'));
  virtualDevice.stdout.pipe(emulatorLog); virtualDevice.stderr.pipe(emulatorLog); virtualDevice.once('close', () => emulatorLog.end());
  report.stage = 'emulator_ownership_and_boot';
  const started = performance.now(), deadline = started + 180000;
  report.boot_timeout_ms = 180000; report.boot_probe_count = 0;
  async function probe(args) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return { error: 'boot_budget_exhausted' };
    try {
      const result = await adbCall(args, null, { allowFailure: true, timeout: Math.min(4000, remaining) });
      return { code: result.code, signal: result.signal, timed_out: result.timed_out, duration_ms: result.duration_ms,
        stdout: result.stdout.toString().trim().slice(0, 1024), stderr: result.stderr.toString().trim().slice(0, 1024) };
    } catch (error) { return { error: error.message }; }
  }
  while (performance.now() < deadline) {
    const sample = { elapsed_ms: Math.round(performance.now() - started),
      boot: await probe(['shell', 'getprop', 'sys.boot_completed']) };
    if (!targetOwned && sample.boot.code === 0) {
      sample.qemu = await probe(['shell', 'getprop', 'ro.kernel.qemu']);
      sample.owner = await probe(['emu', 'avd', 'name']);
      targetOwned = sample.qemu.code === 0 && sample.qemu.stdout === '1'
        && sample.owner.code === 0 && sample.owner.stdout.split('\n')[0].trim() === name;
    }
    sample.target_owned = targetOwned;
    sample.emulator_exit_code = virtualDevice.exitCode; sample.emulator_signal = virtualDevice.signalCode;
    if (emulatorError) sample.emulator_error = emulatorError;
    report.boot_probe = sample; report.boot_probe_count++;
    await appendFile(path.join(directory, 'boot-probes.jsonl'), JSON.stringify(sample) + '\n');
    if (emulatorError || virtualDevice.exitCode !== null || virtualDevice.signalCode) throw new Error('owned_emulator_exited_before_ready');
    if (targetOwned && sample.boot.code === 0 && !sample.boot.timed_out && sample.boot.stdout === '1' && performance.now() <= deadline) {
      assert.equal((await adbCall(['shell', 'getprop', 'ro.kernel.qemu'])).stdout.toString().trim(), '1');
      assert.equal((await adbCall(['emu', 'avd', 'name'])).stdout.toString().split('\n')[0].trim(), name);
      report.serial = serial; report.avd = name;
      report.boot_elapsed_ms = Math.round(performance.now() - started);
      report.api_level = (await adbCall(['shell', 'getprop', 'ro.build.version.sdk'])).stdout.toString().trim();
      report.abi = (await adbCall(['shell', 'getprop', 'ro.product.cpu.abi'])).stdout.toString().trim();
      return;
    }
    await delay(Math.max(0, Math.min(100, deadline - performance.now())));
  }
  throw new Error('owned_emulator_boot_timeout; see boot-probes.jsonl');
}
try {
  await Promise.all([access(adb), access(emulator), access(path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a/package.xml'))]);
  report.emulator_properties = await readFile(path.join(sdk, 'emulator/source.properties'), 'utf8');
  report.system_image_properties = await readFile(path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a/source.properties'), 'utf8');
  let consolePort;
  for (let port = 5560; port < 5680; port += 2) if (await portAvailable(port) && await portAvailable(port + 1)) { consolePort = port; break; }
  assert.ok(consolePort, 'no isolated emulator port available'); serial = `emulator-${consolePort}`;
  // 先证明独立系统可启动，再创建业务栈和编译APK；避免把两阶段资源开销混入启动定位。
  await startOwnedEmulator(consolePort);
  if (bootOnly) {
    report.checks.push('owned_isolated_avd_boot_only');
    report.stage = 'boot_diagnostic_passed'; report.passed = true;
  } else {
    report.stage = 'device_materials_and_stack';
    const modelPath = path.join(root, 'contracts/models/android-tv-agent.json');
    const model = JSON.parse((await run(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], 'model.log', { timeout: 5000 })).stdout);
    assert.equal(model.valid, true);
    const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
    config.models[0] = model.normalized_model; config.devices[0].model_revision = model.model_revision;
    delete config.devices[0].routes;
    const configFile = path.join(directory, 'config/gateway.json'); await mkdir(path.dirname(configFile));
    await writeFile(configFile, JSON.stringify(config));
    await run('python3', ['-c', 'import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")', directory], 'identity.log');
    const tlsPort = await freePort(), assets = path.join(directory, 'test-assets'); await mkdir(assets, { mode: 0o700 });
    await run('python3', ['tools/tv-agent-enrollment.py', '--identity-directory', path.join(directory, 'credentials'),
      '--broker', `ssl://127.0.0.1:${tlsPort}`, '--output', path.join(assets, 'enrollment.json')], 'enrollment.log');
    stack = await startStack({ directory, modelPaths: { lamp: modelPath }, gatewayEnv: { LIMEIOT_CONFIG: configFile }, brokerTls: {
      port: tlsPort, ca: path.join(directory, 'broker-tls/ca.crt'), certificate: path.join(directory, 'broker-tls/server.crt'), key: path.join(directory, 'broker-tls/server.key') } });
    await stop(stack.lamp);
    report.stage = 'android_apk_build';
    await run('sh', ['apps/tv-agent/gradlew', '--no-daemon', '-p', 'apps/tv-agent', `-Plimeiot.runtimeAssets=${assets}`,
      ':app:assembleDebug', ':app:assembleDebugAndroidTest'], 'build.log', { timeout: 900000 });
    const app = path.join(root, 'apps/tv-agent/app/build/outputs/apk/debug/app-debug.apk');
    const tests = path.join(root, 'apps/tv-agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
    report.apk_sha256 = createHash('sha256').update(await readFile(app)).digest('hex');
    report.test_apk_sha256 = createHash('sha256').update(await readFile(tests)).digest('hex');
    await run('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as app,zipfile.ZipFile(sys.argv[2]) as tests:\n assert "assets/enrollment.json" not in app.namelist()\n assert "assets/enrollment.json" in tests.namelist()\nprint("test credentials are confined to the isolated instrumentation APK")', app, tests], 'apk-boundary.log');
    await copyFile(app, path.join(directory, 'tv-agent-debug.apk')); await copyFile(tests, path.join(directory, 'tv-agent-runtime-tests.apk'));
    report.stage = 'app_installation';
    await adbCall(['reverse', `tcp:${tlsPort}`, `tcp:${tlsPort}`], 'reverse.log');
    await adbCall(['install', app], 'app-install.log'); await adbCall(['install', tests], 'tests-install.log');
    // 对安装后的测试目标显式AOT，隔离debug/test大类库首次验证；冷启动ANR另行保留。
    report.stage = 'app_aot_compilation';
    for (const packageName of [appId, fixtureId]) {
      const compiled = await adbCall(['shell', 'cmd', 'package', 'compile', '-m', 'speed', '-f', packageName],
        packageName === appId ? 'app-aot.log' : 'tests-aot.log');
      assert.match(compiled.stdout.toString(), /Success/);
    }
    report.compilation_profile = 'installed_app_and_instrumentation_aot_speed';
    report.stage = 'security_instrumentation';
    passed(await instrumentation('AgentSecurityRuntimeTest', 'security.log'), 2);
    report.phases.push({ name: 'real_keystore_and_hostname', tests: 2, passed: true });
    report.stage = 'service_and_application_journey';
    const journey = instrumentation('AgentJourneyRuntimeTest', 'journey.log');
    await phase('ready');
    const base = '/api/v1/spaces/space-demo', devicePath = base + '/devices/device-lamp';
    await until(async () => (await stack.request(devicePath)).value.ready);
    const boot = (await stack.request(devicePath)).value.boot_id;
    async function command(key, status) {
      const response = await stack.request(base + '/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ device_id: 'device-lamp', model_revision: model.model_revision, expires_at: new Date(Date.now() + 12000).toISOString(),
          operation: { type: 'action.invoke', path: 'apps.launch', value: { application_id: fixtureId } } }) });
      assert.equal(response.status, 202, JSON.stringify(response.value));
      await until(async () => (await stack.request(base + '/commands/' + response.value.command_id)).value.status === status);
      return response.value.command_id;
    }
    report.commands = [await command('actual-android-launch', 'confirmed')];
    await until(async () => (await effects()).length === 1);
    report.commands.push(await command('actual-android-background', 'failed'));
    assert.equal((await effects()).length, 1);
    await signal('foreground'); await phase('revoked');
    report.commands.push(await command('actual-android-revoked', 'failed'));
    assert.equal((await effects()).length, 1);
    await signal('stop'); await phase('stopped'); passed(await journey, 1);
    report.phases.push({ name: 'actual_service_mtls_sqlite_and_leanback', tests: 1, passed: true });
    await adbCall(['shell', 'am', 'force-stop', appId]);
    assert.equal((await adbCall(['shell', 'pidof', appId], null, { allowFailure: true })).stdout.toString().trim(), '');
    report.stage = 'fresh_process_restore';
    passed(await instrumentation('AgentResumeRuntimeTest', 'resume.log'), 1);
    assert.equal((await readPrivate('runtime-phase')).stdout.toString(), 'restored');
    assert.equal((await stack.request(devicePath)).value.boot_id, boot);
    assert.equal((await effects()).length, 1);
    const commands = (await stack.request(base + '/commands')).value.items;
    assert.equal(commands.length, 3); assert.equal(commands.filter(item => item.status === 'confirmed').length, 1);
    const database = (await adbCall(['exec-out', 'run-as', appId, 'cat', 'databases/tv-agent.db'])).stdout;
    assert.equal(database.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), false);
    assert.equal(database.includes(Buffer.from('-----BEGIN CERTIFICATE-----')), false);
    await writeFile(path.join(directory, 'device-sqlite.db'), database);
    report.phases.push({ name: 'fresh_process_keystore_and_journal_restore', tests: 1, passed: true });
    report.checks.push('owned_isolated_avd_and_adb', 'actual_android_keystore_nonexportable_aes_gcm',
      'test_credentials_only_in_instrumentation_apk',
      'wrong_aad_and_modified_ciphertext_rejected', 'reachable_wrong_tls_hostname_rejected', 'actual_device_mtls_and_gateway_session',
      'actual_private_sqlite_full_sync_and_result_retirement', 'actual_leanback_target_started_once', 'background_and_revoke_zero_extra_launches',
      'fresh_process_recovers_credentials_and_journal_without_reconnecting_or_replaying', 'no_pem_plaintext_in_private_sqlite');
    report.native_app_runtime = true; report.passed = true;
    report.stage = 'passed';
  }
} catch (error) {
  report.error = error.message;
  if (targetOwned && adbStarted) {
    await adbCall(['logcat', '-b', 'crash', '-d', '-v', 'brief'], 'crash.log', { allowFailure: true, timeout: 10000 }).catch(() => {});
    await adbCall(['shell', 'dumpsys', 'activity', 'exit-info', appId], 'process-exit.log', { allowFailure: true, timeout: 10000 }).catch(() => {});
    await adbCall(['logcat', '-d', '-v', 'brief'], 'logcat.log', { allowFailure: true, timeout: 10000 }).catch(() => {});
  }
  throw error;
} finally {
  await stop(instrumentationChild); await stop(virtualDevice); await stack?.close();
  if (adbStarted) await run(adb, ['-P', String(adbPort), 'kill-server'], 'adb-stop.log', { allowFailure: true });
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, report: path.relative(root, path.join(directory, 'report.json')) }) + '\n');
}
