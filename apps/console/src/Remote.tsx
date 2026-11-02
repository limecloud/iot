import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, statusText, terminal, when, type Call, type Session } from '@limeiot/control-ui/api.ts';
import { journal, original, validRemote, type Connection, type Device, type Entry, type Gateway, type Model, type Property, type Remote, type Space } from './domain';

export function RemotePanel({session,call,space,view}:{session:Session;call:Call;space:Space;view:'devices'|'operations'}){
  const [devices,setDevices]=useState<Device[]>([]),[models,setModels]=useState<Record<string,Model>>({}),[binding,setBinding]=useState<Gateway>(),[connected,setConnected]=useState(false),[entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState(''),[readError,setReadError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[storageOK,setStorageOK]=useState(true);
  const alive=useRef(true),sending=useRef(false),reading=useRef(false),log=journal(session.principal.principal_id),prefix=`/api/console/v1/spaces/${encodeURIComponent(space.space_id)}`;
  function records(){try{setEntries(log.list().filter(e=>e.space_id===space.space_id));setStorageOK(true)}catch{setStorageOK(false);setError('无法读取本地原操作记录，请检查浏览器存储设置')}}
  async function refresh(){if(reading.current)return;reading.current=true;try{
    const result=await call<{gateways:Gateway[]}>(`${prefix}/gateways`);if(!alive.current)return;
    const current=result.gateways.find(g=>g.active&&g.principal_id===session.principal.principal_id);setBinding(current);
    if(!current){setConnected(false);setDevices([]);setModels({});return}
    const connection=await call<Connection>(`${prefix}/gateways/${encodeURIComponent(current.gateway_id)}/connection`);if(!alive.current)return;setConnected(connection.connected&&connection.binding_revision===current.revision);
    if(!connection.connected){setDevices([]);setModels({});return}
    if(view==='operations'||!current.scopes.includes('devices.read')){setDevices([]);setModels({});return}
    const all:Device[]=[];let after='';
    for(let page=0;page<8;page++){const value=await call<{items:Device[];next:string|null;binding_revision:string}>(`${prefix}/devices${after?`?after=${encodeURIComponent(after)}`:''}`);if(value.binding_revision!==current.revision)throw new Error('binding_changed');all.push(...value.items);if(!value.next)break;if(value.next===after)throw new Error('invalid_cursor');after=value.next}
    const revisions=[...new Set(all.map(d=>d.model_revision))],nextModels:Record<string,Model>={};
    for(const revision of revisions){const value=await call<{revision:string;model:Model}>(`${prefix}/model-releases/${encodeURIComponent(revision)}`);if(value.revision!==revision)throw new Error('invalid_model');nextModels[revision]=value.model}
    if(alive.current){setDevices(all);setModels(nextModels);setReadError('')}
  }catch(e){if(alive.current){setConnected(false);setDevices([]);setModels({});setReadError(errorText(e))}}finally{reading.current=false;if(alive.current)setLoaded(true)}}
  useEffect(()=>{records();void refresh();const changed=()=>records(),visible=()=>{if(document.visibilityState==='visible')void refresh()};addEventListener('storage',changed);document.addEventListener('visibilitychange',visible);const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh()},5000);
    const offline=()=>setConnected(false);addEventListener('offline',offline);addEventListener('online',visible);
    return()=>{alive.current=false;clearInterval(timer);removeEventListener('storage',changed);removeEventListener('offline',offline);removeEventListener('online',visible);document.removeEventListener('visibilitychange',visible)};
  },[]);
  async function recover(entry:Entry){if(entry.kind!=='remote'||sending.current)return;sending.current=true;setBusy(true);setError('');setMessage('');try{
    let result=await call<Remote>(`${prefix}/remote-commands/by-key/${encodeURIComponent(entry.id)}`);
    if(!validRemote(result,entry))throw new Error('invalid_original_response');
    if(!terminal(result.status)&&connected)result=await call<Remote>(`${prefix}/remote-commands/${encodeURIComponent(result.remote_id)}/reconcile`,{});
    if(!validRemote(result,entry))throw new Error('invalid_original_response');
    log.save({...entry,result});if(alive.current){records();if(!terminal(result.status))setMessage('原操作尚未确认，请稍后继续查询')}
  }catch(e){if(alive.current){setError(e instanceof ApiError&&e.status===404?'尚未查到原操作。请保留记录，稍后再次查询':errorText(e))}}finally{sending.current=false;if(alive.current)setBusy(false)}}
  async function control(device:Device,path:string,value:unknown){if(sending.current||!binding||!connected||!storageOK||!navigator.onLine)return;
    // 每次提交前重新读取其他标签页的原记录；未解决的操作不自动生成新键补发。
    let current:Entry[];try{current=log.list()}catch{setStorageOK(false);setError('无法读取本地原操作记录，尚未发送命令');return}
    if(current.some(e=>e.kind==='remote'&&e.space_id===space.space_id&&e.request.device_id===device.device_id&&!e.rejection&&!terminal(e.result?.status))){records();setMessage('请先查询此设备的原操作');return}
    sending.current=true;setBusy(true);setError('');setMessage('');let saved=false;const base=original();
    const entry:Entry={...base,kind:'remote',space_id:space.space_id,request:{request_key:base.id,gateway_id:binding.gateway_id,binding_revision:binding.revision,device_id:device.device_id,model_revision:device.model_revision,expires_at:new Date(Date.now()+25000).toISOString(),operation:{type:'property.set',path,value}}};
    try{log.save(entry);saved=true;const result=await call<Remote>(`${prefix}/remote-commands`,entry.request);if(!validRemote(result,entry))throw new Error('invalid_original_response');log.save({...entry,result});if(alive.current){records();setMessage(statusText[result.status]??'请查询原操作')}}catch(e){
      // 仅采用本站明确的受理前拒绝；超时、5xx存储故障、异参和未知响应都保留待核实身份。
      const rejected=saved&&e instanceof ApiError&&['authentication_required','identity_rejected','forbidden','csrf_rejected','origin_rejected','host_rejected','not_found','invalid_request','invalid_expiry','remote_capacity_reached','gateway_offline'].includes(e.code);
      if(rejected){try{log.save({...entry,rejection:e.code})}catch{}}
      if(alive.current){records();setError(rejected?errorText(e):saved?'操作结果尚未确认，请查询原操作':'无法保存本地原操作记录，尚未发送命令')}
    }finally{sending.current=false;if(alive.current)setBusy(false)}
  }
  const originals=entries.filter((e):e is Entry&{kind:'remote'}=>e.kind==='remote');
  return <section aria-label={view==='devices'?'设备':'操作记录'}><div className="toolbar"><span className={connected?'status':'muted'}>{loaded?(binding?(connected?'网关已连接':'网关未连接'):'尚未绑定网关'):'正在读取网关…'}</span><button disabled={busy} onClick={()=>void refresh()}>刷新状态</button></div>{(error||readError)&&<p role="alert" className="notice error">{error||readError}</p>}{message&&<p role="status" className="notice">{message}</p>}
    {view==='devices'&&<>{loaded&&!binding&&<a href={`/console/?space=${encodeURIComponent(space.space_id)}&view=gateways`}>绑定本地网关</a>}<div className="grid">{devices.map(device=>{
      const model=models[device.model_revision],properties=model?.services.flatMap(s=>s.properties.map(p=>({...p,path:`${s.id}.${p.id}`})))??[],pending=originals.find(e=>e.request.device_id===device.device_id&&!e.rejection&&!terminal(e.result?.status)),latest=originals.find(e=>e.request.device_id===device.device_id);
      const title=properties.some(p=>p.path==='light.power')?'环境灯':model?.services.some(s=>s.id==='button')?'无线按钮':device.device_id;
      return <article className="device" key={device.device_id} aria-label={title}><div className="device-top"><div><h2>{title}</h2><span className="id muted">{device.device_id}</span></div><span className="small muted">{device.ready&&connected?'在线':'离线'}</span></div>{properties.map(property=><PropertyControl key={property.path} property={property} device={device} disabled={busy||!device.ready||!connected||!binding?.scopes.includes('commands.write')||!!pending||!storageOK} onSet={value=>void control(device,property.path,value)}/>)}{properties.length===0&&<p className="muted">等待设备事件</p>}{latest&&<p className={`small status ${latest.rejection?'rejected':latest.result?.status??'unknown'}`} role="status">最近操作：{latest.rejection?'请求已拒绝':statusText[latest.result?.status??'unknown']}</p>}{latest&&!latest.rejection&&!terminal(latest.result?.status)&&<button disabled={busy} onClick={()=>void recover(latest)}>查询原操作</button>}<details><summary>设备与物模型</summary><dl><dt>最后连接</dt><dd>{when(device.last_seen)}</dd><dt>模型修订</dt><dd>{device.model_revision}</dd></dl><pre>{JSON.stringify(model,null,2)}</pre></details></article>;
    })}</div></>}
    {view==='operations'&&<>{originals.length===0?<p className="empty">此浏览器尚无远程操作记录。</p>:<div className="table-scroll"><table><thead><tr><th>设备与操作</th><th>原操作</th><th>状态</th><th></th></tr></thead><tbody>{originals.map(entry=><tr key={entry.id}><td>{entry.request.device_id}<span className="id muted">{entry.request.operation.path} = {String(entry.request.operation.value)}</span><span className="small muted">{when(entry.created_at)}</span></td><td><span className="id">{entry.result?.remote_id??entry.id}</span></td><td><span className={`status ${entry.rejection?'rejected':entry.result?.status??'unknown'}`}>{entry.rejection?'请求已拒绝':statusText[entry.result?.status??'unknown']}</span>{entry.result?.local_result?.evidence?.type==='device_result'&&<span className="id muted">设备回执</span>}</td><td>{!entry.rejection&&<button disabled={busy} onClick={()=>void recover(entry)}>查询原操作</button>}</td></tr>)}</tbody></table></div>}</>}
  </section>;
}
function PropertyControl({property,device,disabled,onSet}:{property:Property&{path:string};device:Device;disabled:boolean;onSet:(value:unknown)=>void}){
  const observation=device.reported[property.path],name=property.id==='power'?'电源':property.id==='brightness'?'亮度':property.id;
  const [value,setValue]=useState(String(observation?.value??property.schema.minimum??0));useEffect(()=>setValue(String(observation?.value??property.schema.minimum??0)),[observation?.value]);
  const locked=disabled||!property.access.includes('write');
  if(property.schema.type==='boolean')return <div className="property"><span>{name}</span><button role="switch" aria-label={name} aria-checked={observation?.value===true} disabled={locked||!observation} onClick={()=>onSet(observation?.value!==true)}>{observation?(observation.value?'已开启':'已关闭'):'暂无状态'}</button></div>;
  if(['integer','number'].includes(property.schema.type))return <div className="property"><label htmlFor={device.device_id+property.path}>{name}</label><form onSubmit={e=>{e.preventDefault();onSet(Number(value))}}><input id={device.device_id+property.path} type="number" min={property.schema.minimum} max={property.schema.maximum} step={property.schema.type==='integer'?1:'any'} value={value} required disabled={locked} onChange={e=>setValue(e.target.value)}/><button disabled={locked}>设置</button></form></div>;
  return <p>{name}：{String(observation?.value??'暂无状态')}</p>;
}
