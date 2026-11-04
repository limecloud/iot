import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyZigbeeNeighborsReport } from '../../protocol/zigbee-discovery.mjs';
import { verifyZigbeeJoinWindowReport } from '../../protocol/zigbee-commissioning.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { parseZigbeeOnOffSignature, verifyZigbeeOnOffReport } from '../../protocol/zigbee-onoff.mjs';

const execute = promisify(execFile);
const schemaURL = new URL('../../../contracts/zigbee-diagnostics.schema.json', import.meta.url);
const configSchemaURL = new URL('../../../contracts/zigbee-environment.schema.json', import.meta.url);
const toolURL = new URL('../../../target/debug/limeiot-znp', import.meta.url);

async function executeTool(binary, args, options, forwardSignals) {
  const task = execute(binary, args, options);
  if (!forwardSignals) return task;
  let cancelled = false;
  const interrupt = () => { cancelled = true; task.child.kill('SIGINT'); };
  const terminate = () => { cancelled = true; task.child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const result = await task;
    if (cancelled) throw new Error('znp_tool_failed');
    return result;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}

export async function runZigbee(args) {
  let mutationAttempted = false;
  try {
    if (args.length === 1 && ['schema', 'config-schema'].includes(args[0])) {
      console.log(await readFile(args[0] === 'schema' ? schemaURL : configSchemaURL, 'utf8'));
      return;
    }
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      serial: { type: 'string' }, address: { type: 'string' }, 'timeout-ms': { type: 'string' },
      'coordinator-ieee': { type: 'string' }, ieee: { type: 'string' }, endpoint: { type: 'string' },
      'duration-seconds': { type: 'string' },
      power: { type: 'string' }, 'manufacturer-code': { type: 'string' }, 'signature-json': { type: 'string' },
    } });
    const seen = new Set();
    for (const token of tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('invalid_znp_input');
      seen.add(token.name);
    }
    const [command] = positionals;
    const timeoutText = values['timeout-ms'] ?? '5000';
    const onoff = command === 'read-onoff' || command === 'set-onoff';
    const setOnOff = command === 'set-onoff';
    const environment = command === 'read-environment' || onoff;
    const neighbors = command === 'neighbors';
    const permitJoin = command === 'permit-join';
    const durationText = values['duration-seconds'];
    const validIeee = value => typeof value === 'string' && value.length === 16 && /^[0-9a-f]{16}$/.test(value)
      && value !== '0000000000000000' && value !== 'ffffffffffffffff';
    let expectedSignature;
    if (setOnOff) expectedSignature = parseZigbeeOnOffSignature(values['signature-json'] ?? '');
    if (positionals.length !== 1 || !['probe', 'interview', 'read-environment', 'neighbors', 'permit-join', 'read-onoff', 'set-onoff'].includes(command)
      || !values.serial || !isAbsolute(values.serial) || Buffer.byteLength(values.serial) > 1024 || values.serial.includes('\0')
      || !/^[0-9]+$/.test(timeoutText) || !Number.isSafeInteger(Number(timeoutText))
      || Number(timeoutText) < 100 || Number(timeoutText) > 30000
      || (command === 'interview') !== (values.address !== undefined)
      || (values.address !== undefined && (!/^0x[0-9a-fA-F]{4}$/.test(values.address) || Number(values.address) >= 0xfff8))
      || (setOnOff ? !['on', 'off'].includes(values.power) || !/^0x[0-9a-fA-F]{4}$/.test(values['manufacturer-code'] ?? '')
        : ['power', 'manufacturer-code', 'signature-json'].some(key => values[key] !== undefined))
      || (permitJoin ? typeof durationText !== 'string' || durationText.length === 0 || durationText.trim() !== durationText || !/^[0-9]+$/.test(durationText)
        || !Number.isSafeInteger(Number(durationText)) || Number(durationText) > 120 : durationText !== undefined)
      || (environment
        ? !validIeee(values['coordinator-ieee']) || !validIeee(values.ieee) || values['coordinator-ieee'] === values.ieee
          || !/^[0-9]+$/.test(values.endpoint ?? '') || !Number.isInteger(Number(values.endpoint))
          || Number(values.endpoint) < 1 || Number(values.endpoint) > 240
        : neighbors || permitJoin ? !validIeee(values['coordinator-ieee']) || ['ieee', 'endpoint'].some(key => values[key] !== undefined)
          : ['coordinator-ieee', 'ieee', 'endpoint'].some(key => values[key] !== undefined))) {
      throw new Error('invalid_znp_input');
    }
    const binary = process.env.LIMEIOT_ZNP_TOOL ?? fileURLToPath(toolURL);
    if (!isAbsolute(binary)) throw new Error('invalid_znp_tool');
    const forwarded = [command, '--serial', values.serial, '--timeout-ms', timeoutText];
    if (values.address !== undefined) forwarded.push('--address', values.address);
    if (environment) forwarded.push('--coordinator-ieee', values['coordinator-ieee'], '--ieee', values.ieee, '--endpoint', values.endpoint);
    if (neighbors || permitJoin) forwarded.push('--coordinator-ieee', values['coordinator-ieee']);
    if (permitJoin) forwarded.push('--duration-seconds', durationText);
    if (setOnOff) forwarded.push('--power', values.power, '--manufacturer-code', values['manufacturer-code'], '--signature-json', JSON.stringify(expectedSignature));
    try {
      mutationAttempted = permitJoin || setOnOff;
      const { stdout, stderr } = await executeTool(binary, forwarded, {
        encoding: 'utf8', timeout: Number(timeoutText) + 3000, maxBuffer: 32768, windowsHide: true,
      }, mutationAttempted);
      let result;
      try { result = permitJoin || onoff ? parseBoundedJSON(stdout, { maxBytes: 32768, maxDepth: 8, maxNodes: 256 }) : JSON.parse(stdout); }
      catch { throw new Error('invalid_znp_tool_response'); }
      if (stderr || result.schema_version !== 1 || result.operation !== command || result.protocol !== 'znp'
        || result.evidence !== 'unauthenticated_protocol' || result.device_binding_created !== false
        || !Number.isSafeInteger(result.observed_at_unix_ms) || !result.result || typeof result.result !== 'object') {
        throw new Error('invalid_znp_tool_response');
      }
      if (neighbors) verifyZigbeeNeighborsReport(result, values['coordinator-ieee']);
      if (permitJoin) verifyZigbeeJoinWindowReport(result, values['coordinator-ieee'], Number(durationText));
      if (onoff) verifyZigbeeOnOffReport(result, { coordinator_ieee: values['coordinator-ieee'], ieee_address: values.ieee,
        endpoint: Number(values.endpoint), ...(setOnOff ? { manufacturer_code: Number(values['manufacturer-code']), signature: expectedSignature, power: values.power === 'on' } : {}) });
      console.log(JSON.stringify(result));
    } catch (error) {
      if ([2, 5].includes(error.code) && !error.stdout) {
        let detail;
        try { detail = JSON.parse(error.stderr); } catch { /* 组件错误不输出原始诊断或路径。 */ }
        if (detail?.error && /^[a-z_]+$/.test(detail.error.code) && Object.keys(detail).length === 1
          && Object.keys(detail.error).every(key => ['code', 'status', ...(mutationAttempted ? ['outcome', 'retry_allowed'] : [])].includes(key))
          && (detail.error.status === undefined || (Number.isInteger(detail.error.status) && detail.error.status >= 0 && detail.error.status <= 255))
          && (detail.error.outcome === undefined && detail.error.retry_allowed === undefined || detail.error.outcome === 'unknown' && detail.error.retry_allowed === false)) {
          if (mutationAttempted) { detail.error.outcome = 'unknown'; detail.error.retry_allowed = false; }
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
    console.error(JSON.stringify({ error: { code, ...(mutationAttempted ? { outcome: 'unknown', retry_allowed: false } : {}) } }));
    process.exitCode = code === 'invalid_znp_input' ? 2 : 5;
  }
}
