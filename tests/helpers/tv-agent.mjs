import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

// 仅消费 Gradle 在编译测试类后生成的入口；完整 test:tv-agent 负责先构建和执行核心检查。
export async function tvAgentRuntime() {
  let runtime;
  try {
    runtime = JSON.parse(await readFile(new URL('../../apps/tv-agent/core/build/journey/runtime.json', import.meta.url), 'utf8'));
  } catch (cause) {
    throw new Error('先执行 TV Agent 的 :core:test :core:journeyRuntime，再运行 Node 旅程', { cause });
  }
  if (typeof runtime.java !== 'string' || !path.isAbsolute(runtime.java) || typeof runtime.classpath !== 'string' || !runtime.classpath || runtime.main !== 'run.limeai.iot.device.MqttJourneyMain') throw new Error('invalid_tv_agent_runtime');
  await access(runtime.java, constants.X_OK);
  return { executable: runtime.java, args: ['-Xmx256m', '-cp', runtime.classpath, runtime.main] };
}
