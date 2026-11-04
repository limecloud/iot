import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev/observation-native-checks');
await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
const report = { passed: false, swift_contract: false, swift_state: false, swift_home_typecheck: false, swiftui_parse: false, android_contract: false, android_state: false, android_apk: false, android_lint: false, native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios');
    await run('swift', ['run', '--package-path', ios, 'ClientChecks'], root, { ...process.env, LIMEIOT_OBSERVATION_CHECK: '1' }); report.swift_contract = true;
    const build = path.join(ios, '.build/debug');
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
    const executable = path.join(directory, 'ios-observation-state');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/ObservationStore.swift', 'App/ZigbeeStore.swift', 'Tests/LimeIoTKitTests/ObservationChecks.swift', 'Checks/ObservationLiveChecks.swift', 'Checks/ObservationStoreChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, []); report.swift_state = true;
    const zigbeeExecutable = path.join(directory, 'ios-zigbee-state');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/ZigbeeStore.swift', 'App/ObservationStore.swift', 'Tests/LimeIoTKitTests/ObservationChecks.swift', 'Checks/ZigbeeLiveChecks.swift', 'Checks/ZigbeeStoreChecks.swift', ...objects, '-o', zigbeeExecutable], ios);
    await run(zigbeeExecutable, []); report.swift_commissioning = true;
    await run('swiftc', ['-swift-version', '6', '-typecheck', '-I', path.join(build, 'Modules'), ...['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'].map(name => `App/${name}.swift`)], ios); report.swift_home_typecheck = true;
    await run('swiftc', ['-frontend', '-parse', 'App/ObservationViews.swift', 'App/ZigbeeViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios); report.swiftui_parse = true;
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios);
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--tests', 'run.limeai.iot.core.ObservationClientTest', '--tests', 'run.limeai.iot.core.GatewayClientTest', '--tests', 'run.limeai.iot.core.OtaClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.ZigbeeControllerTest', '--tests', 'run.limeai.iot.ObservationControllerTest', '--tests', 'run.limeai.iot.VisionControllerTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'), { ...process.env, LIMEIOT_OBSERVATION_FIXTURE: path.join(root, 'tests/fixtures/zigbee/observation-native.json') });
    for (const [module, task, classes] of [['core', 'test', ['run.limeai.iot.core.ObservationClientTest', 'run.limeai.iot.core.GatewayClientTest', 'run.limeai.iot.core.OtaClientTest']], ['app', 'testDebugUnitTest', ['run.limeai.iot.ZigbeeControllerTest', 'run.limeai.iot.ObservationControllerTest', 'run.limeai.iot.VisionControllerTest']]]) {
      for (const name of classes) {
        const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, `TEST-${name}.xml`), 'utf8');
        const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
        if (!/\btests="[1-9][0-9]*"/.test(suite) || !['failures', 'errors', 'skipped'].every(key => new RegExp(`\\b${key}="0"`).test(suite))) throw new Error(`incomplete ${name}`);
        await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
      }
    }
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
    report.android_commissioning = true; report.android_contract = true; report.android_state = true; report.android_apk = true; report.android_lint = true;
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
