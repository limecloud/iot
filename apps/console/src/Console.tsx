import { useEffect, useRef, useState } from 'react';
import { errorText, when, type Call, type Session } from '@limeiot/control-ui/api.ts';
import { ProductsConsole } from './Products';
import { ConsoleHeader, WorkspaceNav } from './Shell';
import { GatewayPanel } from './Gateways';
import { CLISession } from './CLISession';
import { NativeAuthorization } from './NativeAuthorization';
import { RemotePanel } from './Remote';
import { journal, original, type Entry, type Space } from './domain';

export function Console({session,call,logout}:{session:Session;call:Call;logout:()=>Promise<void>}){
  const native=new URLSearchParams(location.search).get('native');
  return native?<NativeAuthorization id={native} session={session} call={call} logout={logout}/>:new URLSearchParams(location.search).get('view')==='products'?<ProductsConsole session={session} call={call} logout={logout}/>:<WorkspaceConsole session={session} call={call} logout={logout}/>;
}
function WorkspaceConsole({session,call,logout}:{session:Session;call:Call;logout:()=>Promise<void>}){
  const [spaces,setSpaces]=useState<Space[]>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[entries,setEntries]=useState<Entry[]>([]),[storageOK,setStorageOK]=useState(true);
  const alive=useRef(true),sending=useRef(false),log=journal(session.principal.principal_id);
  const selected=new URLSearchParams(location.search).get('space'),space=spaces?.find(v=>v.space_id===selected);
  function reread(){try{setEntries(log.list());setStorageOK(true)}catch{setStorageOK(false);setError('无法读取本地原操作记录，请检查浏览器存储设置')}}
  useEffect(()=>{const abort=new AbortController();reread();void call<{spaces:Space[]}>('/api/console/v1/spaces',undefined,abort.signal).then(v=>{if(alive.current)setSpaces(v.spaces)}).catch(e=>{if(alive.current)setError(errorText(e))});
    const changed=()=>reread();addEventListener('storage',changed);return()=>{alive.current=false;abort.abort();removeEventListener('storage',changed)};
  },[]);
  async function create(event:React.FormEvent<HTMLFormElement>){event.preventDefault();if(sending.current||!storageOK)return;const name=String(new FormData(event.currentTarget).get('name')??'').trim();if(!name)return;
    const base=original();const entry:Entry={...base,kind:'space',space_id:'',request:{request_key:base.id,name}};await submit(entry);
  }
  async function submit(entry:Entry){if(entry.kind!=='space'||sending.current)return;sending.current=true;setBusy(true);setError('');let saved=false;
    try{log.save(entry);saved=true;const result=await call<Space>('/api/console/v1/spaces',entry.request);log.save({...entry,result});if(alive.current)location.assign(`/console/?space=${encodeURIComponent(result.space_id)}`)}catch(e){if(alive.current){reread();setError(saved?errorText(e)+'。请恢复原空间请求':'无法保存本地原操作记录，尚未创建空间')}}finally{sending.current=false;if(alive.current)setBusy(false)}
  }
  const pending=entries.filter(e=>e.kind==='space'&&!e.result);
  return <><ConsoleHeader session={session} logout={logout}/><main className="content"><WorkspaceNav/>
    <div className="heading"><h1>{space?.name??'我的空间'}</h1>{spaces&&spaces.length>0&&<label className="small">当前空间<select aria-label="当前空间" value={space?.space_id??''} onChange={e=>location.assign(e.target.value?`/console/?space=${encodeURIComponent(e.target.value)}`:'/console/')}><option value="">空间列表</option>{spaces.map(v=><option key={v.space_id} value={v.space_id}>{v.name}</option>)}</select></label>}</div>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {space?<SpaceTasks key={space.space_id} session={session} call={call} space={space}/>:<>
      {spaces===undefined?<p role="status">正在读取空间…</p>:spaces.length===0?<p className="empty">还没有空间，请先创建。</p>:<div className="table-scroll"><table><thead><tr><th>空间</th><th>创建时间</th><th></th></tr></thead><tbody>{spaces.map(v=><tr key={v.space_id}><td>{v.name}<span className="id muted">{v.space_id}</span></td><td>{when(v.created_at)}</td><td><a href={`/console/?space=${encodeURIComponent(v.space_id)}`}>进入空间</a></td></tr>)}</tbody></table></div>}
      {selected&&!space&&spaces&&<p className="notice">当前账号无法访问所选空间。</p>}
      {pending.map(e=><div className="pending-item" key={e.id}><p>待恢复的空间请求</p><button disabled={busy||!storageOK} onClick={()=>void submit(e)}>恢复原空间请求</button></div>)}
      <section className="section narrow"><h2>创建空间</h2><form onSubmit={e=>void create(e)}><label htmlFor="space-name">空间名称</label><input id="space-name" name="name" required maxLength={80} disabled={busy||pending.length>0}/><button className="primary" disabled={busy||!storageOK||pending.length>0}>创建空间</button></form></section>
    </>}
    <CLISession call={call}/>
  </main></>;
}
function SpaceTasks({session,call,space}:{session:Session;call:Call;space:Space}){
  const value=new URLSearchParams(location.search).get('view'),view=value==='gateways'||value==='operations'?value:'devices';
  return <><nav className="tabs" aria-label="空间任务">{[['devices','设备'],['gateways','网关'],['operations','操作记录']].map(([key,label])=><a key={key} aria-current={view===key?'page':undefined} href={`/console/?space=${encodeURIComponent(space.space_id)}&view=${key}`}>{label}</a>)}</nav>{view==='gateways'?<GatewayPanel session={session} call={call} space={space}/>:<RemotePanel session={session} call={call} space={space} view={view}/>}</>;
}
