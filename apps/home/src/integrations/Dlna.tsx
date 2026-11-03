import { useEffect, useState } from 'react';
import { ExecutionBindingPanel, useExecutionBinding, type BindingProps } from '../ExecutionBinding';

export function DlnaControls(props:BindingProps & {paths:string[];onInvoke:(path:string,value:unknown)=>void}) {
  const controller=useExecutionBinding(props,adapter=>'kind' in adapter&&adapter.kind==='dlna');
  const {binding,candidate,busy}=controller;
  const speaker=candidate&&'kind' in candidate?candidate:null;
  const [mediaID,setMediaID]=useState(''),[volume,setVolume]=useState('10');
  useEffect(()=>{if(speaker)setVolume(String(speaker.playback_volume));},[speaker]);
  const bound=speaker&&binding&&Object.values(binding.routes).some(route=>route.revision===speaker.route.revision&&route.adapter_id===speaker.route.adapter_id);
  const disabled=(path:string)=>busy||props.disabled||!bound||!props.paths.includes(path)||props.device.action_availability?.[path]===false;
  return <ExecutionBindingPanel controller={controller} device={props.device} online={props.online}
    label="音箱" title="音箱接入与播放" consent="已核对音箱和获准音频" open
    details={speaker&&<p>设备标识：{speaker.udn}</p>}>
    {speaker&&<div aria-label="音频播放">
      {props.paths.includes('playback.play')&&<form className="property-form" onSubmit={event=>{event.preventDefault();props.onInvoke('playback.play',{media_id:mediaID});}}><label>获准音频<select aria-label="获准音频" value={mediaID} disabled={disabled('playback.play')} onChange={event=>setMediaID(event.target.value)} required><option value="">选择音频</option>{speaker.media.map(media=><option key={media.media_id} value={media.media_id} disabled={Date.parse(media.expires_at)<=Date.now()}>{media.media_id}{Date.parse(media.expires_at)<=Date.now()?'（已过期）':''}</option>)}</select></label><button disabled={disabled('playback.play')||!speaker.media.some(m=>m.media_id===mediaID&&Date.parse(m.expires_at)>Date.now())}>播放音频</button></form>}
      {props.paths.includes('playback.set_volume')&&<form className="property-form" onSubmit={event=>{event.preventDefault();props.onInvoke('playback.set_volume',{volume:Number(volume)});}}><label>音量<input aria-label="播放音量" type="number" min={0} max={speaker.volume_limit} required value={volume} disabled={disabled('playback.set_volume')} onChange={event=>setVolume(event.target.value)}/></label><button disabled={disabled('playback.set_volume')}>设置音量</button></form>}
      {props.paths.includes('playback.stop')&&<button type="button" disabled={disabled('playback.stop')} onClick={()=>props.onInvoke('playback.stop',{})}>停止播放</button>}
    </div>}
  </ExecutionBindingPanel>;
}
