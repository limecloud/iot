import { validObservationChange, type ObservationRequest } from '../../../packages/protocol/observation-bindings.mjs';
import { readOriginalRecords, saveOriginalRecord } from './original-records';

export interface ObservationRecord { version: 1; origin: string; request: ObservationRequest }
export function readObservationRecords(storage: Storage, namespace: string, origin: string, space: string, known: ObservationRecord[]): ObservationRecord[] {
  try { return readOriginalRecords(storage, namespace, origin, space, known, validObservationChange); }
  catch { throw new Error('observation_record_unavailable'); }
}

export function saveObservationRecord(storage: Storage, namespace: string, record: ObservationRecord): void {
  try { saveOriginalRecord(storage, namespace, record); }
  catch { throw new Error('observation_record_unavailable'); }
}
