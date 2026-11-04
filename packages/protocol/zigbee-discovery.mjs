const fields = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const integer = (value, maximum, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const extended = value => typeof value === 'string' && value.length === 16 && /^[a-f0-9]{16}$/.test(value);
const ieee = value => extended(value) && !['0000000000000000', 'ffffffffffffffff'].includes(value);
const fail = () => { throw new Error('invalid_znp_tool_response'); };

export function validZigbeeProbe(ncp) {
  return fields(ncp, 'capabilities,transport_revision,product_id,major,minor,maintenance,version_extension')
    && integer(ncp.capabilities, 65535) && (ncp.capabilities & 0x11) === 0x11
    && ['transport_revision', 'product_id', 'major', 'minor', 'maintenance'].every(key => integer(ncp[key], 255))
    && Array.isArray(ncp.version_extension) && ncp.version_extension.length <= 11 && ncp.version_extension.every(value => integer(value, 255));
}

export function validZigbeeNeighborItems(items, coordinator) {
  if (!Array.isArray(items) || items.length > 64) return false;
  const addresses = new Set(), identities = new Set();
  for (const item of items) {
    if (!fields(item, 'extended_pan_id,ieee_address,network_address,device_type,rx_on_when_idle,relationship,flags,permit_joining,depth,link_quality')
      || !extended(item.extended_pan_id) || !ieee(item.ieee_address) || item.ieee_address === coordinator
      || !integer(item.network_address, 0xfff7, 1) || addresses.has(item.network_address) || identities.has(item.ieee_address)
      || !integer(item.flags, 255) || item.device_type !== (item.flags & 3) || item.rx_on_when_idle !== ((item.flags >> 2) & 3)
      || item.relationship !== ((item.flags >> 4) & 7)
      || !['permit_joining', 'depth', 'link_quality'].every(key => integer(item[key], 255))) return false;
    addresses.add(item.network_address); identities.add(item.ieee_address);
  }
  return true;
}

export function verifyZigbeeNeighborsReport(value, expectedCoordinator) {
  if (!fields(value, 'schema_version,operation,protocol,evidence,device_binding_created,observed_at_unix_ms,result')
    || value.schema_version !== 1 || value.operation !== 'neighbors' || value.protocol !== 'znp'
    || value.evidence !== 'unauthenticated_protocol' || value.device_binding_created !== false
    || !integer(value.observed_at_unix_ms, Number.MAX_SAFE_INTEGER)) fail();
  const result = value.result;
  if (!fields(result, 'ncp,coordinator_ieee,network_address,scope,table_entries,page_count,items')
    || !ieee(result.coordinator_ieee) || result.coordinator_ieee !== expectedCoordinator
    || result.network_address !== 0 || result.scope !== 'coordinator_neighbors'
    || !integer(result.table_entries, 64) || !integer(result.page_count, 64, 1)
    || result.page_count > Math.max(1, result.table_entries)
    || !Array.isArray(result.items) || result.items.length !== result.table_entries) fail();
  if (!validZigbeeProbe(result.ncp)) fail();
  if (!validZigbeeNeighborItems(result.items, result.coordinator_ieee)) fail();
  return value;
}
