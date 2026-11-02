import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPrivate, readPrivate, readPrivateToken } from './control-files.mjs';
import { parseModelChange, sameModelRequest, verifyModelBinding, verifyModelInstallation, verifyModelOperation, verifyPublisherTrust } from '../../protocol/model-registry.mjs';
import { parseOtaChange, parseOtaResponse, verifyFirmwareTrust, verifyOtaOperation, verifyOtaTask } from '../../protocol/ota-tasks.mjs';
import { parseExecutionChange, verifyExecutionOperation, verifyExecutionBinding, verifyExecutionAdapters, verifyApplications } from '../../protocol/execution-bindings.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';

const catalog = JSON.parse(await readFile(new URL('../../../contracts/tools/catalog.json', import.meta.url), 'utf8'));
const problem = (code, exit) => Object.assign(new Error(code), { safeCode: code, exit });
export async function runRegistry(args) {
  let original;
  try {
    const { values: flags, positionals: p } = parseArgs({ args, allowPositionals: true, options: {
      'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' },
      'idempotency-key': { type: 'string' }, endpoint: { type: 'string' }, after: { type: 'string' }, json: { type: 'boolean' },
    } });
    const operationID = p[0] === 'invoke' ? p[1] : `${p[0]}.${p[1]}`;
    const firmware = ['ota-changes.', 'ota-tasks.', 'firmware-trusts.'].some(prefix => operationID.startsWith(prefix));
    const execution = ['execution-', 'device-applications.'].some(prefix => operationID.startsWith(prefix));
    const changes = execution ? 'execution-changes' : firmware ? 'ota-changes' : 'model-changes';
    const operationsPath = execution ? 'execution-operations' : firmware ? 'ota-operations' : 'model-operations';
    const operation = catalog.operations.find(value => value.operation_id === operationID);
    if (!operation) throw problem('unsupported_operation', 2);
    const endpoint = new URL(flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
    if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw problem('secure_endpoint_required', 2);
    const space = flags['space-id']; if (!/^[A-Za-z0-9_-]{1,128}$/.test(space ?? '')) throw problem('space_id_required', 2);
    const resource = flags.id ?? p[2]; if (operation.path.includes('{id}') && !/^[A-Za-z0-9_-]{1,128}$/.test(resource ?? '')) throw problem('resource_id_required', 2);
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw problem('ambiguous_token_configuration', 2);
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    if (!token) throw problem('unauthenticated', 3);
    const call = async (url, input, key) => {
      let response;
      try { response = await fetch(endpoint.origin + url, { method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
        body: input === undefined ? undefined : JSON.stringify(input) }); }
      catch { throw problem('operation_unknown', input === undefined ? 5 : 6); }
      let result; try { const raw = await response.text(); if (Buffer.byteLength(raw) > 2_000_000) throw new Error(); result = execution ? parseBoundedJSON(raw,{maxBytes:2_000_000,maxDepth:12,maxNodes:20000}) : firmware ? parseOtaResponse(raw) : JSON.parse(raw); } catch { throw problem('invalid_response', original ? 6 : 5); }
      if (!response.ok) throw problem(/^[a-z][a-z0-9_]{0,63}$/.test(result.error?.code ?? '') ? result.error.code : 'request_failed', response.status === 401 || response.status === 403 ? 3 : response.status === 409 ? 4 : response.status >= 500 ? original ? 6 : 5 : 2);
      return result;
    };
    let url = operation.path.replace('{space_id}', encodeURIComponent(space)).replace('{id}', encodeURIComponent(resource ?? ''));
    if (flags.after !== undefined) { if (!operation.pagination) throw problem('unsupported_pagination', 2); url += '?after=' + encodeURIComponent(flags.after); }
    let expected, result;
    if (operationID === changes + '.create') {
      const key = flags['idempotency-key']; if (!/^[A-Za-z0-9_-]{1,128}$/.test(key ?? '') || !flags.input) throw problem('input_and_idempotency_key_required', 2);
      let change; try { change = (execution ? parseExecutionChange : firmware ? parseOtaChange : parseModelChange)(await readFile(flags.input, 'utf8')); } catch { throw problem(execution ? 'invalid_execution_change' : firmware ? 'invalid_ota_change' : 'invalid_model_change', 2); }
      expected = { space_id: space, idempotency_key: key, change };
      const record = { version: 1, origin: endpoint.origin, request: expected };
      const recordFile = path.join(path.resolve(flags['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/gateway')), operationsPath, createHash('sha256').update(endpoint.origin + '\n' + space + '\n' + key).digest('hex') + '.json');
      original = { request_key: key, record_file: recordFile, recovery_operation: changes + '.resolve' };
      let existing = false;
      try { await createPrivate(recordFile, record); } catch (error) {
        if (error.code !== 'EEXIST') throw problem('original_record_unavailable', 5);
        let saved; try { saved = await readPrivate(recordFile); } catch { throw problem('original_record_unavailable', 5); }
        if (!sameModelRequest(saved, record)) throw problem('idempotency_conflict', 4); existing = true;
      }
      try { result = existing ? await call(`/api/v1/spaces/${encodeURIComponent(space)}/${operationsPath}/by-key/${encodeURIComponent(key)}`) : await call(url, change, key); }
      catch (error) { if (error.safeCode === (execution ? 'execution_operation_not_found' : firmware ? 'ota_operation_not_found' : 'model_operation_not_found') || error.exit >= 5) throw problem('operation_unknown', 6); throw error; }
    } else result = await call(url);
    if (operationID.startsWith(changes + '.')) {
      try {
        await (execution ? verifyExecutionOperation : firmware ? verifyOtaOperation : verifyModelOperation)(result, expected);
        if (result.request.space_id !== space || operationID === changes + '.resolve' && result.request.idempotency_key !== resource) throw new Error();
      } catch { throw problem('operation_unknown', 6); }
    } else if (execution) {
      try {
        if(operationID==='execution-bindings.get') verifyExecutionBinding(result,resource);
        else if(operationID==='execution-adapters.list') verifyExecutionAdapters(result);
        else if(operationID==='device-applications.list') verifyApplications(result,resource);
        else throw new Error();
      } catch {throw problem('invalid_response',5);}
    } else if (firmware) {
      try {
        const verify = operationID.startsWith('firmware-trusts.') ? verifyFirmwareTrust : verifyOtaTask;
        const field = operationID.startsWith('firmware-trusts.') ? 'trust_id' : 'task_id';
        if (operationID.endsWith('.get')) { await verify(result); if (result[field] !== resource) throw new Error(); }
        else {
          if (!Array.isArray(result.items) || result.items.length > (field === 'trust_id' ? 32 : 16) ||
              result.next_cursor !== null && (field === 'trust_id' || !/^ota-[A-Za-z0-9_-]+$/.test(result.next_cursor))) throw new Error();
          await Promise.all(result.items.map(verify));
        }
      } catch { throw problem('invalid_response', 5); }
    } else {
      try {
        if (operationID === 'model-trusts.get') { await verifyPublisherTrust(result); if (result.trust_id !== resource) throw new Error(); }
        if (operationID === 'model-installations.get') { await verifyModelInstallation(result); if (result.installation_id !== resource) throw new Error(); }
        if (operationID === 'device-models.get') verifyModelBinding(result, resource);
        if (operationID.endsWith('.list')) {
          if (!Array.isArray(result.items) || result.items.length > (operationID === 'model-trusts.list' ? 32 : 16)) throw new Error();
          await Promise.all(result.items.map(operationID === 'model-trusts.list' ? verifyPublisherTrust : verifyModelInstallation));
          if (operationID === 'model-trusts.list' && result.next_cursor !== null || operationID === 'model-installations.list' &&
            (result.next_cursor !== null && !/^install-[a-f0-9]{64}$/.test(result.next_cursor) || !result.heads || Array.isArray(result.heads) ||
             Object.values(result.heads).some(id => !/^install-[a-f0-9]{64}$/.test(id)))) throw new Error();
        }
      } catch { throw problem('invalid_response', 5); }
    }
    console.log(JSON.stringify({ ...result, ...(original ? { cli: original } : {}) }));
    if (result.status === 'conflict') process.exitCode = 4;
    else if (result.status === 'rejected') process.exitCode = 7;
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.safeCode ?? 'local_file_unavailable' }, ...(original ? { original } : {}) }));
    process.exitCode = error.exit ?? 5;
  }
}
