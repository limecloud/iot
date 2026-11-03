export interface VisionRequest { image_base64:string;content_type:'image/png'|'image/jpeg';prompt:string;retain_seconds:number;expires_at:string }
export interface VisionInput { image_digest:string;image_bytes:number;content_type:'image/png'|'image/jpeg';prompt_digest:string;retain_seconds:number;expires_at:string }
export interface VisionOriginal { version:1;origin:string;space_id:string;idempotency_key:string;input:VisionInput;request_digest:string }
export interface VisionDeployment { adapter:'ollama-vision-v1';revision:string;model:string;data_location:'local' }
export interface VisionTask { vision_id:string;space_id:string;idempotency_key:string;request_digest:string;input:VisionInput;image:{width:number;height:number};deployment:VisionDeployment;created_at:string;updated_at:string;status:'running'|'succeeded'|'failed'|'unknown'|'discarded';output:{text:string|null;content_digest:string;expires_at:string;cleared_at:string|null}|null;error_code:string|null }
export type VisionCapabilities={configured:false;capability:'vision.understand'}|{configured:true;capability:'vision.understand';deployment:VisionDeployment;content_types:['image/png','image/jpeg'];max_image_bytes:2097152;max_edge:1024;max_prompt_characters:512;max_text_bytes:8192;max_characters:2048;max_deadline_seconds:90;max_retain_seconds:3600;concurrency:1;streaming:false;provider_cancellation:false;input_storage:'digest_only';device_execution:false};
export const visionRequestBytes:number;
export function parseVisionInput(raw:string):VisionRequest;
export function createVisionOriginal(origin:string,space:string,key:string,input:VisionRequest):Promise<VisionOriginal>;
export function validVisionOriginal(value:unknown,origin:string,space:string,key:string):value is VisionOriginal;
export function verifyVisionTask(value:unknown,space:string,key:string,expected?:VisionOriginal):Promise<VisionTask>;
export function verifyVisionCapabilities(value:unknown):VisionCapabilities;
