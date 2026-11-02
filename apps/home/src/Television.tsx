import { useEffect, useRef, useState } from 'react';
import { validExecutionChange, verifyApplications, verifyExecutionAdapters, verifyExecutionBinding, verifyExecutionOperation, type ApplicationPage, type ExecutionAdapter, type ExecutionBinding, type ExecutionChange, type ExecutionOperation, type ExecutionRequest } from '../../../packages/protocol/execution-bindings.mjs';
import { sameJSON, parseBoundedJSON } from '../../../packages/protocol/products.mjs';
import { errorText, request, type Device, type Session } from './api';
interface Original {version:1;origin:string;request:ExecutionRequest}
export function Television({device,prefix,session,online,refresh,onLaunch,disabled}: {device:Device;prefix:string;session:Session;online:boolean;refresh:()=>Promise<void>;onLaunch:(id:string)=>void;disabled:boolean}) {
  const [binding,setBinding]=useState<ExecutionBinding|null>(null),[adapters,setAdapters]=useState<ExecutionAdapter[]>([]),[apps,setApps]=useState<ApplicationPage|null>(null);
  const [originals,setOriginals]=useState<Original[]>([]),[results,setResults]=useState<Record<string,ExecutionOperation>>({});
  const [busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState('');
  const sending=useRef(false),alive=useRef(true),known=useRef<Original[]>([]);
  const storage=`limeiot.execution-operation:${prefix}:${device.device_id}:`,space=decodeURIComponent(prefix.split('/').at(-1)!);
  function readOriginals() {
    const found:Original[]=[];
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);if(!key?.startsWith(storage))continue;
      const value=parseBoundedJSON(localStorage.getItem(key)??'',{maxBytes:8192,maxDepth:6,maxNodes:64}) as Original;
      if(!value || Object.keys(value).sort().join(',')!=='origin,request,version' || value.version!==1 || value.origin!==location.origin || !value.request || Object.keys(value.request).sort().join(',')!=='change,idempotency_key,space_id' || value.request.space_id!==space || !/^[A-Za-z0-9_-]{1,128}$/.test(value.request.idempotency_key) || value.request.change?.device_id!==device.device_id || !validExecutionChange(value.request.change) || key!==storage+value.request.idempotency_key)throw new Error('local_record_unavailable');
      found.push(value);
    }
    if(found.length>32 || known.current.some(old=>!found.some(value=>sameJSON(value,old))))throw new Error('local_record_unavailable');
    known.current=found;setOriginals(found);return found;
  }
  async function action(work:()=>Promise<void>) {
    if(sending.current)return;sending.current=true;setBusy(true);setMessage('');
    try{await work();}catch(error){if(alive.current){if(error instanceof Error&&error.message==='local_record_unavailable'){setBlocked(true);setMessage('无法读取接入操作记录，请保留原记录后检查浏览器存储');}else setMessage(errorText(error));}}finally{sending.current=false;if(alive.current)setBusy(false);}
  }
  async function load() {
    setConfirmed(false);
    const [view,offers]=await Promise.all([request<unknown>(`${prefix}/devices/${encodeURIComponent(device.device_id)}/execution-binding`,session),request<unknown>(`${prefix}/execution-adapters`,session)]);
    const binding=verifyExecutionBinding(view,device.device_id),available=verifyExecutionAdapters(offers).items.filter(item=>item.device_id===device.device_id);
    if(alive.current){setBinding(binding);setAdapters(available);setApps(null);}
  }
  async function resolve(original:Original) {
    const result=await verifyExecutionOperation(await request<unknown>(`${prefix}/execution-operations/by-key/${encodeURIComponent(original.request.idempotency_key)}`,session),original.request);
    if(alive.current)setResults(previous=>({...previous,[original.request.idempotency_key]:result}));
  }
  useEffect(()=>{
    alive.current=true;const changed=()=>{try{readOriginals();}catch{setBlocked(true);setMessage('无法读取接入操作记录，请保留原记录后检查浏览器存储');}};
    changed();window.addEventListener('storage',changed);
    return()=>{alive.current=false;window.removeEventListener('storage',changed);};
  },[]);
  useEffect(()=>{setBinding(null);setConfirmed(false);setApps(null);},[device.model_revision]);
  async function submit(change:ExecutionChange) {
    const existing=readOriginals();
    if(blocked || existing.length>=32 || change.type!=='bindings.revoke' && existing.some(item=>!results[item.request.idempotency_key]))throw new Error('local_record_unavailable');
    const original:Original={version:1,origin:location.origin,request:{space_id:space,idempotency_key:crypto.randomUUID(),change}};
    const key=storage+original.request.idempotency_key,text=JSON.stringify(original);
    try{if(localStorage.getItem(key)!==null)throw new Error();localStorage.setItem(key,text);if(localStorage.getItem(key)!==text)throw new Error();readOriginals();}
    catch{setBlocked(true);setMessage('无法保存接入操作记录，尚未发送请求');return;}
    let value:ExecutionOperation;
    try{value=await verifyExecutionOperation(await request<unknown>(`${prefix}/execution-operations`,session,change,{key:original.request.idempotency_key}),original.request);}
    catch{setMessage('接入结果未知，请查询原操作');return;}
    if(!alive.current)return;
    setResults(previous=>({...previous,[original.request.idempotency_key]:value}));
    await load();await refresh();setMessage(value.status==='applied'?'接入操作已完成':value.status==='conflict'?'接入信息已变化，请重新读取后操作':'接入操作已被拒绝');
  }
  const candidate=adapters[0],unresolved=originals.filter(item=>!results[item.request.idempotency_key]);
  return <details className="television-binding"><summary>电视接入与应用</summary>
    {message&&<p role="status" className="notice">{message}</p>}
    <button type="button" disabled={!online||busy} onClick={()=>void action(load)}>读取接入信息</button>
    {binding&&<><p>接入状态：{binding.state==='composed'?'已组合接入':binding.state==='bound'?'已绑定':binding.state==='revoked'?'已撤销':'尚未绑定适配器'}</p>
      {candidate?<><p>电视地址：{candidate.target}<br/>电视序列号：{candidate.device_serial}</p><details><summary>系统与应用授权</summary><p className="mono">{candidate.fingerprint}</p>{candidate.applications.map(app=><p key={app.application_id}>{app.application_id}</p>)}</details>
        <label><input type="checkbox" checked={confirmed} disabled={busy||blocked||!candidate.compatible} onChange={event=>setConfirmed(event.target.checked)}/>已在电视端核对设备并允许连接</label>
        {!candidate.compatible&&<p>当前能力模型与此接入方式不兼容</p>}
        <button type="button" disabled={!online||busy||blocked||!confirmed||!candidate.compatible||unresolved.length>0} onClick={()=>void action(()=>submit({type:'bindings.bind',device_id:device.device_id,route:candidate.route,expected_binding_revision:binding.revision,expected_model_revision:binding.model_revision}))}>确认绑定电视</button>
      </>:<p>网关尚未准备此电视的接入配置</p>}
      {['bound','composed'].includes(binding.state)&&<button type="button" disabled={!online||busy||blocked} onClick={()=>void action(()=>submit({type:'bindings.revoke',device_id:device.device_id,expected_binding_revision:binding.revision}))}>撤销电视接入</button>}
      {binding.routes['apps.launch']&&<button type="button" disabled={!online||busy} onClick={()=>void action(async()=>{const page=verifyApplications(await request<unknown>(`${prefix}/devices/${encodeURIComponent(device.device_id)}/applications`,session),device.device_id);if(page.binding_revision!==binding.revision)throw new Error('revision_conflict');setApps(page);})}>读取应用列表</button>}
    </>}
    {unresolved.map(original=><p key={original.request.idempotency_key}>接入结果待核对 <button type="button" disabled={!online||busy} onClick={()=>void action(async()=>{await resolve(original);await load();await refresh();})}>查询接入原操作</button></p>)}
    {apps&&(apps.fresh?<div aria-label="已发现应用">{apps.items.map(app=><div className="property-row" key={app.application_id}><span>{app.application_id} {app.authorized?'已授权':'未授权'}</span><button type="button" disabled={disabled||busy||!app.authorized} onClick={()=>onLaunch(app.application_id)}>启动 {app.application_id}</button></div>)}</div>:<p>应用列表尚未就绪，请等待电视重新连接后读取</p>)}
  </details>;
}
