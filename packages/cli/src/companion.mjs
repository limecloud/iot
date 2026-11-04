import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CompanionClient, parseCompanionPolicy } from '../../protocol/companion.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { readPrivateText } from './control-files.mjs';
import { taskError } from './task-journal.mjs';
import { openVoiceCommand } from './voice-command.mjs';

export async function runCompanion(args) {
  const shutdown = new AbortController(), interrupt = () => shutdown.abort();
  try {
    const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: {
      'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, endpoint: { type: 'string' }, policy: { type: 'string' },
      context: { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, wait: { type: 'boolean' }, 'emit-context': { type: 'boolean' }, json: { type: 'boolean' },
    } });
    const operation = positionals[0];
    if (positionals.length !== 1 || !['schema', 'start', 'reply', 'resolve', 'continue', 'stop'].includes(operation)) throw taskError('unsupported_operation');
    if (operation === 'schema') {
      console.log(JSON.stringify({ version: 1, kind: 'client_companion_session', policy_schema: JSON.parse(await readFile(new URL('../../../contracts/companion.schema.json', import.meta.url))),
        operations: ['start', 'reply', 'resolve', 'continue', 'stop'], limits: { max_turns: 8, max_seconds: 1800, history_storage: 'caller_memory', journal_storage: 'summary_only', playback: false, device_execution: false },
        context_schema: { type: 'object', required: ['history'], properties: { history: { type: 'array', minItems: 0, maxItems: 14, items: { type: 'object', required: ['role', 'content'], properties: { role: { enum: ['user', 'assistant'] }, content: { type: 'string', minLength: 1, maxLength: 2048 } }, additionalProperties: false } } }, additionalProperties: false },
        reply_schema: { type: 'object', required: ['media_id'], properties: { media_id: { type: 'string', pattern: '^media-[A-Za-z0-9_-]{1,122}$' } }, additionalProperties: false },
        recovery: 'resolve只查询原回合；continue需要相同政策和历史；stop无需角色或历史，先保存停止决定' })); return;
    }
    if (flags.id && operation !== 'start' || flags.input && operation !== 'reply' || flags.wait && !['reply', 'continue'].includes(operation) ||
        flags['emit-context'] && !['reply', 'continue', 'resolve'].includes(operation) || flags.context && ['start', 'stop'].includes(operation)) throw taskError('unsupported_option');
    if (['start', 'reply', 'continue'].includes(operation) && !flags.policy) throw taskError('companion_policy_required');
    if (['reply', 'continue'].includes(operation) && !flags.context) throw taskError('companion_context_required');
    const policy = flags.policy ? parseCompanionPolicy(await readPrivateText(flags.policy)) : undefined;
    let history;
    if (flags.context) {
      const raw = await readPrivateText(flags.context);
      let context; try { context = parseBoundedJSON(raw, { maxBytes: 65536, maxDepth: 4, maxNodes: 128 }); }
      catch { throw taskError('invalid_voice_turn_context'); }
      if (!context || Array.isArray(context) || Object.keys(context).join(',') !== 'history' || !Array.isArray(context.history)) throw taskError('invalid_voice_turn_context');
      history = context.history;
    }
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(305000)]);
    const command = await openVoiceCommand(flags, signal, 'companion', 'companion_record_unavailable');
    await command.locked(async () => {
      const client = new CompanionClient({ origin: command.origin, space: command.space, journal: command.journal, request: command.request, policy, history, signal });
      let result;
      if (operation === 'start') {
        if (!flags.id) throw taskError('companion_session_id_required'); result = await client.start(flags.id);
      } else if (operation === 'reply') {
        if (!flags.input) throw taskError('input_required');
        const raw = await readPrivateText(flags.input);
        let input; try { input = parseBoundedJSON(raw, { maxBytes: 4096, maxDepth: 2, maxNodes: 8 }); }
        catch { throw taskError('invalid_companion_request'); }
        if (!input || Array.isArray(input) || Object.keys(input).join(',') !== 'media_id') throw taskError('invalid_companion_request');
        result = await client.reply(input.media_id);
      } else result = await client[operation]();
      while (flags.wait && ['running', 'ready'].includes(result.phase)) {
        await delay(1000, undefined, { signal }); result = await client.continue();
      }
      console.log(JSON.stringify({ ...result, ...(flags['emit-context'] ? { context: result.history_available ? { history: client.history } : null } : {}),
        cli: { record_file: command.recordFile, recovery_operation: 'companion resolve' } }));
      if (result.phase === 'unknown') process.exitCode = 6;
      else if (['failed', 'discarded'].includes(result.phase)) process.exitCode = 7;
    });
  } catch (error) {
    const originalCode = error.safeCode ?? error.code;
    const candidate = originalCode === 'voice_turn_paused' ? 'companion_paused' : originalCode;
    const code = typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate :
      shutdown.signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name) ? 'companion_paused' : 'companion_record_unavailable';
    const invalid = ['invalid_companion_policy', 'invalid_companion_request', 'invalid_voice_turn_context', 'companion_policy_required', 'companion_context_required', 'companion_session_id_required'];
    console.error(JSON.stringify({ error: { code }, recovery_operation: 'companion resolve' }));
    process.exitCode = error.exit ?? (invalid.includes(code) ? 2 : ['companion_record_unavailable', 'private_file_required', 'private_directory_required'].includes(code) ? 5 : 6);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
