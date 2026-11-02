import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, when, type Call } from '@limeiot/control-ui/api.ts';
import { sameJSON } from '../../../packages/protocol/products.mjs';
import { validPublishInput, verifyPublisher, verifyPublication, verifyPublishOperation, type ModelPublication, type ModelPublishInput, type ModelPublishOperation, type Publisher } from '../../../packages/protocol/model-publication.mjs';
import type { Product } from './products-domain';

interface Entry { id:string; product_id:string; created_at:string; request:ModelPublishInput; result?:ModelPublishOperation; rejection?:string }
const event='limeiot:publications-changed';
function journal(principal:string) {
  const prefix='limeiot.publications:v1:'+principal+':';
  function checked(value:Entry,key:string) {
    if(!value||key!==prefix+value.id||value.id!==value.request?.request_key||!validPublishInput(value.request)||
      !/^product-[a-f0-9]{64}$/.test(value.product_id)||!Number.isFinite(Date.parse(value.created_at))||
      value.rejection!==undefined&&typeof value.rejection!=='string')throw new Error('local_record_invalid');
    return value;
  }
  function list():Entry[] {
    const out:Entry[]=[];
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix))out.push(checked(JSON.parse(localStorage.getItem(key)??'null'),key))}
    return out.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }
  function save(value:Entry) {
    const key=prefix+value.id;checked(value,key);const raw=JSON.stringify(value),old=localStorage.getItem(key);
    if(old){const prior=checked(JSON.parse(old),key);if(!sameJSON([prior.product_id,prior.request],[value.product_id,value.request])||
      prior.result&&!sameJSON(prior.result,value.result)||prior.rejection&&prior.rejection!==value.rejection)throw new Error('local_record_changed')}
    localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw new Error('local_record_unavailable');
    dispatchEvent(new Event(event));
  }
  return {list,save};
}
const outcome=(entry:Entry)=>entry.rejection?'请求已拒绝':entry.result?.status==='published'?'已发布':entry.result?.status==='conflict'?'修订冲突':entry.result?.status==='rejected'?'发布被拒绝':'结果待查询';
export function downloadJSON(name:string,value:unknown) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function Publication({product,principal,clean,disabled,call}:{product:Product;principal:string;clean:boolean;disabled:boolean;call:Call}) {
  const [publisher,setPublisher]=useState<Publisher>(),[head,setHead]=useState<ModelPublication|null>(),[entries,setEntries]=useState<Entry[]>([]),
    [storageOK,setStorageOK]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[review,setReview]=useState(false);
  const alive=useRef(true),sending=useRef(false),recordSequence=useRef(0),readSequence=useRef(0),log=journal(principal);
  async function records() {
    const sequence=++recordSequence.current;
    try{const all=log.list();for(const entry of all)if(entry.result)await verifyPublishOperation(entry.result,principal,{product_id:entry.product_id,request:entry.request});
      if(alive.current&&sequence===recordSequence.current){setEntries(all.filter(entry=>entry.product_id===product.product_id));setStorageOK(true)}}
    catch{if(alive.current&&sequence===recordSequence.current){setStorageOK(false);setError('无法读取本地发布记录')}}
  }
  async function read() {
    const sequence=++readSequence.current;
    const [rawPublisher,rawHead]=await Promise.all([call<unknown>('/api/console/v1/publisher'),call<{release:unknown}>(base+'/head')]);
    const owner=await verifyPublisher(rawPublisher,principal);
    if(!rawHead||Object.keys(rawHead).join(',')!=='release')throw new Error('invalid_response');
    const current=rawHead.release===null?null:await verifyPublication(rawHead.release,{product_id:product.product_id,publisher:owner,principal});
    if(alive.current&&sequence===readSequence.current){setPublisher(owner);setHead(current);setReview(false)}
  }
  const base='/api/console/v1/products/'+encodeURIComponent(product.product_id)+'/releases';
  useEffect(()=>{alive.current=true;void read().catch(e=>{if(alive.current)setError(errorText(e))});void records();
    const changed=()=>{void records()};addEventListener('storage',changed);addEventListener(event,changed);
    return()=>{alive.current=false;recordSequence.current++;readSequence.current++;removeEventListener('storage',changed);removeEventListener(event,changed)};
  },[product.product_id,principal]);
  async function refresh() {
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try{await read()}catch(e){if(alive.current)setError(errorText(e))}finally{sending.current=false;if(alive.current)setBusy(false)}
  }
  async function publish() {
    if(sending.current||!storageOK||!publisher?.trust||head===undefined||!clean||review)return;
    sending.current=true;setBusy(true);setError('');setMessage('');let attempted=false;
    const key=crypto.randomUUID(),entry:Entry={id:key,product_id:product.product_id,created_at:new Date().toISOString(),
      request:{request_key:key,expected_revision:product.revision,expected_release_id:head?.artifact.statement.release_id??null,visibility:'public'}};
    try {
      if(log.list().some(e=>e.product_id===product.product_id&&!e.result&&!e.rejection))throw new Error('pending_original');
      log.save(entry);attempted=true;
      const result=await verifyPublishOperation(await call(base,entry.request),principal,{product_id:entry.product_id,request:entry.request});
      log.save({...entry,result});
      if(alive.current){setMessage(outcome({...entry,result}));if(result.status==='published')setHead(result.release);else setReview(true)}
    } catch(e) {
      if(attempted&&e instanceof ApiError&&['invalid_request','forbidden','origin_rejected','csrf_rejected','release_capacity_reached'].includes(e.code)){
        try{log.save({...entry,rejection:e.code})}catch{/* 保留原未知记录，不能重新发送。 */}
      }
      if(alive.current)setError(attempted?'发布结果未确认，请查询原发布操作':'无法保存本地发布记录，尚未发送');
    } finally{void records();sending.current=false;if(alive.current)setBusy(false)}
  }
  async function resolve(entry:Entry) {
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try {
      const result=await verifyPublishOperation(await call('/api/console/v1/release-operations/by-key/'+encodeURIComponent(entry.id)),principal,{product_id:entry.product_id,request:entry.request});
      log.save({...entry,result});if(alive.current){setMessage(outcome({...entry,result}));setReview(true)}
    }catch(e){if(alive.current)setError(e instanceof ApiError&&e.status===404?'尚未查到原发布操作，未重新发送':errorText(e))}
    finally{void records();sending.current=false;if(alive.current)setBusy(false)}
  }
  const pending=entries.some(e=>!e.result&&!e.rejection);
  return <section className="section" aria-label="模型发布"><div className="heading"><h2>发布版本</h2><button type="button" disabled={busy} onClick={()=>void refresh()}>读取最新发布</button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}
    {publisher&&<dl><dt>发布命名空间</dt><dd><code>{publisher.namespace}</code></dd>{publisher.trust&&<><dt>当前签名公钥</dt><dd className="small">{publisher.trust.signing_key_id}</dd></>}</dl>}
    {head===undefined?<p role="status">正在读取发布版本…</p>:head?<><dl><dt>当前版本</dt><dd>{String(head.artifact.statement.model.model_version)}</dd><dt>发布 ID</dt><dd className="small">{head.artifact.statement.release_id}</dd><dt>模型修订</dt><dd className="small">{head.artifact.statement.model_revision}</dd></dl>
      <div className="actions"><button type="button" onClick={()=>downloadJSON(head.artifact.statement.release_id+'.json',head.artifact)}>下载签名制品</button><button type="button" onClick={()=>downloadJSON(head.artifact.statement.release_id+'-trust.json',head.trust)}>下载信任材料</button></div></>:<p className="muted">尚未发布</p>}
    {!clean&&<p className="small muted">请先保存草稿</p>}{publisher&&publisher.trust===null&&<p className="small muted">实例尚未配置发布签名密钥</p>}{review&&<p className="small muted">请读取并核对最新发布后再提交</p>}
    <div className="actions"><button className="primary" type="button" disabled={disabled||busy||!clean||!storageOK||pending||!publisher?.trust||head===undefined||review} onClick={()=>void publish()}>公开发布已保存草稿</button></div>
    {entries.length>0&&<div className="table-scroll"><table><thead><tr><th>发布操作</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>{entries.map(entry=><tr key={entry.id}><td className="small">{entry.id}{entry.result?.reason&&<span className="id muted">{entry.result.reason}</span>}</td><td>{outcome(entry)}</td><td>{when(entry.created_at)}</td><td>{!entry.result&&!entry.rejection?<button type="button" disabled={busy} onClick={()=>void resolve(entry)}>查询原发布操作</button>:entry.result?.release&&<button type="button" onClick={()=>downloadJSON(entry.result!.release!.artifact.statement.release_id+'.json',entry.result!.release!.artifact)}>下载签名制品</button>}</td></tr>)}</tbody></table></div>}
  </section>;
}
