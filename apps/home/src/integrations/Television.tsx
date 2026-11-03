import { useEffect, useState } from 'react';
import { verifyApplications, type ApplicationPage } from '../../../../packages/protocol/execution-bindings.mjs';
import { request, type Model } from '../api';
import { ExecutionBindingPanel, useExecutionBinding, type BindingProps } from '../ExecutionBinding';

export function TelevisionControls(props:BindingProps & {model:Model|undefined;onLaunch:(id:string)=>void}) {
  const controller=useExecutionBinding(props,adapter=>'applications' in adapter);
  const {binding,native,candidate,busy,blocked,confirmed,unresolved,action,submit}=controller;
  const television=candidate&&'applications' in candidate?candidate:null;
  const paths=(props.model?.services??[]).flatMap(service=>(service.actions??[]).map(action=>`${service.id}.${action.id}`)).sort();
  const nativePaths=native?.paths.filter(path=>paths.includes(path))??[];
  const external=paths.filter(path=>!nativePaths.includes(path));
  function label(path:string) {
    const action=props.model?.services.flatMap(service=>(service.actions??[]).map(action=>({...action,path:`${service.id}.${action.id}`}))).find(action=>action.path===path);
    const labels:Record<string,string>={'urn:limeiot:action:application-launch:1':'启动应用','urn:limeiot:action:remote-press:1':'遥控按键','urn:limeiot:action:audio-set-volume:1':'设置音量','urn:limeiot:action:audio-set-muted:1':'设置静音'};
    return action?labels[action.semantic_id]??path:path;
  }
  const canCompose=Boolean(binding&&binding.model_revision===props.device.model_revision&&native?.ready&&television?.compatible&&nativePaths.length>0&&external.length>0&&external.every(path=>television.paths.includes(path)));
  const canBind=Boolean(television&&paths.length>0&&paths.every(path=>television.paths.includes(path))&&props.model?.services.every(service=>(service.properties??[]).length===0&&(service.events??[]).length===0));
  const [apps,setApps]=useState<ApplicationPage|null>(null);
  useEffect(()=>setApps(null),[binding,props.device.model_revision]);
  return <ExecutionBindingPanel controller={controller} device={props.device} online={props.online}
    label="电视" title="电视接入与应用" consent="已在电视端核对设备并允许连接"
    canBind={canBind}
    details={television&&<><p>电视序列号：{television.device_serial}</p><details><summary>系统与应用授权</summary><p className="mono">{television.fingerprint}</p>{television.applications.map(app=><p key={app.application_id}>{app.application_id}</p>)}</details></>}>
    {binding&&television?.compatible&&<div aria-label="电视能力组合">
      {!canBind&&<p>此模型需要电视Agent与网关组合接入，音量和静音由电视Agent执行。</p>}
      {canCompose?<><p>电视Agent执行：{nativePaths.map(label).join('、')}</p><p>网关执行：{external.map(label).join('、')}</p>
        <button type="button" disabled={!props.online||busy||blocked||!confirmed||unresolved.length>0} onClick={()=>void action(()=>submit({type:'bindings.compose',device_id:props.device.device_id,route:television.route,native_paths:nativePaths,expected_native_session:native!.session_id,expected_binding_revision:binding.revision,expected_model_revision:binding.model_revision}))}>确认组合电视接入</button>
      </>:<p>组合前请让电视Agent连接相同能力模型，并重新读取接入信息。</p>}
    </div>}
    {binding?.routes['apps.launch']&&<button type="button" disabled={!props.online||busy} onClick={()=>void action(async()=>{
      const page=verifyApplications(await request<unknown>(`${props.prefix}/devices/${encodeURIComponent(props.device.device_id)}/applications`,props.session),props.device.device_id);
      if(page.binding_revision!==binding.revision)throw new Error('revision_conflict');setApps(page);
    })}>读取应用列表</button>}
    {apps&&(apps.fresh?<div aria-label="已发现应用">{apps.items.map(app=><div className="property-row" key={app.application_id}><span>{app.application_id} {app.authorized?'已授权':'未授权'}</span><button type="button" disabled={props.disabled||busy||!app.authorized} onClick={()=>props.onLaunch(app.application_id)}>启动 {app.application_id}</button></div>)}</div>:<p>应用列表尚未就绪，请等待电视重新连接后读取</p>)}
  </ExecutionBindingPanel>;
}
