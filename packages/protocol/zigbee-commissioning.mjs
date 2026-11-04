import { validZigbeeProbe } from './zigbee-discovery.mjs';

const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const ieee = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value)
  && !['0000000000000000', 'ffffffffffffffff'].includes(value);

export function verifyZigbeeJoinWindowReport(value, expectedCoordinator, expectedDuration) {
  const result = value?.result;
  if (!ieee(expectedCoordinator) || !integer(expectedDuration, 120)
    || !fields(value, 'schema_version,operation,protocol,evidence,device_binding_created,network_write_requested,observed_at_unix_ms,result')
    || value.schema_version !== 1 || value.operation !== 'permit-join' || value.protocol !== 'znp'
    || value.evidence !== 'unauthenticated_protocol' || value.device_binding_created !== false || value.network_write_requested !== true
    || !integer(value.observed_at_unix_ms, Number.MAX_SAFE_INTEGER)
    || !fields(result, 'ncp,coordinator_ieee,network_address,scope,duration_seconds,trust_center_significance,status')
    || !validZigbeeProbe(result.ncp) || result.coordinator_ieee !== expectedCoordinator
    || result.network_address !== 0 || result.scope !== 'coordinator'
    || !integer(result.duration_seconds, 120) || result.duration_seconds !== expectedDuration
    || result.trust_center_significance !== 1 || result.status !== 'protocol_accepted') throw new Error('invalid_znp_tool_response');
  return value;
}
