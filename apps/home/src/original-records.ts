import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';

export interface OriginalRequest { space_id: string; idempotency_key: string; change: unknown }
export interface OriginalRecord<T extends OriginalRequest> { version: 1; origin: string; request: T }
const id = (value: unknown) => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields = (value: unknown, names: string) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names;

export function readOriginalRecords<T extends OriginalRequest>(storage: Storage, namespace: string, origin: string, space: string,
  known: OriginalRecord<T>[], validChange: (value: unknown) => boolean, maximum = 128): OriginalRecord<T>[] {
  const found: OriginalRecord<T>[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(namespace)) continue;
    const value = parseBoundedJSON(storage.getItem(key) ?? '', { maxBytes: 8192, maxDepth: 6, maxNodes: 128 }) as OriginalRecord<T>;
    if (!fields(value, 'origin,request,version') || value.version !== 1 || value.origin !== origin
      || !fields(value.request, 'change,idempotency_key,space_id') || value.request.space_id !== space
      || !id(value.request.idempotency_key) || key !== namespace + value.request.idempotency_key || !validChange(value.request.change)) throw new Error('original_record_unavailable');
    found.push(value);
  }
  if (found.length > maximum || known.some(old => !found.some(value => sameJSON(value, old)))) throw new Error('original_record_unavailable');
  return found.sort((a, b) => a.request.idempotency_key.localeCompare(b.request.idempotency_key));
}

export function saveOriginalRecord<T extends OriginalRequest>(storage: Storage, namespace: string, record: OriginalRecord<T>): void {
  const key = namespace + record.request.idempotency_key, text = JSON.stringify(record);
  if (storage.getItem(key) !== null) throw new Error('original_record_unavailable');
  storage.setItem(key, text);
  if (storage.getItem(key) !== text) throw new Error('original_record_unavailable');
}
