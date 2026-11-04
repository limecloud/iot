import { parseBoundedJSON, sameJSON } from './products.mjs';

const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const ieee = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value)
  && !['0000000000000000', 'ffffffffffffffff'].includes(value);
const signature = value => fields(value, 'manufacturer,model,application_version,hardware_version')
  && ['manufacturer', 'model'].every(key => typeof value[key] === 'string' && value[key].trim().length > 0
    && new TextEncoder().encode(value[key]).length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value[key]))
  && ['application_version', 'hardware_version'].every(key => integer(value[key], 0, 255));
const fail = () => { throw new Error('invalid_znp_tool_response'); };

export function parseZigbeeOnOffSignature(text) {
  const value = parseBoundedJSON(text, { maxBytes: 1024, maxDepth: 2, maxNodes: 16 });
  if (!signature(value)) throw new Error('invalid_znp_input');
  return value;
}

export function verifyZigbeeOnOffReport(value, expected) {
  const write = value?.operation === 'set-onoff';
  if (!fields(value, 'schema_version,operation,protocol,evidence,device_binding_created,observed_at_unix_ms,result' + (write ? ',device_write_requested' : ''))
    || value.schema_version !== 1 || !['read-onoff', 'set-onoff'].includes(value.operation)
    || value.protocol !== 'znp' || value.evidence !== 'unauthenticated_protocol' || value.device_binding_created !== false
    || !integer(value.observed_at_unix_ms, 0, Number.MAX_SAFE_INTEGER) || write && value.device_write_requested !== true) fail();
  const result = value.result;
  if (!fields(result, 'coordinator_ieee,ieee_address,network_address,endpoint,manufacturer_code,signature,'
      + (write ? 'power_requested,status,device_state_confirmed,accepted_at_unix_ms' : 'power'))
    || !ieee(result.coordinator_ieee) || !ieee(result.ieee_address) || result.coordinator_ieee === result.ieee_address
    || !integer(result.network_address, 1, 0xfff7) || !integer(result.endpoint, 1, 240)
    || !integer(result.manufacturer_code, 0, 0xffff) || !signature(result.signature)) fail();
  if (expected && ['coordinator_ieee', 'ieee_address', 'endpoint'].some(key => result[key] !== expected[key])) fail();
  if (write) {
    if (typeof result.power_requested !== 'boolean' || result.status !== 'protocol_accepted' || result.device_state_confirmed !== false
      || !integer(result.accepted_at_unix_ms, 0, value.observed_at_unix_ms)
      || expected && (result.power_requested !== expected.power || result.manufacturer_code !== expected.manufacturer_code
        || !sameJSON(result.signature, expected.signature))) fail();
  } else if (!fields(result.power, 'value,received_at_unix_ms') || typeof result.power.value !== 'boolean'
    || !integer(result.power.received_at_unix_ms, 0, value.observed_at_unix_ms)) fail();
  return value;
}
