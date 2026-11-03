export const MAX_AUDIO_BYTES: number;
export interface AudioFormat {sample_rate:number;channels:number;bits_per_sample:16;frames:number}
export type MediaChange = {type:'media.upload';content_base64:string;retain_seconds:number}|{type:'media.delete';media_id:string}|{type:'media.grant';media_id:string;device_id:string;expected_binding_revision:string;valid_for_seconds:number}|{type:'media.revoke';grant_id:string};
export interface MediaMetadata {media_id:string;space_id:string;content_type:'audio/wav';purpose:'device_playback';actor:'local_owner';byte_length:number;content_digest:string;audio:AudioFormat;created_at:string;expires_at:string}
export interface MediaGrant {grant_id:string;media_id:string;device_id:string;binding_revision:string;created_at:string;expires_at:string;active_in_process:boolean;binding_current:boolean;revoked_at:string|null;pulls:{prepared_at:string;method:'GET'|'HEAD';range_start:number;range_end:number;status:200|206}[]}
export interface MediaPage {space_id:string;configured:boolean;items:{metadata:MediaMetadata;available:boolean;deleted_at:string|null}[];grants:MediaGrant[];next_cursor:null}
export type MediaResult = {type:'uploaded';media:MediaMetadata}|{type:'deleted';media_id:string}|{type:'granted';grant_id:string;media_id:string;device_id:string;binding_revision:string;created_at:string;expires_at:string;issued_in_process:boolean}|{type:'revoked';grant_id:string};
export interface MediaOperation {space_id:string;operation_id:string;idempotency_key:string;request_digest:string;kind:MediaChange['type'];created_at:string;result:MediaResult}
export type MediaSummary = Exclude<MediaChange,{type:'media.upload'}>|{type:'media.upload';content_digest:string;byte_length:number;audio:AudioFormat;retain_seconds:number};
export interface MediaOriginal {version:1;origin:string;space_id:string;idempotency_key:string;request_digest:string;change:MediaSummary}
export function validMediaChange(value:unknown):value is MediaChange;
export function parseMediaChange(text:string):MediaChange;
export function verifyPcmWav(bytes:Uint8Array):AudioFormat;
export function verifyMediaPage(value:unknown,space:string):MediaPage;
export function createMediaOriginal(origin:string,space:string,key:string,change:MediaChange):Promise<MediaOriginal>;
export function validMediaOriginal(value:unknown,origin:string,space:string):value is MediaOriginal;
export function verifyMediaOperation(value:unknown,space:string,key:string,original?:MediaOriginal):MediaOperation;
