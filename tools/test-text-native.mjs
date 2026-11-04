import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev/text-native'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
const report = { passed: false, swift_contract_and_state: false, swift_home_state: false, swiftui_parse: false, android_contract: false, android_state: false, android_home_state: false, android_apk: false, android_lint: false, native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    const executable = path.join(directory, 'ios-text-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/TextGenerationStore.swift', 'Checks/TextGenerationStoreChecks.swift', 'Checks/TextGenerationLiveChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, []); report.swift_contract_and_state = true;
    const stores = ['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'];
    const home = path.join(directory, 'ios-home-checks');
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...stores.map(n => `App/${n}.swift`), 'Checks/HomeStoreChecks.swift', ...objects, '-o', home], ios);
    await run(home, []); report.swift_home_state = true;
    await run('swiftc', ['-frontend', '-parse', 'App/TextGenerationViews.swift', 'App/MediaViews.swift', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios);
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_parse = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':core:test', '--tests', 'run.limeai.iot.core.TextGenerationClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.TextGenerationControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
    for (const [module, task, name, count] of [['core', 'test', 'run.limeai.iot.core.TextGenerationClientTest', 7], ['app', 'testDebugUnitTest', 'run.limeai.iot.TextGenerationControllerTest', 8], ['app', 'testDebugUnitTest', 'run.limeai.iot.HomeViewModelTest', 6]]) {
      const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, `TEST-${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      if (!new RegExp(`\\btests="${count}"`).test(suite) || !['failures', 'errors', 'skipped'].every(k => new RegExp(`\\b${k}="0"`).test(suite))) throw new Error(`incomplete ${name}`);
      await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
    }
    report.android_contract = report.android_state = report.android_home_state = report.android_apk = report.android_lint = true;
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
