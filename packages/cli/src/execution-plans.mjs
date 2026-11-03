import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createPrivate, readPrivate, readPrivateToken } from './control-files.mjs';
import { parseBoundedJSON, sameJSON } from '../../protocol/products.mjs';
import { documentDigest } from '../../protocol/model-validation.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && !Array.isArray(value) && typeof value === 'object' &&
  Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const problem = (code, exit = 2) => Object.assign(new Error(code), { safeCode: code, exit });

async function verifyPlan(value, expectedID) {
  if (!value || !id(value.plan_id) || expectedID && value.plan_id !== expectedID || !digest(value.revision) ||
      !Array.isArray(value.stages) || value.stages.length > 16 || !Array.isArray(value.children) || value.children.length > 16) throw problem('invalid_response', 5);
  const { revision, ...body } = value;
  if (revision !== await documentDigest(body) || value.definition_digest !== await documentDigest({
    type: 'plans.create', plan_id: value.plan_id, generation: value.generation, stages: value.stages, expires_at: value.expires_at,
  })) throw problem('invalid_response', 5);
  return value;
}

export async function runExecutionPlans(args) {
  let original;
  try {
    const { values: flags, positionals: p } = parseArgs({ args, allowPositionals: true, options: {
      'space-id': { type: 'string' }, 'state-dir': { type: 'string' }, input: { type: 'string' }, id: { type: 'string' },
      'idempotency-key': { type: 'string' }, endpoint: { type: 'string' }, after: { type: 'string' }, json: { type: 'boolean' },
    } });
    const operationID = p[0] === 'invoke' ? p[1] : `${p[0]}.${p[1]}`;
    const catalog = JSON.parse(await readFile(new URL('../../../contracts/tools/catalog.json', import.meta.url), 'utf8'));
    const operation = catalog.operations.find(item => item.operation_id === operationID);
    if (!operation) throw problem('unsupported_operation');
    const endpoint = new URL(flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
    if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) ||
        endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw problem('secure_endpoint_required');
    const space = flags['space-id'];
    const resource = flags.id ?? p[2];
    if (!id(space)) throw problem('space_id_required');
    if (operation.path.includes('{id}') && !id(resource)) throw problem('resource_id_required');
    if (flags.after !== undefined && (operationID !== 'execution-plans.list' || !id(flags.after))) throw problem('invalid_cursor');
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw problem('ambiguous_token_configuration');
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    if (!token) throw problem('unauthenticated', 3);
    const call = async (url, input, key) => {
      let response;
      try {
        response = await fetch(endpoint.origin + url, { method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
          body: input === undefined ? undefined : JSON.stringify(input) });
      } catch { throw problem('operation_unknown', original ? 6 : 5); }
      let value;
      try { value = parseBoundedJSON(await response.text(), { maxBytes: 2_000_000, maxDepth: 24, maxNodes: 100000 }); }
      catch { throw problem('invalid_response', original ? 6 : 5); }
      if (!response.ok) throw problem(/^[a-z][a-z0-9_]{0,63}$/.test(value.error?.code ?? '') ? value.error.code : 'request_failed',
        response.status === 401 || response.status === 403 ? 3 : response.status === 409 ? 4 : response.status >= 500 ? original ? 6 : 5 : 2);
      return value;
    };
    let url = operation.path.replace('{space_id}', encodeURIComponent(space)).replace('{id}', encodeURIComponent(resource ?? ''));
    if (flags.after !== undefined) url += '?after=' + encodeURIComponent(flags.after);
    let expected;
    let value;
    if (operationID === 'execution-plan-changes.create') {
      const key = flags['idempotency-key'];
      if (!id(key) || !flags.input) throw problem('input_and_idempotency_key_required');
      const schema = JSON.parse(await readFile(new URL('../../../contracts/execution-plans.schema.json', import.meta.url), 'utf8'));
      const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
      const change = parseBoundedJSON(await readFile(flags.input, 'utf8'), { maxBytes: 16384, maxDepth: 20, maxNodes: 12000 });
      if (!ajv.compile(schema)(change)) throw problem('invalid_plan_change');
      expected = { space_id: space, idempotency_key: key, change };
      const saved = { version: 1, origin: endpoint.origin, request: expected };
      const file = path.join(path.resolve(flags['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/gateway')),
        'execution-plan-operations', createHash('sha256').update(endpoint.origin + '\n' + space + '\n' + key).digest('hex') + '.json');
      original = { request_key: key, record_file: file, recovery_operation: 'execution-plan-changes.resolve' };
      let existing = false;
      try { await createPrivate(file, saved); }
      catch (error) {
        if (error.code !== 'EEXIST') throw problem('original_record_unavailable', 5);
        let previous; try { previous = await readPrivate(file); } catch { throw problem('original_record_unavailable', 5); }
        if (!sameJSON(previous, saved)) throw problem('idempotency_conflict', 4);
        existing = true;
      }
      try { value = await call(existing ? `/api/v1/spaces/${encodeURIComponent(space)}/execution-plan-operations/by-key/${encodeURIComponent(key)}` : url,
        existing ? undefined : change, existing ? undefined : key); }
      catch (error) { if (error.safeCode === 'execution_plan_operation_not_found' || error.exit >= 5) throw problem('operation_unknown', 6); throw error; }
    } else value = await call(url);
    if (operationID.startsWith('execution-plan-changes.')) {
      const valid = fields(value, 'operation_id,request,request_digest,status,reason,result,created_at') && id(value.operation_id) &&
        fields(value.request, 'space_id,idempotency_key,change') && value.request.space_id === space && id(value.request.idempotency_key) &&
        value.request_digest === await documentDigest(value.request) && (!expected || sameJSON(value.request, expected)) &&
        (operationID !== 'execution-plan-changes.resolve' || value.request.idempotency_key === resource) &&
        Number.isFinite(Date.parse(value.created_at)) && ['applied', 'conflict', 'rejected'].includes(value.status) &&
        (value.status === 'applied' ? value.reason === null && fields(value.result, 'kind,id,revision') && value.result.kind === 'execution_plan' &&
          value.result.id === value.request.change.plan_id && digest(value.result.revision) : value.result === null && typeof value.reason === 'string');
      if (!valid) throw problem('operation_unknown', 6);
    } else if (operationID === 'execution-plans.get') await verifyPlan(value, resource);
    else {
      if (!fields(value, 'items,next_cursor') || !Array.isArray(value.items) || value.items.length > 16 || value.next_cursor !== null && !id(value.next_cursor)) throw problem('invalid_response', 5);
      await Promise.all(value.items.map(plan => verifyPlan(plan)));
    }
    console.log(JSON.stringify({ ...value, ...(original ? { cli: original } : {}) }));
    if (value.status === 'conflict') process.exitCode = 4;
    else if (['rejected', 'failed', 'partial'].includes(value.status)) process.exitCode = 7;
    else if (value.status === 'unknown') process.exitCode = 6;
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.safeCode ?? 'invalid_plan_input' }, ...(original ? { original } : {}) }));
    process.exitCode = error.exit ?? 2;
  }
}
