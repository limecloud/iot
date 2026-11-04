import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceTurnClient, voiceTurnLimits } from '../../protocol/voice-turns.mjs';
import { readPrivate } from './control-files.mjs';
import { taskError } from './task-journal.mjs';
import { openVoiceCommand } from './voice-command.mjs';

export async function runVoiceTurns(args) {
  try {
    const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: { 'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, endpoint: { type: 'string' }, input: { type: 'string' }, wait: { type: 'boolean' }, json: { type: 'boolean' } } });
    const operation = positionals[0];
    if (positionals.length !== 1 || !['schema', 'start', 'resolve', 'continue', 'stop'].includes(operation)) throw taskError('unsupported_operation');
    if (operation === 'schema') {
      const input = JSON.parse(await readFile(new URL('../../../contracts/voice-turns.schema.json', import.meta.url)));
      console.log(JSON.stringify({ version: 1, kind: 'client_composition', operations: ['start', 'resolve', 'continue', 'stop'], limits: voiceTurnLimits, input_schema: input, recovery: 'resolve只查询；continue在原任务成功后明确推进未创建的下一阶段；stop先保存停止决定' })); return;
    }
    if (flags.input && operation !== 'start' || flags.wait && !['start', 'continue'].includes(operation)) throw taskError('unsupported_option');
    const signal = AbortSignal.timeout(305000);
    const command = await openVoiceCommand(flags, signal);
    await command.locked(async () => {
      const client = new VoiceTurnClient({ origin: command.origin, space: command.space, journal: command.journal, request: command.request, signal });
      let result;
      if (operation === 'start') {
        if (!flags.input) throw taskError('input_required');
        const raw = await readPrivate(flags.input);
        if (Object.keys(raw).sort().join(',') !== 'language,media_id,turn_id,voice') throw taskError('invalid_voice_turn_request');
        result = await client.start(raw);
      } else result = await client[operation]();
      while (flags.wait && ['running', 'ready'].includes(result.phase)) {
        await delay(1000, undefined, { signal }); result = await client.continue();
      }
      console.log(JSON.stringify({ ...result, cli: { record_file: command.recordFile, recovery_operation: 'voice-turns resolve' } }));
      if (result.phase === 'unknown') process.exitCode = 6;
      else if (result.phase === 'failed') process.exitCode = 7;
    });
  } catch (error) {
    const code = error.safeCode ?? error.code ?? 'voice_turn_record_unavailable';
    console.error(JSON.stringify({ error: { code }, recovery_operation: 'voice-turns resolve' }));
    process.exitCode = error.exit ?? (['voice_turn_record_unavailable', 'private_file_required', 'private_directory_required'].includes(code) ? 5 : 6);
  }
}
