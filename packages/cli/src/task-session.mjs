import { randomUUID } from 'node:crypto';
import { TaskJournal, taskError } from './task-journal.mjs';
import { canonicalJSON, documentDigest } from '../../protocol/model-validation.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { verifyConfirmedReceipt } from '../../protocol/command-receipts.mjs';
import { verifyRuleSimulation } from '../../protocol/rule-simulation.mjs';
import { conditionSources } from '../../protocol/condition-form.mjs';
import { checkFormValue, sampleValue } from '../../protocol/action-form.mjs';
export { checkFormValue, sampleValue } from '../../protocol/action-form.mjs';

const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value, fields) => object(value) && Object.keys(value).sort().join(',') === fields.slice().sort().join(',');
const terminal = new Set(['confirmed', 'failed', 'rejected', 'expired']);
const knownErrors = new Set(['unauthenticated', 'forbidden', 'invalid_request', 'invalid_value', 'unsupported_capability', 'property_read_only', 'device_not_found', 'device_offline', 'model_mismatch', 'model_trust_revoked', 'command_expired', 'device_queue_full', 'capacity_exceeded', 'ota_task_conflict', 'idempotency_conflict', 'command_not_found', 'not_found', 'revision_conflict', 'unsupported_rule', 'invalid_rule', 'invalid_threshold', 'invalid_condition', 'invalid_schedule', 'invalid_schedule_time', 'rule_cycle', 'invalid_simulation', 'storage_unavailable', 'rate_limited', 'execution_binding_required', 'execution_adapter_offline', 'execution_application_forbidden', 'request_failed']);

export class GatewayTaskSession {
  constructor({ endpoint, token, space, directory, catalog, transport = fetch }) {
    let url; try { url = new URL(endpoint); } catch { throw taskError('secure_endpoint_required'); }
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw taskError('secure_endpoint_required');
    if (!identifier(space)) throw taskError('space_id_required');
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw taskError('unauthenticated', 3);
    this.origin = url.origin; this.space = space; this.token = token; this.catalog = catalog; this.transport = transport;
    this.journal = new TaskJournal(directory, this.origin, space);
    this.data = null; this.review = null; this.connected = false; this.error = null; this.updated = null;
  }
  async call(operation, { id, input, key, cursor, baseline } = {}) {
    const op = this.catalog.operations.find(item => item.operation_id === operation);
    if (!op || op.path.includes('{id}') && !identifier(id)) throw taskError('unsupported_operation');
    const resource = op.path.replace('{space_id}', encodeURIComponent(this.space)).replace('{id}', encodeURIComponent(id ?? ''));
    const url = new URL(resource, this.origin); if (cursor) url.searchParams.set('cursor', cursor);
    let response, result;
    try {
      response = await this.transport(url, { method: op.method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}), ...(baseline === undefined ? {} : baseline === null ? { 'If-None-Match': '*' } : { 'If-Match': '"' + baseline + '"' }) }, body: input === undefined ? undefined : JSON.stringify(input) });
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength;
        if (length > 2_000_000) throw new Error('response_limit');
        chunks.push(chunk);
      }
      result = parseBoundedJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), { maxBytes: 2_000_000, maxDepth: 32, maxNodes: 100000 });
    } catch {
      if ([401, 403].includes(response?.status)) throw Object.assign(taskError(response.status === 401 ? 'unauthenticated' : 'forbidden', 3), { httpStatus: response.status });
      throw taskError(input === undefined ? 'gateway_unavailable' : 'operation_unknown', input === undefined ? 5 : 6);
    }
    if (!response.ok) {
      const code = knownErrors.has(result?.error?.code) ? result.error.code : 'request_failed';
      throw Object.assign(taskError(code, [401, 403].includes(response.status) ? 3 : response.status >= 500 ? 5 : response.status === 409 ? 4 : 2), { httpStatus: response.status });
    }
    return result;
  }
  async refresh(cursor) {
    const [devices, capabilities, rules, commands, runs] = await Promise.all(['devices.list', 'capabilities.list', 'rules.list', 'commands.list', 'runs.list'].map(operation => this.call(operation, operation === 'commands.list' ? { cursor } : {})));
    if (!Array.isArray(devices?.items) || devices.items.length > 64 || !object(capabilities?.models) || !Array.isArray(rules?.items) || rules.items.length > 64 || !Array.isArray(commands?.items) || commands.items.length > 100 || !Array.isArray(runs?.items) || runs.items.length > 1024 || commands.next_cursor !== null && !identifier(commands.next_cursor)) throw taskError('invalid_response', 5);
    for (const device of devices.items) {
      const model = capabilities.models[device.model_revision];
      if (!identifier(device.device_id) || typeof device.ready !== 'boolean' || !model || !Array.isArray(model.services) || device.model_revision !== await documentDigest(model)) throw taskError('invalid_response', 5);
    }
    for (const deployment of rules.items) if (!object(deployment.rule) || deployment.revision !== await documentDigest(deployment.rule)) throw taskError('invalid_response', 5);
    for (const command of commands.items) await this.verifyCommand(command, command.request);
    this.data = { devices: devices.items.map(device => ({ device_id: device.device_id, model_revision: device.model_revision, ready: device.ready, last_seen: device.last_seen, reported: device.reported, action_availability: device.action_availability ?? null })), models: capabilities.models, deployments: rules.items, commands: commands.items.map(command => this.commandView(command)), runs: runs.items, next_cursor: commands.next_cursor };
    this.updated = new Date().toISOString(); this.connected = true; this.error = null;
    return this.view();
  }
  commandView(command) {
    return Object.fromEntries(['command_id', 'request', 'request_digest', 'status', 'evidence', 'error', 'run_id'].map(key => [key, command[key] ?? null]));
  }
  async verifyCommand(command, expected, previous) {
    const normalize = value => ({ ...value, expires_at: Date.parse(value?.expires_at) });
    if (!command || !identifier(command.command_id) || !this.validCommandRequest(command.request) || !this.validCommandRequest(expected) || !same(normalize(command.request), normalize(expected)) || command.request_digest !== await documentDigest(command.request) || !['accepted', 'dispatched', 'confirmed', 'unknown', 'failed', 'rejected', 'expired'].includes(command.status) || previous && command.command_id !== previous.command_id || !Object.hasOwn(command, 'error') || !Object.hasOwn(command, 'evidence') || command.run_id !== null && !identifier(command.run_id)) throw taskError('invalid_response', 6);
    if (['accepted', 'dispatched'].includes(command.status) && (command.evidence !== null || command.error !== null) || ['failed', 'rejected', 'expired', 'unknown'].includes(command.status) && (command.evidence !== null && !object(command.evidence) || typeof command.error !== 'string')) throw taskError('invalid_response', 6);
    if (command.status === 'confirmed') {
      try { await verifyConfirmedReceipt(Object.fromEntries(['command_id', 'error', 'evidence', 'request', 'request_digest', 'status'].map(key => [key, command[key]])), expected); }
      catch { throw taskError('invalid_response', 6); }
    }
    if (previous && terminal.has(previous.status) && !same(this.commandView(command), previous)) throw taskError('invalid_response', 6);
    return command;
  }
  validCommandRequest(input) {
    return exact(input, ['space_id', 'device_id', 'model_revision', 'idempotency_key', 'expires_at', 'operation']) && input.space_id === this.space && identifier(input.device_id) && identifier(input.idempotency_key) && revision(input.model_revision) && typeof input.expires_at === 'string' && Number.isFinite(Date.parse(input.expires_at)) && exact(input.operation, ['type', 'path', 'value']) && ['property.set', 'action.invoke'].includes(input.operation.type) && typeof input.operation.path === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(input.operation.path);
  }
  operations(deviceId) {
    const device = this.data?.devices.find(item => item.device_id === deviceId);
    if (!device) throw taskError('device_not_found');
    return this.data.models[device.model_revision].services.flatMap(service => [
      ...service.properties.filter(property => property.access.includes('write')).map(property => ({ type: 'property.set', path: `${service.id}.${property.id}`, schema: property.schema, current: device.reported?.[`${service.id}.${property.id}`] ?? null })),
      ...(service.actions ?? []).map(action => ({ type: 'action.invoke', path: `${service.id}.${action.id}`, schema: action.input, risk: action.risk, completion: action.completion, idempotent: action.idempotent })),
    ]);
  }
  sources() {
    if (!this.data) return [];
    const events = this.data.devices.flatMap(device => this.data.models[device.model_revision].services.flatMap(service => service.events.map(event => ({ device_id: device.device_id, path: `${service.id}.${event.id}`, schema: event.schema }))));
    const properties = this.data.devices.flatMap(device => this.data.models[device.model_revision].services.flatMap(service => service.properties.filter(property => ['integer', 'number'].includes(property.schema.type) && property.access.includes('read') && property.access.includes('notify') && typeof property.unit === 'string').map(property => ({ kind: 'property', device_id: device.device_id, path: `${service.id}.${property.id}`, unit: property.unit, schema: property.schema }))));
    return [...events, ...properties];
  }
  conditionSources() { return this.data ? conditionSources(this.data.devices, this.data.models) : []; }
  async records() {
    const records = await this.journal.list();
    for (const record of records) {
      const input = record.input;
      if (record.kind === 'command') {
        if (!this.validCommandRequest(input)) throw taskError('original_record_unavailable', 5);
        if (record.result?.outcome === 'command') await this.verifyCommand(record.result.command, input);
        else if (record.result && (record.result.outcome !== 'rejected' || !knownErrors.has(record.result.error))) throw taskError('original_record_unavailable', 5);
      } else {
        if (!exact(input, record.kind === 'rule.deploy' ? ['request_key', 'rule_id', 'rule', 'revision', 'baseline_revision'] : ['request_key', 'rule_id', 'revision']) || !identifier(input.request_key) || !identifier(input.rule_id) || !revision(input.revision) || record.kind === 'rule.deploy' && (input.rule?.id !== input.rule_id || input.revision !== await documentDigest(input.rule) || input.baseline_revision !== null && !revision(input.baseline_revision))) throw taskError('original_record_unavailable', 5);
        if (record.result && (record.result.outcome === 'rejected' ? !exact(record.result, ['outcome', 'error']) || !knownErrors.has(record.result.error) : record.result.outcome !== (record.kind === 'rule.deploy' ? 'deployed' : 'stopped'))) throw taskError('original_record_unavailable', 5);
        if (record.result?.outcome === 'deployed' && (!same(record.result.deployment?.rule, input.rule) || record.result.deployment.revision !== input.revision)) throw taskError('original_record_unavailable', 5);
        if (record.result?.outcome === 'stopped' && (record.result.rule_id !== input.rule_id || record.result.revision !== input.revision)) throw taskError('original_record_unavailable', 5);
      }
    }
    return records;
  }
  pending(record) { return record.result === null || record.result.outcome === 'command' && !terminal.has(record.result.command.status); }
  async ensureAvailable(kind, target) {
    if ((await this.records()).some(record => this.pending(record) && (kind === 'command' ? record.kind === 'command' && record.input.device_id === target : record.kind !== 'command' && record.input.rule_id === target))) throw taskError('original_task_unresolved', 4);
  }
  async prepareCommand(input) {
    this.review = null; await this.refresh();
    const device = this.data.devices.find(item => item.device_id === input.device_id);
    const member = this.operations(input.device_id).find(item => item.type === input.type && item.path === input.path);
    if (!member) throw taskError('unsupported_capability');
    if (!checkFormValue(input.value, member.schema)) throw taskError('invalid_value');
    await this.ensureAvailable('command', input.device_id);
    const request = { space_id: this.space, device_id: device.device_id, model_revision: device.model_revision, idempotency_key: randomUUID(), expires_at: new Date(Date.now() + 30000).toISOString(), operation: { type: input.type, path: input.path, value: input.value } };
    this.review = { record: await this.journal.record('command', request), before: member.current ?? null, after: input.value, capability: member, expires_at: request.expires_at };
    return this.view();
  }
  async prepareRule(rule, eventData) {
    this.review = null; await this.refresh();
    await this.ensureAvailable('rule', rule.id);
    const validation = await this.call('rules.validate', { input: rule });
    if (rule.trigger.schedule && typeof validation.schedule_preview?.scheduled_at !== 'string') throw taskError('invalid_simulation', 5);
    const event = rule.trigger.schedule ? { scheduled_at: validation.schedule_preview.scheduled_at } : rule.trigger.property ? { device_id: rule.trigger.device, path: rule.trigger.property.path, historical: false, previous: eventData?.previous, current: eventData?.current } : { device_id: rule.trigger.device, path: rule.trigger.event, historical: false, data: eventData };
    const proof = await this.call('rules.simulate', { input: { rule, event } });
    const revision = await documentDigest(rule);
    try { await verifyRuleSimulation(rule, proof, validation); } catch { throw taskError('invalid_simulation', 5); }
    const before = this.data.deployments.find(item => item.rule.id === rule.id) ?? null;
    this.review = { record: await this.journal.record('rule.deploy', { request_key: randomUUID(), rule_id: rule.id, rule, revision, baseline_revision: before?.revision ?? null }), before, after: rule, simulation: proof };
    return this.view();
  }
  async prepareStop(ruleId) {
    this.review = null; await this.refresh(); await this.ensureAvailable('rule', ruleId);
    const current = this.data.deployments.find(item => item.rule.id === ruleId);
    if (!current) throw taskError('not_found');
    this.review = { record: await this.journal.record('rule.stop', { request_key: randomUUID(), rule_id: ruleId, revision: current.revision }), before: current, after: null };
    return this.view();
  }
  async commit(taskId) {
    if (!this.review || this.review.record.task_id !== taskId) throw taskError('review_required');
    const record = structuredClone(this.review.record);
    return this.journal.locked(async () => {
      const existing = (await this.records()).find(item => item.task_id === taskId);
      if (existing) { this.review = null; return this.resolveRecord(existing); }
      await this.ensureAvailable(record.kind === 'command' ? 'command' : 'rule', record.kind === 'command' ? record.input.device_id : record.input.rule_id);
      if ((await this.records()).length >= 256) throw taskError('task_capacity_reached', 4);
      if (record.kind === 'command' && Date.parse(record.input.expires_at) <= Date.now()) { this.review = null; throw taskError('review_expired', 4); }
      if (record.kind !== 'command') {
        const latest = await this.call('rules.list');
        const current = latest.items.find(item => item.rule.id === record.input.rule_id);
        if ((current?.revision ?? null) !== (record.kind === 'rule.stop' ? record.input.revision : record.input.baseline_revision)) { this.review = null; throw taskError('revision_conflict', 4); }
      }
      await this.journal.create(record); this.review = null;
      let result;
      try {
        if (record.kind === 'command') {
          const { space_id, idempotency_key, ...body } = record.input;
          const command = await this.call('commands.create', { input: body, key: idempotency_key });
          await this.verifyCommand(command, record.input);
          result = { outcome: 'command', command: this.commandView(command) };
        } else if (record.kind === 'rule.deploy') {
          const deployment = await this.call('rules.deploy', { input: record.input.rule, baseline: record.input.baseline_revision });
          if (deployment.revision !== record.input.revision || !same(deployment.rule, record.input.rule)) throw taskError('invalid_response', 6);
          result = { outcome: 'deployed', deployment };
        } else {
          const response = await this.call('rules.stop', { id: record.input.rule_id, input: { revision: record.input.revision } });
          if (response.stopped !== true || response.rule_id !== record.input.rule_id || response.revision !== record.input.revision) throw taskError('invalid_response', 6);
          result = { outcome: 'stopped', rule_id: response.rule_id, revision: response.revision };
        }
      } catch (error) {
        if (error.httpStatus >= 400 && error.httpStatus < 500 && ![408, 429].includes(error.httpStatus)) { await this.journal.save(record, { outcome: 'rejected', error: error.safeCode }); throw error; }
        throw error.exit === 3 ? error : taskError('operation_unknown', 6);
      }
      return this.journal.save(record, result);
    });
  }
  async resolveRecord(record) {
    if (record.result?.outcome === 'rejected' || record.kind !== 'command' && record.result) return record;
    if (record.kind === 'command') {
      let command;
      try { command = await this.call('commands.resolve', { id: record.input.idempotency_key }); }
      catch (error) { if (error.safeCode === 'command_not_found') throw taskError('operation_unknown', 6); throw error; }
      await this.verifyCommand(command, record.input, record.result?.command);
      return this.journal.save(record, { outcome: 'command', command: this.commandView(command) });
    }
    const deployments = await this.call('rules.list');
    const current = deployments.items.find(item => item.rule.id === record.input.rule_id);
    // 当前相同修订也可能由另一位所有者部署，不能代替原POST的耐久决定。
    if (record.kind === 'rule.deploy' && current?.revision === record.input.revision && same(current.rule, record.input.rule)) return { ...record, observation: { currently_deployed: true, revision: current.revision }, unknown: true };
    // 停用后的当前缺席只证明当前状态，不能伪造原POST决定。
    if (record.kind === 'rule.stop' && !current) return { ...record, observation: { currently_absent: true }, unknown: true };
    throw taskError('operation_unknown', 6);
  }
  async resolve(taskId) { return this.journal.locked(async () => { const record = (await this.records()).find(item => item.task_id === taskId); if (!record) throw taskError('task_not_found'); return this.resolveRecord(record); }); }
  async view() {
    return { version: 1, origin: this.origin, space_id: this.space, connected: this.connected, updated_at: this.updated, error: this.error, snapshot: structuredClone(this.data), sources: this.data ? this.sources() : [], condition_sources: this.conditionSources(), operations: this.data ? Object.fromEntries(this.data.devices.map(device => [device.device_id, this.operations(device.device_id)])) : {}, review: this.review ? structuredClone(this.review) : null, tasks: (await this.records()).map(record => ({ ...record, pending: this.pending(record) })) };
  }
  async dispatch(action) {
    try {
      if (!object(action)) throw taskError('invalid_task_action');
      if (['commands.prepare', 'rules.prepare', 'rules.stop.prepare'].includes(action.action)) this.review = null;
      const fields = { refresh: ['action', 'cursor'], 'commands.prepare': ['action', 'device_id', 'type', 'path', 'value'], 'rules.prepare': ['action', 'rule', 'event_data'], 'rules.stop.prepare': ['action', 'rule_id'], commit: ['action', 'task_id'], resolve: ['action', 'task_id'], cancel: ['action'], snapshot: ['action'] }[action.action];
      if (!fields || Object.keys(action).some(key => !fields.includes(key))) throw taskError('invalid_task_action');
      if (fields.some(key => key !== 'cursor' && !Object.hasOwn(action, key)) || Object.hasOwn(action, 'cursor') && !identifier(action.cursor) || ['commit', 'resolve'].includes(action.action) && !/^task-[a-f0-9]{64}$/.test(action.task_id ?? '') || action.action === 'commands.prepare' && (!identifier(action.device_id) || !['property.set', 'action.invoke'].includes(action.type) || typeof action.path !== 'string' || action.path.length > 129 || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(action.path)) || action.action === 'rules.prepare' && (!object(action.rule) || !identifier(action.rule.id)) || action.action === 'rules.stop.prepare' && !identifier(action.rule_id)) throw taskError('invalid_task_action');
      // 等待分派结果，使认证失效、断线与未知响应统一清理会话状态。
      if (action.action === 'refresh') return await this.refresh(action.cursor);
      if (action.action === 'commands.prepare') return await this.prepareCommand(action);
      if (action.action === 'rules.prepare') return await this.prepareRule(action.rule, action.event_data);
      if (action.action === 'rules.stop.prepare') return await this.prepareStop(action.rule_id);
      if (action.action === 'commit') return await this.commit(action.task_id);
      if (action.action === 'resolve') return await this.resolve(action.task_id);
      if (action.action === 'cancel') this.review = null;
      return await this.view();
    } catch (error) {
      const code = error.safeCode ?? 'invalid_task_action';
      if (error.exit === 3) { this.data = null; this.review = null; this.connected = false; }
      if (['gateway_unavailable', 'invalid_response', 'operation_unknown'].includes(code)) this.connected = false;
      this.error = code;
      throw error.safeCode ? error : taskError(code);
    }
  }
}
