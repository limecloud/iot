import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let interpreter;
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// 准备阶段固定测试所用解释器，避免每次探测经系统开发工具启动器寻找 Python。
export async function createAdbFixture(state) {
  interpreter ??= exec('python3', ['-c', 'import json,os,sys; print(json.dumps(os.path.realpath(sys.executable)))'], { timeout: 5000 })
    .then(({ stdout }) => {
      const executable = JSON.parse(stdout);
      if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) throw new Error('invalid_fixture_interpreter');
      return executable;
    });
  const executable = await interpreter;
  const source = path.join(state, 'adb-fixture.py'), binary = path.join(state, 'adb-fixture');
  await writeFile(source, await readFile(new URL('../fixtures/android-tv/adb.py', import.meta.url)), { mode: 0o600 });
  await writeFile(binary, `#!/bin/sh\nexec ${quote(executable)} ${quote(source)} "$@"\n`, { mode: 0o700 });
  return binary;
}
