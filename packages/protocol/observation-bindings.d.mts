export interface ObservationSource {adapter_id:string;revision:string}
export interface ObservationTarget {coordinator_ieee:string;ieee_address:string;endpoint:number}
export interface ObservationSignature {manufacturer:string;model:string;application_version:number;hardware_version:number}
export interface ObservationCandidate {source:ObservationSource;model_revision:string;target:ObservationTarget;manufacturer_code:number;signature:ObservationSignature;observed_at:string;expires_at:string;protocol:'zigbee-znp';evidence:'unauthenticated_protocol';write_paths?:['light.power']}
export interface ObservationCandidates {coordinators:{coordinator_id:string;coordinator_ieee:string;timeout_ms:number;protocol:'zigbee-znp'}[];items:ObservationCandidate[];next_cursor:null}
export interface ObservationQuery {coordinator_id:string;ieee_address:string;endpoint:number;profile?:'on_off'}
export type ObservationChange = {type:'sources.bind';device_id:string;source:ObservationSource;expected_binding_revision:string;expected_model_revision:string}|{type:'sources.revoke';device_id:string;expected_binding_revision:string};
export interface ObservationRequest {space_id:string;idempotency_key:string;change:ObservationChange}
export interface ObservationBinding {device_id:string;revision:string;binding:{policy:{device_id:string;model_revision:string;source:ObservationSource};manifest:Record<string,unknown>;active:boolean;generation:string;changed_at:string;write_paths?:['light.power']}|null}
export interface ObservationOperation {operation_id:string;sequence:number;request:ObservationRequest;request_digest:string;status:'applied'|'rejected'|'conflict';reason:string|null;result:ObservationBinding|null;created_at:string}
export function validObservationChange(value:unknown):value is ObservationChange;
export function parseObservationChange(text:string):ObservationChange;
export function parseObservationQuery(text:string):ObservationQuery;
export function verifyObservationCandidate(value:unknown):Promise<ObservationCandidate>;
export function verifyObservationCandidates(value:unknown):Promise<ObservationCandidates>;
export function verifyObservationBinding(value:unknown,device?:string):Promise<ObservationBinding>;
export function verifyObservationOperation(value:unknown,expected?:ObservationRequest):Promise<ObservationOperation>;
