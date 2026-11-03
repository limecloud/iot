import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPrivate, readPrivate, readPrivateToken } from './control-files.mjs';
import { parseBoundedJSON, sameJSON } from '../../protocol/products.mjs';

const problem = (code, exit = 2) => Object.assign(new Error(code), { safeCode: code, exit });
const id = s => /^[A-Za-z0-9_-]{1,128}$/.test(s ?? '');
async function inputFile(file,parseInput,requestError,maxBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw problem(requestError);
    const bytes = Buffer.alloc(maxBytes+1); let offset = 0;
    while (offset < bytes.length) { const r = await handle.read(bytes, offset, bytes.length - offset, null); if (!r.bytesRead) break; offset += r.bytesRead; }
    if (offset > maxBytes) throw problem(requestError);
    return parseInput(bytes.subarray(0, offset).toString('utf8'));
  } finally { await handle.close(); }
}
export async function runModelJob(args,{family,discards,discardAction,parseInput,createOriginal,validOriginal,verifyTask,requestError,notFound,maxInputBytes=8192}) {
  let original;
  try {
    const { values: f, positionals: p } = parseArgs({ args, allowPositionals: true, options: { 'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' }, 'idempotency-key': { type: 'string' }, endpoint: { type: 'string' }, json: { type: 'boolean' } } });
    const op = p[0] === 'invoke' ? p[1] : `${p[0]}.${p[1]}`;
    if (![`${family}.create`, `${family}.resolve`, `${family}.discard`].includes(op)) throw problem('unsupported_operation');
    const endpoint = new URL(f.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
    if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw problem('secure_endpoint_required');
    const space = f['space-id'], key = op.endsWith('.create') ? f['idempotency-key'] : f.id ?? p[2];
    if (!id(space) || !id(key)) throw problem('space_and_request_key_required');
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw problem('ambiguous_token_configuration');
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    if (!token) throw problem('unauthenticated', 3);
    const prefix = `/api/v1/spaces/${encodeURIComponent(space)}/${family}`, resolve = `${prefix}/by-key/${encodeURIComponent(key)}`;
    const state = path.resolve(f['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/gateway'));
    const filename = kind => path.join(state, kind, createHash('sha256').update(endpoint.origin + '\n' + space + '\n' + key).digest('hex') + '.json');
    const call = async (url, body) => {
      try {
        const response = await fetch(endpoint.origin + url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 32768) throw problem('operation_unknown', 6); chunks.push(chunk); }
        const value = parseBoundedJSON(Buffer.concat(chunks).toString('utf8'), { maxBytes: 32768, maxDepth: 4, maxNodes: 128 });
        if (!response.ok) throw problem(/^[a-z][a-z0-9_]{0,63}$/.test(value.error?.code ?? '') ? value.error.code : 'request_failed', [401, 403].includes(response.status) ? 3 : response.status === 409 ? 4 : response.status >= 500 ? 6 : 2);
        return value;
      } catch (error) { if (error.safeCode) throw error; throw problem('operation_unknown', 6); }
    };
    let expected, value;
    const load = async () => {
      try { expected = await readPrivate(filename(family)); if (!validOriginal(expected, endpoint.origin, space, key)) throw problem('original_record_unavailable', 5); }
      catch (error) { if (error.code !== 'ENOENT') throw problem('original_record_unavailable', 5); }
    };
    if (op.endsWith('.create')) {
      if (!f.input) throw problem('input_required');
      const input = await inputFile(f.input,parseInput,requestError,maxInputBytes); expected = await createOriginal(endpoint.origin, space, key, input);
      original = { request_key: key, record_file: filename(family), recovery_operation: `${family}.resolve` };
      let existing = false;
      try { await createPrivate(original.record_file, expected); } catch (error) {
        if (error.code !== 'EEXIST') throw problem('original_record_unavailable', 5);
        let saved; try { saved = await readPrivate(original.record_file); } catch { throw problem('original_record_unavailable', 5); }
        if (!validOriginal(saved, endpoint.origin, space, key)) throw problem('original_record_unavailable', 5);
        if (!sameJSON(saved, expected)) throw problem('idempotency_conflict', 4); existing = true;
      }
      value = existing ? await call(resolve) : await call(prefix, input);
    } else {
      await load();
      if (expected) original = { request_key: key, record_file: filename(family), recovery_operation: `${family}.resolve` };
      if (op.endsWith('.discard')) {
        const intent = { version: 1, origin: endpoint.origin, space_id: space, idempotency_key: key, action: discardAction };
        original = { request_key: key, record_file: filename(discards), recovery_operation: `${family}.resolve` };
        let existing = false;
        try { await createPrivate(original.record_file, intent); } catch (error) { if (error.code !== 'EEXIST') throw problem('original_record_unavailable', 5); if (!sameJSON(await readPrivate(original.record_file), intent)) throw problem('original_record_unavailable', 5); existing = true; }
        value = existing ? await call(resolve) : await call(resolve + '/discard', {});
        if (existing && value.status === 'running') throw problem('operation_unknown', 6);
      } else value = await call(resolve);
    }
    try { await verifyTask(value, space, key, expected); } catch { throw problem('operation_unknown', 6); }
    console.log(JSON.stringify({ ...value, ...(original ? { cli: original } : {}) }));
    if (value.status === 'unknown') process.exitCode = 6;
    else if (value.status === 'failed') process.exitCode = 7;
  } catch (error) {
    const code = original && error.safeCode === notFound ? 'operation_unknown' : error.safeCode ?? (error.message === requestError ? error.message : 'local_file_unavailable');
    console.error(JSON.stringify({ error: { code }, ...(original ? { original } : {}) }));
    process.exitCode = code === 'operation_unknown' ? 6 : error.exit ?? 5;
  }
}
