export interface TranscriptionInput { media_id:string;media_digest:string;language:'auto'|'zh'|'en';expires_at:string }
export interface TranscriptionOriginal { version:1;origin:string;space_id:string;idempotency_key:string;input:TranscriptionInput;request_digest:string }
export interface TranscriptionDeployment { adapter:'local-http-transcription-v1';revision:string;model:string;data_location:'local' }
export interface TranscriptionTask { transcription_id:string;space_id:string;idempotency_key:string;request_digest:string;input:TranscriptionInput;deployment:TranscriptionDeployment;created_at:string;updated_at:string;status:'running'|'succeeded'|'failed'|'unknown'|'discarded';output:{text:string|null;content_digest:string;expires_at:string;cleared_at:string|null}|null;error_code:string|null }
export type TranscriptionCapabilities={configured:false;capability:'audio.transcribe'}|{configured:true;capability:'audio.transcribe';deployment:TranscriptionDeployment;languages:['auto','zh','en'];concurrency:1;max_audio_bytes:4194304;max_audio_seconds:60;max_text_bytes:8192;max_characters:2048;max_deadline_seconds:90;streaming:false;provider_cancellation:false};
export function parseTranscriptionInput(text:string):TranscriptionInput;
export function createTranscriptionOriginal(origin:string,space:string,key:string,input:TranscriptionInput):Promise<TranscriptionOriginal>;
export function validTranscriptionOriginal(value:unknown,origin:string,space:string,key:string):value is TranscriptionOriginal;
export function verifyTranscriptionCapabilities(value:unknown):TranscriptionCapabilities;
export function verifyTranscriptionTask(value:unknown,space:string,key:string,expected?:TranscriptionOriginal):Promise<TranscriptionTask>;
