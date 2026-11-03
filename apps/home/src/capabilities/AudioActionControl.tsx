import { useState } from 'react';
import { type Action } from '../api';

export function supportsAudioControl(action:Action) {
  const fields=Object.keys(action.input.properties??{}),required=action.input.required??[];
  if(fields.length!==1||required.length!==1||required[0]!==fields[0])return false;
  return action.semantic_id==='urn:limeiot:action:audio-set-volume:1'&&fields[0]==='percent'&&action.input.properties?.percent.type==='integer'||
    action.semantic_id==='urn:limeiot:action:audio-set-muted:1'&&fields[0]==='muted'&&action.input.properties?.muted.type==='boolean';
}

export function AudioActionControl({action,disabled,onInvoke}:{action:Action;disabled:boolean;onInvoke:(value:unknown)=>void}) {
  const [percent,setPercent]=useState(String(action.input.properties?.percent?.minimum??0));
  if(action.semantic_id==='urn:limeiot:action:audio-set-muted:1')return <fieldset disabled={disabled}><legend>静音控制</legend><button type="button" onClick={()=>onInvoke({muted:true})}>静音</button><button type="button" onClick={()=>onInvoke({muted:false})}>取消静音</button></fieldset>;
  const schema=action.input.properties?.percent;
  return <form className="property-form" onSubmit={event=>{event.preventDefault();onInvoke({percent:Number(percent)});}}><label>目标音量（%）<input aria-label="目标音量（%）" type="number" min={schema?.minimum} max={schema?.maximum} step={1} required value={percent} disabled={disabled} onChange={event=>setPercent(event.target.value)}/></label><button disabled={disabled}>设置音量</button></form>;
}
