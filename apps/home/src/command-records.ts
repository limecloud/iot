import { parseBoundedJSON, sameJSON } from '../../../packages/protocol/products.mjs';

export interface CommandInput { device_id: string; model_revision: string; expires_at: string; operation: { type: string; path: string; value: unknown } }
export interface PendingCommand { key: string; space: string; input?: CommandInput }
export type PendingCommands = Record<string, PendingCommand>;
export const commandStorageKey = 'limeiot.pending';
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function decode(text: string | null): PendingCommands {
  const value = parseBoundedJSON(text ?? '{}', { maxBytes: 262144, maxDepth: 24, maxNodes: 32768 });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw new Error('command_record_unavailable');
  for (const [device, entry] of Object.entries(value)) {
    if (!id(device) || !entry || typeof entry !== 'object' || Array.isArray(entry) || !id(entry.key) ||
        typeof entry.space !== 'string' || !/^\/api\/v1\/spaces\/[A-Za-z0-9_-]{1,128}$/.test(entry.space) ||
        Object.keys(entry).sort().join(',') !== (entry.input === undefined ? 'key,space' : 'input,key,space')) throw new Error('command_record_unavailable');
    if (entry.input !== undefined) {
      const input = entry.input, operation = input?.operation;
      if (!input || Object.keys(input).sort().join(',') !== 'device_id,expires_at,model_revision,operation' || input.device_id !== device ||
          !/^sha256:[a-f0-9]{64}$/.test(input.model_revision) || typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at)) ||
          !operation || Object.keys(operation).sort().join(',') !== 'path,type,value' || !['property.set', 'action.invoke'].includes(operation.type) ||
          typeof operation.path !== 'string' || !/^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$/.test(operation.path)) throw new Error('command_record_unavailable');
    }
  }
  return value as PendingCommands;
}

export function readCommandRecords(storage: Storage, legacy: Storage): PendingCommands {
  const current = decode(storage.getItem(commandStorageKey)), previous = decode(legacy.getItem(commandStorageKey));
  for (const [device, entry] of Object.entries(previous)) {
    const saved = current[device];
    if (saved && !sameJSON(saved, entry) && !(entry.input === undefined && entry.key === saved.key && entry.space === saved.space)) throw new Error('command_record_unavailable');
    if (!saved) current[device] = entry;
  }
  if (Object.keys(current).length > 128) throw new Error('command_record_unavailable');
  return current;
}

export function writeCommandRecords(storage: Storage, legacy: Storage, records: PendingCommands): void {
  const text = JSON.stringify(records); decode(text);
  storage.setItem(commandStorageKey, text);
  if (storage.getItem(commandStorageKey) !== text) throw new Error('command_record_unavailable');
  legacy.removeItem(commandStorageKey);
  if (legacy.getItem(commandStorageKey) !== null) throw new Error('command_record_unavailable');
}
