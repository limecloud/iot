import type { TranscriptionOriginal } from './transcription.mjs';
import type { TextOriginal } from './text.mjs';
import type { SpeechOriginal } from './speech.mjs';
export type VoiceStage = 'transcription' | 'text' | 'speech';
export interface VoiceObservation { identity_digest:string; terminal_digest:string|null; status:'running'|'succeeded'|'failed'|'unknown'|'discarded'; updated_at:string; output:{content_digest:string;expires_at:string;cleared_at:string|null}|null; media_id:string|null }
export interface VoiceJob<T> { original:T; observation:VoiceObservation|null; rejected_code:string|null; discard_attempted:boolean }
export interface VoiceTextContext { instructions:string;history:Array<{role:'user'|'assistant';content:string}> }
export interface VoiceTurn { version:1|2;text_context?:{digest:string;history_messages:number};origin:string;space_id:string;turn_id:string;created_at:string;expires_at:string;source:{media_id:string;content_digest:string;expires_at:string};language:'auto'|'zh'|'en';voice:string;retain_seconds:600;deployments:Record<VoiceStage,string>;jobs:{transcription:VoiceJob<TranscriptionOriginal>|null;text:VoiceJob<TextOriginal>|null;speech:VoiceJob<SpeechOriginal>|null};stopped:boolean;checksum:string }
export interface VoiceTurnInput { turn_id:string;media_id:string;language:'auto'|'zh'|'en';voice:string }
export interface VoiceTurnView { record:VoiceTurn;phase:'ready'|'running'|'unknown'|'failed'|'discarded'|'succeeded'|'stopped'|'expired';stage:VoiceStage|null;transcript:string|null;answer:string|null;media_id:string|null }
export interface VoiceJournal { load():Promise<string|null>;save(previous:VoiceTurn|null,next:VoiceTurn):Promise<void> }
export const voiceTurnLimits:{readonly max_seconds:300;readonly calls_per_stage:1;readonly stages:readonly VoiceStage[];readonly playback:false;readonly memory:false};
export function parseVoiceTurn(raw:string,origin:string,space:string,options?:{contextual?:boolean}):Promise<VoiceTurn>;
export function parseVoiceTextContext(raw:string):VoiceTextContext;
export class VoiceTurnClient {
  constructor(options:{origin:string;space:string;journal:VoiceJournal;request:(resource:string,input?:unknown,key?:string)=>Promise<unknown>;signal?:AbortSignal;active?:()=>boolean;now?:()=>number;contextual?:boolean;textContext?:VoiceTextContext;deadline?:number});
  load():Promise<VoiceTurn|null>;
  start(input:VoiceTurnInput):Promise<VoiceTurnView>;
  resolve():Promise<VoiceTurnView>;
  continue():Promise<VoiceTurnView>;
  stop():Promise<VoiceTurnView>;
}
