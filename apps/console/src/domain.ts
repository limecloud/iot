export interface Space { space_id:string; name:string; created_at:string }
export interface Gateway { gateway_id:string; space_id:string; principal_id:string; local_space_id:string; revision:string; active:boolean; scopes:string[]; created_at:string }
export interface Connection { connected:boolean; binding_revision?:string; last_seen_at?:string }
export interface Observation { value:unknown; observed_at:string; quality:string }
export interface Device { device_id:string; model_revision:string; ready:boolean; last_seen:string|null; reported:Record<string,Observation> }
export interface Property { id:string; schema:{ type:string; minimum?:number; maximum?:number }; access:string[] }
export interface Model { model_id:string; services:{id:string;properties:Property[]}[] }
export interface SpaceInput { request_key:string; name:string }
export interface PairInput { request_key:string; scopes:string[] }
export interface RemoteInput { request_key:string; gateway_id:string; binding_revision:string; device_id:string; model_revision:string; expires_at:string; operation:{type:'property.set';path:string;value:unknown} }
export interface Remote { remote_id:string; status:string; request:RemoteInput; local_result:{command_id?:string;status?:string;error?:string|null;evidence?:{type?:string}}|null; created_at:string }
interface Original { version:1; id:string; created_at:string; space_id:string; resolved?:boolean; rejection?:string }
export type Entry = Original & ({ kind:'space';request:SpaceInput;result?:Space } | { kind:'pair';request:PairInput } | { kind:'remote';request:RemoteInput;result?:Remote });

// 每个原操作独立保存，避免多个标签页改写同一JSON映射时丢失其他原键。
export function journal(principal:string) {
  const prefix=`limeiot.control:v1:${principal}:`;
  function save(entry:Entry){const key=prefix+entry.id,raw=JSON.stringify(entry);localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw new Error('local_record_unavailable')}
  function list():Entry[]{
    const out:Entry[]=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(prefix))continue;
      const value=JSON.parse(localStorage.getItem(key)??'null') as Entry;
      if(!value||value.version!==1||!['space','pair','remote'].includes(value.kind)||typeof value.id!=='string'||key!==prefix+value.id||typeof value.space_id!=='string'||value.request?.request_key!==value.id)throw new Error('local_record_invalid');
      out.push(value);
    }
    return out.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }
  return {save,list};
}
export function original(){return {version:1 as const,id:crypto.randomUUID(),created_at:new Date().toISOString()}}
export function validRemote(result:Remote, entry:Entry&{kind:'remote'}):boolean {
  return /^remote-[a-f0-9]{64}$/.test(result?.remote_id??'') && ['accepted','dispatched','unknown','confirmed','failed','rejected','expired'].includes(result.status) &&
    result.request?.request_key===entry.id && result.request.gateway_id===entry.request.gateway_id && result.request.binding_revision===entry.request.binding_revision &&
    result.request.device_id===entry.request.device_id && result.request.model_revision===entry.request.model_revision && Date.parse(result.request.expires_at)===Date.parse(entry.request.expires_at) &&
    result.request.operation?.type===entry.request.operation.type && result.request.operation.path===entry.request.operation.path && JSON.stringify(result.request.operation.value)===JSON.stringify(entry.request.operation.value) &&
    (result.status!=='confirmed'||result.local_result?.evidence?.type==='device_result');
}
