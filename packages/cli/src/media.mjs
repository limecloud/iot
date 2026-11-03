import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPrivate, readPrivate, readPrivateToken } from './control-files.mjs';
import { MAX_AUDIO_BYTES, createMediaOriginal, parseMediaChange, validMediaOriginal, verifyMediaOperation, verifyMediaPage, verifyPcmWav } from '../../protocol/media.mjs';
import { parseBoundedJSON, sameJSON } from '../../protocol/products.mjs';

const problem = (code, exit = 2) => Object.assign(new Error(code), { safeCode: code, exit });
const id = value => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? '');
async function boundedFile(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw problem('media_input_too_large');
    const bytes = Buffer.alloc(limit + 1); let offset = 0;
    while (offset <= limit) { const result = await handle.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > limit) throw problem('media_input_too_large');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function runMedia(args) {
  let original;
  try {
    const { values: flags, positionals: p } = parseArgs({ args, allowPositionals: true, options: {
      'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, input: { type: 'string' }, file: { type: 'string' },
      'retain-seconds': { type: 'string' }, id: { type: 'string' }, 'idempotency-key': { type: 'string' }, endpoint: { type: 'string' }, json: { type: 'boolean' },
    } });
    const name = p[0] === 'invoke' ? p[1] : `${p[0]}.${p[1]}`, upload = name === 'media.upload';
    const operationID = upload ? 'media-changes.create' : name;
    if (!['media.list', 'media-changes.create', 'media-changes.resolve'].includes(operationID)) throw problem('unsupported_operation');
    const endpoint = new URL(flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
    if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw problem('secure_endpoint_required');
    const space = flags['space-id']; if (!id(space)) throw problem('space_id_required');
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw problem('ambiguous_token_configuration');
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    if (!token) throw problem('unauthenticated', 3);
    const prefix = `/api/v1/spaces/${encodeURIComponent(space)}`, state = path.resolve(flags['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/gateway'));
    const recordFile = key => path.join(state, 'media-operations', createHash('sha256').update(endpoint.origin + '\n' + space + '\n' + key).digest('hex') + '.json');
    const call = async (url, input, key) => {
      try {
        const response = await fetch(endpoint.origin + url, { method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, body: input === undefined ? undefined : JSON.stringify(input) });
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 2_000_000) throw problem('invalid_response', original ? 6 : 5); chunks.push(chunk); }
        const value = parseBoundedJSON(Buffer.concat(chunks).toString('utf8'), { maxBytes: 2_000_000, maxDepth: 12, maxNodes: 100000 });
        if (!response.ok) throw problem(/^[a-z][a-z0-9_]{0,63}$/.test(value.error?.code ?? '') ? value.error.code : 'request_failed', response.status === 401 || response.status === 403 ? 3 : response.status === 409 ? 4 : response.status >= 500 ? original ? 6 : 5 : 2);
        return value;
      } catch (error) { if (error.safeCode) throw error; throw problem('operation_unknown', original ? 6 : 5); }
    };
    let value, expected, key;
    if (operationID === 'media-changes.create') {
      key = flags['idempotency-key']; if (!id(key) || upload && (!flags.file || flags.input) || !upload && (!flags.input || flags.file || flags['retain-seconds'])) throw problem('input_and_idempotency_key_required');
      let change;
      if (upload) {
        const seconds = flags['retain-seconds'] ?? '600'; if (!/^\d{2,5}$/.test(seconds) || Number(seconds) < 60 || Number(seconds) > 86400) throw problem('invalid_media_change');
        const bytes = await boundedFile(flags.file, MAX_AUDIO_BYTES); verifyPcmWav(bytes);
        change = { type: 'media.upload', content_base64: bytes.toString('base64'), retain_seconds: Number(seconds) };
      } else change = parseMediaChange((await boundedFile(flags.input, Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096)).toString('utf8'));
      expected = await createMediaOriginal(endpoint.origin, space, key, change);
      original = { request_key: key, record_file: recordFile(key), recovery_operation: 'media-changes.resolve' };
      let existing = false;
      try { await createPrivate(original.record_file, expected); } catch (error) {
        if (error.code !== 'EEXIST') throw problem('original_record_unavailable', 5);
        let saved; try { saved = await readPrivate(original.record_file); } catch { throw problem('original_record_unavailable', 5); }
        if (!validMediaOriginal(saved, endpoint.origin, space)) throw problem('original_record_unavailable', 5);
        if (!sameJSON(saved, expected)) throw problem('idempotency_conflict', 4); existing = true;
      }
      try { value = existing ? await call(`${prefix}/media-operations/by-key/${encodeURIComponent(key)}`) : await call(`${prefix}/media-operations`, change, key); }
      catch (error) { if (error.safeCode === 'media_operation_not_found' || error.exit >= 5) throw problem('operation_unknown', 6); throw error; }
    } else if (operationID === 'media-changes.resolve') {
      key = flags.id ?? p[2]; if (!id(key)) throw problem('resource_id_required');
      try { expected = await readPrivate(recordFile(key)); if (!validMediaOriginal(expected, endpoint.origin, space) || expected.idempotency_key !== key) throw problem('original_record_unavailable', 5); }
      catch (error) { if (error.code !== 'ENOENT') throw problem('original_record_unavailable', 5); }
      if (expected) original = { request_key: key, record_file: recordFile(key), recovery_operation: 'media-changes.resolve' };
      try { value = await call(`${prefix}/media-operations/by-key/${encodeURIComponent(key)}`); }
      catch (error) { if (expected && error.safeCode === 'media_operation_not_found') throw problem('operation_unknown', 6); throw error; }
    } else value = await call(`${prefix}/media`);
    try { if (operationID === 'media.list') verifyMediaPage(value, space); else verifyMediaOperation(value, space, key, expected); }
    catch { throw problem(operationID === 'media.list' ? 'invalid_response' : 'operation_unknown', operationID === 'media.list' ? 5 : 6); }
    console.log(JSON.stringify({ ...value, ...(original ? { cli: original } : {}) }));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.safeCode ?? (['invalid_media_change', 'invalid_media_audio'].includes(error.message) ? error.message : 'local_file_unavailable') }, ...(original ? { original } : {}) }));
    process.exitCode = error.exit ?? 5;
  }
}
