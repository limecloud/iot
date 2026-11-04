import { parseBoundedJSON } from './products.mjs';
import { validZigbeeNeighborItems } from './zigbee-discovery.mjs';

const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const integer = (value, maximum, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const id = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const ieee = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value) && !['0000000000000000', 'ffffffffffffffff'].includes(value);
const fail = () => { throw new Error('invalid_observation_response'); };

export function parseObservationDiscoveryQuery(text, endpoints = false) {
  const value = parseBoundedJSON(text, { maxBytes: 4096, maxDepth: 4, maxNodes: 64 });
  if (!fields(value, endpoints ? 'coordinator_id,ieee_address' : 'coordinator_id') || !id(value.coordinator_id)
    || endpoints && !ieee(value.ieee_address)) throw new Error('invalid_observation_query');
  return value;
}

function common(value, expected) {
  if (!id(value.coordinator_id) || !ieee(value.coordinator_ieee)
    || value.protocol !== 'zigbee-znp' || value.evidence !== 'unauthenticated_protocol'
    || !['observed_at', 'expires_at'].every(key => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key])))
    || Date.parse(value.expires_at) <= Date.parse(value.observed_at)
    || Date.parse(value.expires_at) - Date.parse(value.observed_at) > 60000
    || expected && (expected.coordinator_id !== value.coordinator_id
      || expected.coordinator_ieee !== undefined && expected.coordinator_ieee !== value.coordinator_ieee)) fail();
}
export function verifyObservationDiscovery(value, expected) {
  if (!fields(value, 'coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,scope,items')) fail();
  common(value, expected);
  if (value.scope !== 'coordinator_neighbors' || !validZigbeeNeighborItems(value.items, value.coordinator_ieee)) fail();
  return value;
}
export function verifyObservationEndpoints(value, expected) {
  if (!fields(value, 'coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,ieee_address,network_address,manufacturer_code,endpoints')) fail();
  common(value, expected);
  if (!ieee(value.ieee_address) || value.ieee_address === value.coordinator_ieee
    || expected?.ieee_address !== undefined && expected.ieee_address !== value.ieee_address
    || !integer(value.network_address, 0xfff7, 1) || !integer(value.manufacturer_code, 65535)
    || !Array.isArray(value.endpoints) || value.endpoints.length > 16
    || new Set(value.endpoints.map(item => item?.endpoint)).size !== value.endpoints.length) fail();
  for (const item of value.endpoints) {
    if (!fields(item, 'endpoint,profile_id,device_id,device_version,input_clusters,output_clusters')
      || !integer(item.endpoint, 240, 1) || !integer(item.profile_id, 65535) || !integer(item.device_id, 65535) || !integer(item.device_version, 15)
      || !['input_clusters', 'output_clusters'].every(key => Array.isArray(item[key]) && item[key].length <= 32
        && new Set(item[key]).size === item[key].length && item[key].every(value => integer(value, 65535)))) fail();
  }
  return value;
}

export const supportsEnvironmentEndpoint = endpoint => endpoint.profile_id === 0x0104 && [0, 0x0402, 0x0405].every(cluster => endpoint.input_clusters.includes(cluster));
export const supportsOnOffEndpoint = endpoint => endpoint.profile_id === 0x0104 && [0, 6].every(cluster => endpoint.input_clusters.includes(cluster));
