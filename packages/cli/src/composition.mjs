import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { compileComposition, planComposition } from '../../protocol/composition.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { readPrivateToken } from './control-files.mjs';

const problem = (code, exit = 2) => Object.assign(new Error(code), { safeCode: code, exit });
async function readInput(filename, limit) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw problem('composition_input_required');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw problem('composition_input_too_large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}

export async function runComposition(args) {
  try {
    const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: {
      input: { type: 'string' }, bindings: { type: 'string' }, id: { type: 'string' },
      'space-id': { type: 'string' }, endpoint: { type: 'string' }, json: { type: 'boolean' },
    } });
    const command = positionals[0];
    if (positionals.length !== 1 || !['schema', 'compile', 'plan'].includes(command)) throw problem('unsupported_operation');
    if (command === 'schema') {
      if (Object.keys(flags).some(key => key !== 'json')) throw problem('invalid_composition_options');
      const schema = JSON.parse(await readFile(new URL('../../../contracts/composition.schema.json', import.meta.url), 'utf8'));
      const rule = JSON.parse(await readFile(new URL('../../../contracts/rule.schema.json', import.meta.url), 'utf8'));
      console.log(JSON.stringify({ schema_version: 1, commands: ['schema', 'compile', 'plan'], input_schema: schema,
        referenced_schemas: { 'rule.schema.json': rule }, bindings_schema: { type: 'object', minProperties: 1, maxProperties: 8,
          propertyNames: schema.properties.modules.propertyNames, additionalProperties: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
        limits: { package_bytes: 32768, bindings_bytes: 4096, depth: 8, nodes: 2048 },
        plan_side_effects: 'validation_and_simulation_only', deployment_operation: 'rules.deploy', grants_authority: false }));
      return;
    }
    if (!flags.input || !flags.bindings || !flags.id) throw problem('composition_input_bindings_and_id_required');
    if (command === 'compile' && (flags.endpoint || flags['space-id'])) throw problem('invalid_composition_options');
    const compiled = await compileComposition(await readInput(flags.input, 32768), await readInput(flags.bindings, 4096), flags.id);
    if (command === 'compile') { console.log(JSON.stringify(compiled)); return; }
    const space = flags['space-id'];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(space ?? '')) throw problem('space_id_required');
    const endpoint = new URL(flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880');
    if (!(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) ||
        endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw problem('secure_endpoint_required');
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw problem('ambiguous_token_configuration');
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    if (!token) throw problem('unauthenticated', 3);
    async function call(resource, body) {
      let response, result;
      try {
        response = await fetch(endpoint.origin + resource, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body) });
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 65536) throw new Error();
          chunks.push(chunk);
        }
        result = parseBoundedJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), { maxBytes: 65536, maxDepth: 16, maxNodes: 8192 });
      } catch { throw problem('composition_gateway_unavailable', 5); }
      if (!response.ok) throw problem(/^[a-z][a-z0-9_]{0,63}$/.test(result?.error?.code ?? '') ? result.error.code : 'request_failed',
        [401, 403].includes(response.status) ? 3 : response.status === 409 ? 4 : response.status >= 500 ? 5 : 2);
      return result;
    }
    console.log(JSON.stringify(await planComposition(compiled, { request: call, origin: endpoint.origin, space })));
  } catch (error) {
    const localCodes = new Set(['invalid_composition', 'composition_role_mismatch', 'composition_instance_id_required', 'invalid_composition_bindings']);
    const conflicts = new Set(['composition_model_mismatch', 'device_offline']);
    console.error(JSON.stringify({ error: { code: error.safeCode ?? (localCodes.has(error.message) || conflicts.has(error.message) || error.message === 'invalid_simulation' ? error.message : 'composition_input_unavailable') } }));
    process.exitCode = error.exit ?? (localCodes.has(error.message) ? 2 : conflicts.has(error.message) ? 4 : 5);
  }
}
