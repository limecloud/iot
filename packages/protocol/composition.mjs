import { parseBoundedJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';
import { verifyRuleSimulation } from './rule-simulation.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value, max) => typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= max;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const reject = code => { throw new Error(code); };

export function parseComposition(raw) {
  let value;
  try { value = parseBoundedJSON(raw, { maxBytes: 32768, maxDepth: 8, maxNodes: 2048 }); }
  catch { reject('invalid_composition'); }
  if (!exact(value, ['schema_version', 'package_id', 'version', 'name', 'modules', 'rule', 'sample_event_data']) || value.schema_version !== 1 ||
      typeof value.package_id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.package_id) ||
      typeof value.version !== 'string' || !/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value.version) ||
      !text(value.name, 80) || !object(value.modules) || !object(value.sample_event_data)) reject('invalid_composition');
  const roles = Object.keys(value.modules);
  if (roles.length < 1 || roles.length > 8 || roles.some(role => !/^[a-z][a-z0-9_]{0,31}$/.test(role) ||
      !exact(value.modules[role], ['model_revision']) || !revision(value.modules[role].model_revision))) reject('invalid_composition');
  const rule = value.rule;
  if (!exact(rule, ['version', 'id', 'trigger', 'conditions', 'actions', 'cooldown_ms']) || rule.version !== 1 || !text(rule.id, 128) ||
      !exact(rule.trigger, ['device', 'event']) || !text(rule.trigger.device, 128) || typeof rule.trigger.event !== 'string' ||
      !Array.isArray(rule.conditions) || rule.conditions.length !== 0 || !Array.isArray(rule.actions) || rule.actions.length < 1 || rule.actions.length > 16 ||
      !Number.isInteger(rule.cooldown_ms) || rule.cooldown_ms < 0 || rule.cooldown_ms > 86400000 ||
      rule.actions.some(action => !exact(action, ['device', 'set']) || !text(action.device, 128) ||
        !exact(action.set, ['path', 'value']) || typeof action.set.path !== 'string')) reject('invalid_composition');
  const used = new Set([rule.trigger.device, ...rule.actions.map(action => action.device)]);
  if (used.size !== roles.length || roles.some(role => !used.has(role))) reject('composition_role_mismatch');
  return value;
}

// 只替换设备角色，保留值和路径原文；物模型语义与权限仍由网关核验。
export async function compileComposition(packageText, bindingsText, instanceID) {
  const manifest = parseComposition(packageText);
  if (!identifier(instanceID)) reject('composition_instance_id_required');
  let bindings;
  try { bindings = parseBoundedJSON(bindingsText, { maxBytes: 4096, maxDepth: 2, maxNodes: 32 }); }
  catch { reject('invalid_composition_bindings'); }
  const roles = Object.keys(manifest.modules).sort();
  if (!exact(bindings, roles) || roles.some(role => !identifier(bindings[role])) ||
      new Set(Object.values(bindings)).size !== roles.length) reject('invalid_composition_bindings');
  const rule = structuredClone(manifest.rule);
  rule.id = instanceID;
  rule.trigger.device = bindings[rule.trigger.device];
  for (const action of rule.actions) action.device = bindings[action.device];
  const permissions = [{ kind: 'event.read', device_id: rule.trigger.device, path: rule.trigger.event }];
  for (const action of rule.actions) {
    if (!permissions.some(item => item.kind === 'property.write' && item.device_id === action.device && item.path === action.set.path)) {
      permissions.push({ kind: 'property.write', device_id: action.device, path: action.set.path });
    }
  }
  return {
    schema_version: 1,
    package_id: manifest.package_id,
    package_version: manifest.version,
    package_digest: await documentDigest(manifest),
    bindings_digest: await documentDigest(bindings),
    rule_revision: await documentDigest(rule),
    expected_models: roles.map(role => ({ role, device_id: bindings[role], model_revision: manifest.modules[role].model_revision })),
    required_permissions: permissions,
    rule,
    simulation_input: { rule: structuredClone(rule), event: { device_id: rule.trigger.device, path: rule.trigger.event, historical: false, data: structuredClone(manifest.sample_event_data) } },
    gateway_checked: false,
    deployed: false,
  };
}

export async function checkCompositionModels(compiled, request, space) {
  for (const expected of compiled.expected_models) {
    const device = await request(`/api/v1/spaces/${encodeURIComponent(space)}/devices/${encodeURIComponent(expected.device_id)}`);
    if (device?.device_id !== expected.device_id || device.model_revision !== expected.model_revision) reject('composition_model_mismatch');
    if (device.ready !== true) reject('device_offline');
  }
}

// CLI与网页共用模型核对和无执行预演；传输、会话及请求取消由调用者持有。
export async function planComposition(compiled, { request, origin, space, active = () => true }) {
  const check = () => { if (!active()) reject('composition_paused'); };
  check();
  await checkCompositionModels(compiled, request, space); check();
  const base = `/api/v1/spaces/${encodeURIComponent(space)}`;
  const validation = await request(base + '/rules:validate', compiled.rule); check();
  const simulation = await request(base + '/rules:simulate', compiled.simulation_input); check();
  await verifyRuleSimulation(compiled.rule, simulation, validation); check();
  await checkCompositionModels(compiled, request, space); check();
  return { ...compiled, gateway_checked: true, checked_at: new Date().toISOString(), gateway_origin: origin, space_id: space, validation, simulation };
}

export async function parseCompositionAttempt(raw, origin, space) {
  let value;
  try { value = parseBoundedJSON(raw, { maxBytes: 65536, maxDepth: 12, maxNodes: 4096 }); }
  catch { reject('composition_record_unavailable'); }
  if (!exact(value, ['version', 'origin', 'space_id', 'package', 'bindings', 'instance_id', 'rule_revision', 'state', 'checksum']) ||
      value.version !== 1 || value.origin !== origin || value.space_id !== space || !['attempted', 'acknowledged', 'rejected'].includes(value.state)) reject('composition_record_unavailable');
  const { checksum, ...body } = value;
  if (checksum !== await documentDigest(body)) reject('composition_record_unavailable');
  let compiled;
  try { compiled = await compileComposition(JSON.stringify(value.package), JSON.stringify(value.bindings), value.instance_id); }
  catch { reject('composition_record_unavailable'); }
  if (compiled.rule_revision !== value.rule_revision) reject('composition_record_unavailable');
  return { record: value, compiled };
}
