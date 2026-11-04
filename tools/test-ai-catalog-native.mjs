import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.dev/ai-catalog-native'); await mkdir(directory, { recursive: true });
const report = { passed: false, commands: [], native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), command === 'sh' ? 360000 : 180000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  report.commands.push({ command, args, cwd: path.relative(root, cwd), exit_code: code });
  assert.equal(code, 0, `${command} failed`);
}
try {
  const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
  await run('swift', ['build'], ios);
  const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(name => name.endsWith('.o')).map(name => path.join(build, 'LimeIoTKit.build', name));
  const executable = path.join(directory, 'ios-ai-catalog-checks');
  await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), 'App/AiCatalogStore.swift', 'Checks/AiCatalogChecks.swift', ...objects, '-o', executable], ios);
  await run(executable, [], ios); report.swift_contract_and_state = true;
  const stores = ['SecureStore', 'FirmwareStore', 'MediaStore', 'SpeechStore', 'TranscriptionStore', 'VisionStore', 'TextGenerationStore', 'VoiceTurnStore', 'CompanionStore', 'ObservationStore', 'ZigbeeStore', 'HomeStore'];
  const home = path.join(directory, 'ios-home-checks');
  await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...stores.map(name => `App/${name}.swift`), 'Checks/HomeStoreChecks.swift', ...objects, '-o', home], ios);
  await run(home, [], ios); report.swift_home_state = true;
  await run('swiftc', ['-frontend', '-parse', 'App/AiCatalogViews.swift', 'App/Views.swift'], ios);
  await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_syntax_and_project = true; report.swiftui_full_typecheck = false;
  const classpath = path.join(directory, 'android-classpath.txt');
  const init = path.join(directory, 'classpath.gradle');
  await writeFile(init, `gradle.projectsEvaluated {
    def app = gradle.rootProject.findProject(':app')
    app.tasks.named('testDebugUnitTest', org.gradle.api.tasks.testing.Test).configure {
        def destination = new File('${classpath.replaceAll("'", "\\'")}')
        outputs.file(destination)
        doLast { destination.text = classpath.asPath }
    }
}
`);
  await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', '--init-script', init, ':core:test', '--tests', 'run.limeai.iot.core.GatewayClientTest', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.AiCatalogControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
  for (const [module, task, name, expected] of [['core', 'test', 'run.limeai.iot.core.GatewayClientTest', null], ['app', 'testDebugUnitTest', 'run.limeai.iot.AiCatalogControllerTest', 8], ['app', 'testDebugUnitTest', 'run.limeai.iot.HomeViewModelTest', 6]]) {
    const xml = await readFile(path.join(root, 'apps/android', module, 'build/test-results', task, `TEST-${name}.xml`), 'utf8');
    const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '', count = Number(suite.match(/\btests="(\d+)"/)?.[1]);
    assert.ok(count > 0 && (expected === null || count === expected));
    for (const key of ['errors', 'failures', 'skipped']) assert.match(suite, new RegExp(`\\b${key}="0"`));
    await writeFile(path.join(directory, `TEST-${name}.xml`), xml);
    report[name.split('.').at(-1)] = { passed: count, skipped: 0 };
  }
  assert.ok((await readFile(classpath, 'utf8')).trim());
  await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
  report.android_apk_and_lint = true; report.passed = true;
} finally { await writeFile(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2) + '\n'); }
