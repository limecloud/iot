import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack } from './dev-stack.mjs';
import { compileComposition, planComposition } from '../packages/protocol/composition.mjs';

const selected = process.argv[2];
if (selected && !['fixture', 'ios', 'android'].includes(selected)) throw new Error('select fixture, ios or android');
const directory = path.join(root, '.dev/composition-native-20261105');
await mkdir(directory, { recursive: true });
const fixture = path.join(root, 'tests/fixtures/compositions/online.json');
const env = { ...process.env, LIMEIOT_COMPOSITION_FIXTURE: fixture, LIMEIOT_VOICE_TEST_CLASSPATH: path.join(directory, 'android-classpath.txt') };
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 600000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 605000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (timedOut || code !== 0) throw new Error(`${command} ${timedOut ? 'timed out' : `exited ${code}`}`);
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
}
async function capture() {
  const stack = await startStack();
  try {
    const source = await readFile(path.join(root, 'examples/compositions/reading-companion/package.json'), 'utf8');
    const bindings = { touch: 'device-button', light: 'device-lamp' };
    const compiled = await compileComposition(source, JSON.stringify(bindings), 'native-reading');
    const request = async (url, body) => {
      const result = await stack.request(url, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {});
      assert.equal(result.status, 200); return result.value;
    };
    const plan = await planComposition(compiled, { request, origin: stack.env.LIMEIOT_ENDPOINT, space: 'space-demo' });
    const base = '/api/v1/spaces/space-demo';
    assert.equal((await request(base + '/commands')).items.length, 0);
    assert.equal((await request(base + '/rule-deployments')).items.length, 0);
    const devices = (await request(base + '/devices')).items;
    const deployment = await request(base + '/rule-deployments', compiled.rule);
    assert.equal(deployment.revision, compiled.rule_revision);
    await writeFile(fixture, JSON.stringify({ package_text: source, bindings, instance_id: 'native-reading', devices, validation: plan.validation, simulation: plan.simulation, deployment }, null, 2) + '\n');
  } finally { await stack.close(); }
}
const report = { passed: false, real_gateway_fixture: false, ios: false, android: false, native_app_runtime: false, hardware: false, full_goal_completed: false };
try {
  const source = await readFile(path.join(root, 'examples/compositions/reading-companion/package.json'), 'utf8');
  for (const file of ['apps/ios/Sources/LimeIoTKit/Resources/reading-companion.json', 'apps/android/core/src/main/resources/limeiot/reading-companion.json']) assert.equal(await readFile(path.join(root, file), 'utf8'), source);
  if (!selected || selected === 'fixture') { await capture(); report.real_gateway_fixture = true; }
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    const executable = path.join(directory, 'ios-composition-online-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/CompositionStore.swift', 'Checks/CompositionOnlineChecks.swift', 'Checks/CompositionLiveChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, [], ios);
    const offline = path.join(directory, 'ios-composition-contract-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'Checks/CompositionChecks.swift', ...objects, '-o', offline], ios);
    await run(offline, [path.join(root, 'tests/fixtures/compositions/contract.json')], ios);
    await run('swiftc', ['-frontend', '-parse', 'App/CompositionViews.swift', 'App/Views.swift'], ios);
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.ios = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':core:test', '--tests', 'run.limeai.iot.core.CompositionTest', '--tests', 'run.limeai.iot.core.CompositionClientTest', '--tests', 'run.limeai.iot.core.GatewayClientTest'], path.join(root, 'apps/android'));
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', '--init-script', path.join(root, 'tools/voice-turn-native.gradle'), ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.CompositionControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
    for (const [module, task, name, count] of [['core', 'test', 'CompositionTest', 3], ['core', 'test', 'CompositionClientTest', 7], ['core', 'test', 'GatewayClientTest', 4], ['app', 'testDebugUnitTest', 'CompositionControllerTest', 3], ['app', 'testDebugUnitTest', 'HomeViewModelTest', 6]]) {
      const suite = `run.limeai.iot.${module === 'core' ? 'core.' : ''}${name}`;
      const xml = await readFile(path.join(root, `apps/android/${module}/build/test-results/${task}/TEST-${suite}.xml`), 'utf8');
      const header = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      assert.equal(Number(header.match(/\btests="(\d+)"/)?.[1]), count, suite);
      for (const key of ['failures', 'errors', 'skipped']) assert.match(header, new RegExp(`\\b${key}="0"`));
      await writeFile(path.join(directory, `TEST-${suite}.xml`), xml);
    }
    report.android = true;
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, `${selected ?? 'all'}-report.json`), JSON.stringify(report, null, 2) + '\n'); }
