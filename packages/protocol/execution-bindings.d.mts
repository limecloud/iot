export interface ExecutionRoute {adapter_id:string;revision:string}
export type ExecutionChange = {type:'bindings.bind';device_id:string;route:ExecutionRoute;expected_binding_revision:string;expected_model_revision:string}|{type:'bindings.compose';device_id:string;route:ExecutionRoute;native_paths:string[];expected_native_session:string;expected_binding_revision:string;expected_model_revision:string}|{type:'bindings.revoke';device_id:string;expected_binding_revision:string};
export interface ExecutionRequest {space_id:string;idempotency_key:string;change:ExecutionChange}
export interface ExecutionBinding {device_id:string;model_revision:string;revision:string;state:'native'|'bound'|'composed'|'revoked';routes:Record<string,ExecutionRoute>;native_paths?:string[]}
export interface TelevisionAdapter {device_id:string;route:ExecutionRoute;compatible:boolean;target:string;fingerprint:string;device_serial:string;applications:{application_id:string;category:'leanback'|'launcher'}[];paths:string[]}
export interface NativeExecution {session_id:string;ready:boolean;paths:string[]}
export interface AudioAdapter {kind:'dlna';device_id:string;route:ExecutionRoute;compatible:boolean;target:string;udn:string;volume_limit:number;playback_volume:number;media:{media_id:string;expires_at:string}[];managed_media?:true}
export type ExecutionAdapter = TelevisionAdapter|AudioAdapter;
export interface ApplicationPage {device_id:string;binding_revision:string;fresh:boolean;observed_at:string|null;items:{application_id:string;authorized:boolean}[];next_cursor:null}
export interface ExecutionOperation {operation_id:string;request:ExecutionRequest;request_digest:string;status:'applied'|'conflict'|'rejected';reason:string|null;result:ExecutionBinding|null;created_at:string}
export function validExecutionChange(value:unknown):value is ExecutionChange;
export function parseExecutionChange(value:string):ExecutionChange;
export function verifyExecutionBinding(value:unknown,deviceID?:string):ExecutionBinding;
export function verifyExecutionAdapters(value:unknown):{items:ExecutionAdapter[];next_cursor:null};
export function verifyNativeExecution(value:unknown,deviceID:string,modelRevision:string):NativeExecution|null;
export function verifyApplications(value:unknown,deviceID:string):ApplicationPage;
export function verifyExecutionOperation(value:unknown,expected?:ExecutionRequest):Promise<ExecutionOperation>;
