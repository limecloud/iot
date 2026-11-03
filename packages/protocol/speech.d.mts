export interface SpeechInput { text:string;voice:string;retain_seconds:number;expires_at:string }
export interface SpeechDeployment { adapter:'local-http-speech-v1';revision:string;model:string;data_location:'local' }
export type SpeechCapabilities = {configured:false;capability:'audio.synthesize'}|{configured:true;capability:'audio.synthesize';deployment:SpeechDeployment;voices:string[];concurrency:1;max_text_bytes:4096;max_characters:1000;max_output_bytes:4194304;max_audio_seconds:60;max_deadline_seconds:90;streaming:false;provider_cancellation:false};
export interface SpeechOriginal { version:1;origin:string;space_id:string;idempotency_key:string;request_digest:string;input_digest:string;input_characters:number;voice:string;retain_seconds:number;expires_at:string }
export interface SpeechTask { synthesis_id:string;space_id:string;idempotency_key:string;request_digest:string;input_digest:string;input_characters:number;voice:string;retain_seconds:number;expires_at:string;deployment:SpeechDeployment;created_at:string;updated_at:string;status:'running'|'succeeded'|'failed'|'unknown'|'discarded';media_id:string|null;error_code:string|null }
export function parseSpeechInput(text:string):SpeechInput;
export function createSpeechOriginal(origin:string,space:string,key:string,input:SpeechInput):Promise<SpeechOriginal>;
export function validSpeechOriginal(value:unknown,origin:string,space:string,key:string):value is SpeechOriginal;
export function verifySpeechTask(value:unknown,space:string,key:string,expected?:SpeechOriginal):SpeechTask;
export function verifySpeechCapabilities(value:unknown):SpeechCapabilities;
