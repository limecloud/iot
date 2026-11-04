export interface ZigbeeChange {coordinator_id:string;expected_revision:string;duration_seconds:number}
export interface ZigbeeCoordinator {coordinator_id:string;coordinator_ieee:string;revision:string;timeout_ms:number}
export interface ZigbeeRequest {space_id:string;idempotency_key:string;change:ZigbeeChange}
export interface ZigbeeOperation {
  operation_id:string;sequence:number;request:ZigbeeRequest;request_digest:string;coordinator:ZigbeeCoordinator;
  status:'unknown'|'protocol_accepted';reason:string|null;
  result:{coordinator_ieee:string;duration_seconds:number;observed_at:string}|null;
  created_at:string;blocked_until:string;completed_at:string|null;
}
export function parseZigbeeChange(text:string):ZigbeeChange;
export function verifyZigbeeCoordinators(value:unknown):{items:ZigbeeCoordinator[];next_cursor:null};
export function verifyZigbeeOperation(value:unknown,expected?:ZigbeeRequest):Promise<ZigbeeOperation>;
export function verifyZigbeeOperations(value:unknown,space?:string):Promise<{items:ZigbeeOperation[];next_cursor:null}>;
