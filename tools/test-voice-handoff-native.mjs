import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), selected = process.argv[2];
if (selected && !['ios', 'android'].includes(selected)) throw new Error('select ios or android');
const directory = path.join(root, '.dev/voice-handoff-native'); await mkdir(directory, { recursive: true });
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
const report = { passed: false, target: selected ?? 'both', swift_text_checks: false, swift_speech_checks: false, swiftui_parse: false, android_text_speech_home_checks: false, android_apk: false, android_lint: false, native_app_runtime: false, hardware: false, published: false, full_goal_completed: false };
try {
  if (!selected || selected === 'ios') {
    const ios = path.join(root, 'apps/ios'), build = path.join(ios, '.build/debug');
    await run('swift', ['build'], ios);
    const objects = (await readdir(path.join(build, 'LimeIoTKit.build'))).filter(n => n.endsWith('.o')).map(n => path.join(build, 'LimeIoTKit.build', n));
    for (const [name, files] of [['text', ['App/TextGenerationStore.swift', 'Checks/TextGenerationStoreChecks.swift', 'Checks/TextGenerationLiveChecks.swift']], ['speech', ['App/MediaStore.swift', 'App/SpeechStore.swift', 'Checks/SpeechStoreChecks.swift']]]) {
      const executable = path.join(directory, `ios-${name}-checks`);
      await run('swiftc', ['-swift-version', '6', '-parse-as-library', '-I', path.join(build, 'Modules'), ...files, ...objects, '-o', executable], ios);
      await run(executable, []); report[`swift_${name}_checks`] = true;
    }
    await run('swiftc', ['-frontend', '-parse', 'App/MediaViews.swift', 'App/TextGenerationViews.swift', 'App/TranscriptionViews.swift', 'App/SpeechViews.swift'], ios);
    await run('plutil', ['-lint', 'LimeIoT.xcodeproj/project.pbxproj'], ios); report.swiftui_parse = true;
  }
  if (!selected || selected === 'android') {
    await run('sh', ['gradlew', '--no-daemon', '--configure-on-demand', '--max-workers=1', ':app:testDebugUnitTest', '--tests', 'run.limeai.iot.TextGenerationControllerTest', '--tests', 'run.limeai.iot.SpeechControllerTest', '--tests', 'run.limeai.iot.HomeViewModelTest', ':app:assembleDebug', ':app:lintDebug'], path.join(root, 'apps/android'));
    for (const [name, count] of [['TextGenerationControllerTest', 8], ['SpeechControllerTest', 8], ['HomeViewModelTest', 6]]) {
      const xml = await readFile(path.join(root, `apps/android/app/build/test-results/testDebugUnitTest/TEST-run.limeai.iot.${name}.xml`), 'utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      for (const [key, value] of Object.entries({ tests: count, failures: 0, errors: 0, skipped: 0 })) assert.match(suite, new RegExp(`\\b${key}="${value}"`));
      await writeFile(path.join(directory, `TEST-run.limeai.iot.${name}.xml`), xml);
    }
    report.android_text_speech_home_checks = report.android_apk = report.android_lint = true;
    await writeFile(path.join(directory, 'android-lint.xml'), await readFile(path.join(root, 'apps/android/app/build/reports/lint-results-debug.xml')));
  }
  report.passed = true;
} finally { await writeFile(path.join(directory, selected ? `${selected}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
