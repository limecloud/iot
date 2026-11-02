import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

// 文件、密码学和资格规则由Rust入口处理，JS仅转交参数及进程退出状态。
export async function runOta(args) {
  try {
    const configured = process.env.LIMEIOT_OTA_TOOL;
    if (configured && !isAbsolute(configured)) throw new Error('absolute_ota_tool_path_required');
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(configured ?? 'limeiot-ota', args, {
        env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'inherit', 'inherit'],
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ota_component_unavailable')); }, args[0] === 'download' ? 35000 : 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('ota_component_unavailable')); });
      child.once('close', code => {
        clearTimeout(timer);
        if ([0, 2, 4, 5].includes(code)) resolve(code);
        else reject(new Error('ota_component_unavailable'));
      });
    });
  } catch (error) {
    const code = error.message === 'absolute_ota_tool_path_required' ? error.message : 'ota_component_unavailable';
    console.error(JSON.stringify({ error: { code } }));
    process.exitCode = 5;
  }
}
