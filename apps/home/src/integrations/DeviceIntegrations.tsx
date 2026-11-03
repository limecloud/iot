import { type Action, type Model } from '../api';
import { type BindingProps } from '../ExecutionBinding';
import { DlnaControls } from './Dlna';
import { TelevisionControls } from './Television';

// 保留服务归属；音量语义可被多类设备复用，不能据此推断DLNA接入。
export function hasPlaybackControl(model:Model|undefined,action:Action & {path:string}) {
  return model?.services.some(service=>service.semantic_id==='urn:limeiot:service:audio-playback:1'&&
    service.actions?.some(item=>`${service.id}.${item.id}`===action.path)&&
    ['playback.play','playback.stop','playback.set_volume'].includes(action.path))??false;
}

export function DeviceIntegrations(props:BindingProps & {model:Model|undefined;onInvoke:(path:string,value:unknown)=>void}) {
  const services=props.model?.services??[];
  const playback=services.filter(service=>service.semantic_id==='urn:limeiot:service:audio-playback:1');
  return <>
    {services.some(service=>service.actions?.some(action=>action.semantic_id==='urn:limeiot:action:remote-press:1'))&&<TelevisionControls {...props} onLaunch={id=>props.onInvoke('apps.launch',{application_id:id})}/>}
    {playback.length>0&&<DlnaControls {...props} paths={playback.flatMap(service=>(service.actions??[]).map(action=>`${service.id}.${action.id}`))} onInvoke={props.onInvoke}/>}
  </>;
}
