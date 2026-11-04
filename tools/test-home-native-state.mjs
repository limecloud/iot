import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev/home-native-state'); await mkdir(directory, { recursive: true });
const report = { passed: false, swift_home_state: false, swiftui_parse: false, android_home_state: false, android_cloud_regression: false, android_apk: false, android_lint: false, native_app_runtime: false, production_secure_store: false, hardware: false, published: false, full_goal_completed: false };
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
    const executable = path.join(directory, 'ios-home-state');
    const stores = ['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'];
    await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...stores.map(name => `App/${name}.swift`), 'Checks/HomeStoreChecks.swift', ...objects, '-o', executable], ios);
    await run(executable, []); report.swift_home_state = true;
    await run('swiftc', ['-frontend', '-parse', 'App/Views.swift', 'App/LimeIoTApp.swift'], ios); report.swiftui_parse = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.HomeViewModelTest', '--tests', 'run.limeai.iot.CloudViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
    for (const name of ['HomeViewModelTest', 'CloudViewModelTest']) {
      const xml = await readFile(path.join(root, `apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      if (!/\btests="[1-9][0-9]*"/.test(suite) || !['failures', 'errors', 'skipped'].every(key => new RegExp(`\\b${key}="0"`).test(suite))) throw new Error(`incomplete ${name}`);
      await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
    }
    report.android_home_state = true; report.android_cloud_regression = true; report.android_apk = true; report.android_lint = true;
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
