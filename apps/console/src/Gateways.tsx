import { useEffect, useRef, useState } from 'react';
import { errorText, when, type Call, type Session } from '@limeiot/control-ui/api.ts';
import { journal, original, type Entry, type Gateway, type Space } from './domain';
interface Pair { control_origin:string; code:string; pairing:{pairing_id:string;expires_at:string;claimed:boolean;cancelled:boolean} }
export function GatewayPanel({session,call,space}:{session:Session;call:Call;space:Space}){
  const [gateways,setGateways]=useState<Gateway[]>(),[entries,setEntries]=useState<Entry[]>([]),[pair,setPair]=useState<Pair>(),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[write,setWrite]=useState(true),[revoke,setRevoke]=useState<string>();
  const alive=useRef(true),sending=useRef(false),log=journal(session.principal.principal_id),prefix=`/api/console/v1/spaces/${encodeURIComponent(space.space_id)}`;
  function records(){try{const all=log.list();setEntries(all.filter(e=>e.space_id===space.space_id))}catch{setError('无法读取本地原操作记录，请检查浏览器存储设置')}}
  async function refresh(){try{const result=await call<{gateways:Gateway[]}>(`${prefix}/gateways`);if(alive.current)setGateways(result.gateways)}catch(e){if(alive.current){setGateways(undefined);setError(errorText(e))}}}
  useEffect(()=>{records();void refresh();return()=>{alive.current=false}},[]);
  async function create(entry?:Entry){if(sending.current)return;sending.current=true;setBusy(true);setError('');setMessage('');let saved=false;
    const base=original(),request:Entry=entry??{...base,kind:'pair',space_id:space.space_id,request:{request_key:base.id,scopes:write?['commands.write','devices.read']:['devices.read']}};
    if(request.kind!=='pair'){sending.current=false;setBusy(false);return}
    try{log.list();log.save(request);saved=true;const result=await call<Pair>(`${prefix}/pairings`,request.request);log.save({...request,resolved:true});if(alive.current){setPair(result);records()}}catch(e){if(alive.current){records();setError(saved?errorText(e)+'。请恢复配对信息':'无法保存本地原操作记录，尚未申请配对')}}finally{sending.current=false;if(alive.current)setBusy(false)}
  }
  async function confirm(gateway:Gateway){if(sending.current)return;sending.current=true;setBusy(true);setError('');try{await call(`${prefix}/gateways/${encodeURIComponent(gateway.gateway_id)}/revoke`,{revision:gateway.revision});if(alive.current){setRevoke(undefined);await refresh()}}catch(e){if(alive.current)setError(errorText(e))}finally{sending.current=false;if(alive.current)setBusy(false)}}
  async function copy(){if(!pair)return;try{await navigator.clipboard.writeText(JSON.stringify(pair));setMessage('配对信息已复制')}catch{setMessage('未能复制，请从配对信息框中复制')}}
  const latest=entries.find(e=>e.kind==='pair'),active=gateways?.some(g=>g.active),available=pair&&!pair.pairing.claimed&&!pair.pairing.cancelled&&Date.parse(pair.pairing.expires_at)>Date.now();
  return <section aria-label="网关"><div className="toolbar"><h2>已绑定网关</h2><button disabled={busy} onClick={()=>{setError('');void refresh()}}>刷新网关</button></div>{error&&<p role="alert" className="notice error">{error}</p>}{message&&<p role="status" className="notice">{message}</p>}
    {gateways?.length===0&&<p className="empty">尚未绑定网关。</p>}{gateways&&gateways.length>0&&<div className="table-scroll"><table><thead><tr><th>网关</th><th>绑定状态</th><th>权限</th><th></th></tr></thead><tbody>{gateways.map(g=><tr key={g.revision}><td><span className="id">{g.gateway_id}</span><span className="id muted">{g.revision}</span></td><td>{g.active?'已绑定':'已撤销'}</td><td>{g.scopes.map(s=>s==='devices.read'?'读取设备':s==='commands.write'?'控制设备':s).join('、')}</td><td>{g.active&&<button className="danger" disabled={busy} onClick={()=>setRevoke(g.revision)}>撤销绑定</button>}</td></tr>)}</tbody></table></div>}
    {gateways?.filter(g=>g.revision===revoke).map(g=><div role="group" aria-label="确认撤销绑定" className="confirm" key={g.revision}><p>撤销将停止此绑定的远程访问。已发送动作仍需查询原结果。</p><button className="danger" disabled={busy} onClick={()=>void confirm(g)}>确认撤销</button><button disabled={busy} onClick={()=>setRevoke(undefined)}>取消</button></div>)}
    {!active&&<section className="section narrow"><h2>绑定本地网关</h2><form onSubmit={e=>{e.preventDefault();void create()}}><label className="check"><input type="checkbox" checked disabled readOnly/>读取设备</label><label className="check"><input type="checkbox" checked={write} disabled={busy} onChange={e=>setWrite(e.target.checked)}/>控制设备</label><button className="primary" disabled={busy||!!latest&&!latest.resolved}>生成配对信息</button></form></section>}
    {latest&&<button className="section" disabled={busy} onClick={()=>void create(latest)}>恢复配对信息</button>}
    {pair&&<section className="pairing" aria-label="网关配对信息"><h2>{available?'等待本地网关批准':'配对已使用或过期'}</h2><p className="small muted">有效期至 {when(pair.pairing.expires_at)}</p>{available&&<><label htmlFor="pairing-data">配对信息</label><textarea id="pairing-data" readOnly value={JSON.stringify(pair)} spellCheck={false}/><div className="toolbar"><p className="small muted">在本地家庭界面粘贴，核对账号与权限后批准。</p><button onClick={()=>void copy()}>复制配对信息</button></div></>}</section>}
  </section>;
}
