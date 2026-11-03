import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const schemaURL = new URL('../../../contracts/zigbee-diagnostics.schema.json', import.meta.url);
const toolURL = new URL('../../../target/debug/limeiot-znp', import.meta.url);

export async function runZigbee(args) {
  try {
    if (args.length === 1 && args[0] === 'schema') {
      console.log(await readFile(schemaURL, 'utf8'));
      return;
    }
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      serial: { type: 'string' }, address: { type: 'string' }, 'timeout-ms': { type: 'string' },
    } });
    const seen = new Set();
    for (const token of tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('invalid_znp_input');
      seen.add(token.name);
    }
    const [command] = positionals;
    const timeoutText = values['timeout-ms'] ?? '5000';
    if (positionals.length !== 1 || !['probe', 'interview'].includes(command)
      || !values.serial || !isAbsolute(values.serial) || Buffer.byteLength(values.serial) > 1024 || values.serial.includes('\0')
      || !/^[0-9]+$/.test(timeoutText) || !Number.isSafeInteger(Number(timeoutText))
      || Number(timeoutText) < 100 || Number(timeoutText) > 30000
      || (command === 'interview') !== (values.address !== undefined)
      || (values.address !== undefined && (!/^0x[0-9a-fA-F]{4}$/.test(values.address) || Number(values.address) >= 0xfff8))) {
      throw new Error('invalid_znp_input');
    }
    const binary = process.env.LIMEIOT_ZNP_TOOL ?? fileURLToPath(toolURL);
    if (!isAbsolute(binary)) throw new Error('invalid_znp_tool');
    const forwarded = [command, '--serial', values.serial, '--timeout-ms', timeoutText];
    if (values.address !== undefined) forwarded.push('--address', values.address);
    try {
      const { stdout, stderr } = await execute(binary, forwarded, {
        encoding: 'utf8', timeout: Number(timeoutText) + 3000, maxBuffer: 32768, windowsHide: true,
      });
      const result = JSON.parse(stdout);
      if (stderr || result.schema_version !== 1 || result.operation !== command || result.protocol !== 'znp'
        || result.evidence !== 'unauthenticated_protocol' || result.device_binding_created !== false
        || !Number.isSafeInteger(result.observed_at_unix_ms) || !result.result || typeof result.result !== 'object') {
        throw new Error('invalid_znp_tool_response');
      }
      console.log(JSON.stringify(result));
    } catch (error) {
      if ([2, 5].includes(error.code) && !error.stdout) {
        let detail;
        try { detail = JSON.parse(error.stderr); } catch { /* 组件错误不输出原始诊断或路径。 */ }
        if (detail?.error && /^[a-z_]+$/.test(detail.error.code) && Object.keys(detail).length === 1
          && Object.keys(detail.error).every(key => ['code', 'status'].includes(key))
          && (detail.error.status === undefined || (Number.isInteger(detail.error.status) && detail.error.status >= 0 && detail.error.status <= 255))) {
          console.error(JSON.stringify(detail));
          process.exitCode = error.code;
          return;
        }
      }
      throw new Error(error.message === 'invalid_znp_tool_response' ? error.message : 'znp_tool_failed');
    }
  } catch (error) {
    const code = ['invalid_znp_input', 'invalid_znp_tool', 'invalid_znp_tool_response', 'znp_tool_failed'].includes(error.message)
      ? error.message : 'invalid_znp_input';
    console.error(JSON.stringify({ error: { code } }));
    process.exitCode = code === 'invalid_znp_input' ? 2 : 5;
  }
}
