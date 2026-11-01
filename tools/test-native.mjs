import { spawn } from 'node:child_process';
import path from 'node:path';
import { root, startStack } from './dev-stack.mjs';
import { ollamaFixture } from '../tests/support/ollama-fixture.mjs';

const target = process.argv[2];
if (!['ios', 'android'].includes(target)) throw new Error('select ios or android');
const provider = await ollamaFixture();
let stack;
try {
  stack = await startStack({ gatewayEnv: { LIMEIOT_OLLAMA_MODEL: 'fixture-local', LIMEIOT_OLLAMA_URL: provider.origin } });
  const command = target === 'ios' ? 'swift' : 'sh';
  const args = target === 'ios' ? ['run', 'ClientChecks'] : ['gradlew', '--no-daemon', '--configure-on-demand', ':core:test', '--rerun-tasks'];
  const child = spawn(command, args, { cwd: path.join(root, 'apps', target), env: stack.env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) process.exitCode = code ?? 1;
  else if (provider.requests.length !== 1) throw new Error('native draft must call the fixture exactly once');
} finally { await stack?.close(); await provider.close(); }
