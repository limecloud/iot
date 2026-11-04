import path from 'node:path';
import { homedir } from 'node:os';
import { parseBoundedJSON, sameJSON } from '../../protocol/products.mjs';
import { createPrivate, readPrivateText, readPrivateToken, writePrivate } from './control-files.mjs';
import { TaskJournal, taskError } from './task-journal.mjs';

// 本地语音组合共用鉴权、传输和原记录保存；不承担回合推进或会话政策。
export async function openVoiceCommand(flags, signal, namespace = 'voice-turns', recordError = 'voice_turn_record_unavailable') {
  const endpoint = new URL(flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
  if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw taskError('secure_endpoint_required');
  const space = flags['space-id']; if (!/^[A-Za-z0-9_-]{1,128}$/.test(space ?? '')) throw taskError('space_id_required');
  if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw taskError('ambiguous_token_configuration');
  const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : null);
  if (!token) throw taskError('unauthenticated', 3);
  const lock = new TaskJournal(path.resolve(flags['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/gateway'), namespace), endpoint.origin, space);
  const file = path.join(lock.directory, 'current.json');
  const load = async () => {
    try { return await readPrivateText(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw taskError(recordError, 5); }
  };
  const journal = { load, async save(previous, next) {
    const raw = await load();
    if (raw === null ? previous !== null : previous === null || !sameJSON(JSON.parse(raw), previous)) throw taskError(recordError, 5);
    if (previous === null) await createPrivate(file, next); else await writePrivate(file, next);
  } };
  const request = async (resource, input, key) => {
    try {
      const response = await fetch(endpoint.origin + resource, { method: input === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), headers: { Authorization: `Bearer ${token}`,
          ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: input === undefined ? undefined : JSON.stringify(input) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2000000) throw new Error(); chunks.push(chunk); }
      const value = parseBoundedJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), { maxBytes: 2000000, maxDepth: 12, maxNodes: 100000 });
      if (!response.ok) {
        const code = /^[a-z][a-z0-9_]{0,63}$/.test(value.error?.code ?? '') ? value.error.code : 'request_failed';
        throw Object.assign(taskError(code, [401, 403].includes(response.status) ? 3 : response.status >= 500 ? 6 : 2), { code,
          definitiveRejection: response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status) });
      }
      return value;
    } catch (error) { if (error.safeCode) throw error; throw taskError('operation_unknown', 6); }
  };
  return { origin: endpoint.origin, space, journal, request, recordFile: file, locked: action => lock.locked(action) };
}
