import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, when, type Call, type Session } from '@limeiot/control-ui/api.ts';
import { parseDraftJSON, sameJSON, validProduct, validProductOperation } from '../../../packages/protocol/products.mjs';
import { ConsoleHeader, WorkspaceNav } from './Shell';
import { ModelCheck } from './ModelCheck';
import { Publication } from './Publication';
import { draftJournal, type DraftEntry, type Product, type ProductInput, type ProductOperation } from './products-domain';

const base='/api/console/v1/products';
const productURL=(id:string)=>`/console/?view=products&product=${encodeURIComponent(id)}`;
const unresolved=(entry:DraftEntry)=>!entry.result&&!entry.rejection;
const outcome=(entry:DraftEntry)=>entry.rejection?'请求已拒绝':entry.result?.status==='saved'?'已保存':entry.result?.status==='conflict'?'修订冲突':'结果待查询';

export function ProductsConsole({session,call,logout}:{session:Session;call:Call;logout:()=>Promise<void>}) {
  const params=new URLSearchParams(location.search),selected=params.get('product'),creating=params.get('new')==='1';
  return <><ConsoleHeader session={session} logout={logout}/><main className="content"><WorkspaceNav products/>
    {selected||creating?<ProductEditor key={selected??'new'} id={selected} session={session} call={call}/>:<ProductList call={call} principal={session.principal.principal_id}/>}
  </main></>;
}
function ProductList({call,principal}:{call:Call;principal:string}) {
  const [items,setItems]=useState<Product[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),loading=useRef(false);
  async function read(after='') {
    if(loading.current)return;loading.current=true;setBusy(true);setError('');
    try {
      const page=await call<{items:Product[];next:string|null}>(base+(after?'?after='+encodeURIComponent(after):''));
      if(!Array.isArray(page.items)||page.items.length>16||!page.items.every(v=>validProduct(v,principal))||
        page.items.some((v,i)=>v.product_id<=(i?page.items[i-1].product_id:after))||
        page.next!==null&&page.next!==page.items.at(-1)?.product_id)throw new Error('invalid_response');
      if(alive.current){setItems(old=>after?[...old,...page.items]:page.items);setNext(page.next);setLoaded(true)}
    } catch(e) {if(alive.current)setError(errorText(e))} finally {loading.current=false;if(alive.current)setBusy(false)}
  }
  useEffect(()=>{void read();return()=>{alive.current=false}},[]);
  return <><div className="heading"><h1>我的产品</h1><a href="/console/?view=products&new=1">创建产品</a></div>
    {error&&<p className="notice error" role="alert">{error}<button disabled={busy} onClick={()=>void read()}>重新读取</button></p>}
    {!loaded?<p role="status">正在读取产品…</p>:!items.length?<p className="empty">还没有产品。</p>:<div className="table-scroll"><table><thead><tr><th>产品</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>{items.map(v=><tr key={v.product_id}><td>{v.name}<span className="id muted">{v.product_id}</span></td><td>草稿</td><td>{when(v.updated_at)}</td><td><a href={productURL(v.product_id)}>编辑物模型</a></td></tr>)}</tbody></table></div>}
    {next&&<div className="toolbar"><button disabled={busy} onClick={()=>void read(next)}>加载更多</button></div>}
    <DraftHistory principal={principal} call={call}/>
  </>;
}
function useDraftLog(principal:string) {
  const log=draftJournal(principal),[entries,setEntries]=useState<DraftEntry[]>([]),[storageOK,setStorageOK]=useState(true);
  function reread() {try{setEntries(log.list());setStorageOK(true)}catch{setStorageOK(false)}}
  useEffect(()=>{reread();addEventListener('storage',reread);addEventListener('limeiot:products-changed',reread);return()=>{removeEventListener('storage',reread);removeEventListener('limeiot:products-changed',reread)}},[principal]);
  return {log,entries,storageOK,reread};
}
function ProductEditor({id,session,call}:{id:string|null;session:Session;call:Call}) {
  const principal=session.principal.principal_id,{log,entries,storageOK,reread}=useDraftLog(principal);
  const [name,setName]=useState(''),[text,setText]=useState('{}'),[revision,setRevision]=useState(''),[server,setServer]=useState<Product>(),[ready,setReady]=useState(!id),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),sending=useRef(false);
  const relevant=entries.filter(e=>e.product_id===id),pending=relevant.filter(unresolved);
  async function readLatest(initial=false) {
    if(!id)return;
    if(!/^product-[a-f0-9]{64}$/.test(id)){setError('产品地址无效');return}
    const product=await call<Product>(base+'/'+encodeURIComponent(id));
    if(!validProduct(product,principal)||product.product_id!==id)throw new Error('invalid_response');
    if(!alive.current)return;
    setServer(product);setReady(true);
    if(initial) {
      const pending=log.list().find(e=>e.product_id===id&&unresolved(e));
      setName(pending?.request.name??product.name);setText(JSON.stringify(pending?.request.model??product.model,null,2));setRevision(pending?.request.expected_revision??product.revision);
    }
  }
  useEffect(()=>{
    if(id)void readLatest(true).catch(e=>{if(alive.current)setError(errorText(e))});
    else {try{const pending=log.list().find(e=>e.product_id===null&&unresolved(e));if(pending){setName(pending.request.name);setText(JSON.stringify(pending.request.model,null,2))}}catch{setError('无法读取本地草稿操作记录')}}
    return()=>{alive.current=false};
  },[]);
  async function submit(event:React.FormEvent) {
    event.preventDefault();if(sending.current||!storageOK||!ready||pending.length)return;
    let model:Record<string,unknown>;
    try {model=parseDraftJSON(text)} catch {setError('请检查物模型 JSON，不能包含重复字段、超限内容或不安全数值');return}
    const normalized=name.trim();if(!normalized||Array.from(normalized).length>80){setError('产品名称须为 1–80 个字符');return}
    // 发送路径从不接受旧记录；本地再次读取，防止另一个标签页已留下未知操作。
    try{if(log.list().some(e=>e.product_id===id&&unresolved(e))){reread();return}}catch{setError('无法读取本地草稿操作记录');return}
    const key=crypto.randomUUID(),request:ProductInput={request_key:key,name:normalized,model,...(id?{expected_revision:revision}:{})};
    let entry:DraftEntry={version:1,id:key,created_at:new Date().toISOString(),kind:id?'products.save':'products.create',product_id:id,request,attempted:false};
    sending.current=true;setBusy(true);setError('');setMessage('');let attempted=false;
    try {
      log.save(entry);entry={...entry,attempted:true};log.save(entry);attempted=true;reread();
      const result=await call<ProductOperation>(id?base+'/'+encodeURIComponent(id)+'/drafts':base,request);
      if(!validProductOperation(result,principal,entry))throw new Error('invalid_response');
      log.save({...entry,result});reread();
      if(!alive.current)return;
      if(!id){location.assign(productURL(result.product_id));return}
      if(result.status==='saved'){setRevision(result.product.revision);setServer(result.product);setMessage('草稿已保存')}
      else {setServer(result.product);setMessage('修订冲突，输入已保留，请先读取最新草稿')}
    } catch(e) {
      if(attempted&&e instanceof ApiError&&e.status<500&&e.status!==409) {
        try {log.save({...entry,rejection:e.code})} catch { /* 保留未知记录，继续只读恢复。 */ }
      }
      reread();if(alive.current)setError(attempted?errorText(e)+'。请查询原操作': '无法保存本地原操作记录，尚未发送草稿');
    } finally {sending.current=false;if(alive.current)setBusy(false)}
  }
  async function latest() {
    if(sending.current)return;sending.current=true;setBusy(true);setError('');
    try{await readLatest();if(alive.current)setMessage('已读取最新草稿，编辑输入保持不变')}catch(e){if(alive.current)setError(errorText(e))}finally{sending.current=false;if(alive.current)setBusy(false)}
  }
  let clean=false;try{clean=!!server&&server.revision===revision&&name.trim()===server.name&&sameJSON(parseDraftJSON(text),server.model)}catch{/* 非法或未保存的输入不能发布。 */}
  return <><div className="heading"><h1>{id?'编辑物模型':'创建产品'}</h1><a href="/console/?view=products">产品列表</a></div>
    {error&&<p className="notice error" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}
    {!storageOK&&<p className="notice error" role="alert">无法读取本地原操作记录，暂不能保存</p>}
    <p className="muted">草稿 / 未校验</p>
    <form className="section" onSubmit={e=>void submit(e)}>
      <label>产品名称<input required value={name} onChange={e=>setName(e.target.value)} disabled={busy||!ready}/></label>
      <label htmlFor="product-model">物模型 JSON</label><textarea id="product-model" className="model-editor" spellCheck={false} value={text} onChange={e=>setText(e.target.value)} disabled={busy||!ready}/>
      <div className="actions"><button className="primary" disabled={busy||!ready||!storageOK||pending.length>0}>{id?'保存草稿':'创建产品'}</button>{id&&<button type="button" disabled={busy} onClick={()=>void latest()}>读取最新草稿</button>}</div>
    </form>
    <ModelCheck text={text} call={call} disabled={busy||!ready}/>
    {server&&<section className="section"><h2>服务器草稿</h2><dl><dt>当前修订</dt><dd className="small">{server.revision}</dd><dt>正文摘要</dt><dd className="small">{server.document_digest}</dd></dl>
      {server.revision!==revision&&<button disabled={busy||pending.length>0} onClick={()=>{setRevision(server.revision);setMessage('已采用最新修订，输入保持不变，请核对后保存')}}>保留输入并采用最新修订</button>}
      <details><summary>查看服务器正文</summary><pre>{JSON.stringify(server.model,null,2)}</pre></details>
    </section>}
    <DraftHistory principal={principal} call={call} product={id} onResolved={()=>{reread();void latest()}}/>
    {server&&<Publication key={principal+':'+server.product_id} product={server} principal={principal} clean={clean} disabled={busy||pending.length>0} call={call}/>}
  </>;
}
function DraftHistory({principal,call,product,onResolved}:{principal:string;call:Call;product?:string|null;onResolved?:()=>void}) {
  const {log,entries,storageOK,reread}=useDraftLog(principal),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const sending=useRef(false),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false},[]);
  async function resolve(entry:DraftEntry) {
    if(sending.current)return;sending.current=true;setBusy(entry.id);setError('');
    try {
      const result=await call<ProductOperation>('/api/console/v1/product-operations/by-key/'+encodeURIComponent(entry.id));
      if(!validProductOperation(result,principal,entry))throw new Error('invalid_response');
      log.save({...entry,result});if(alive.current){reread();onResolved?.()}
    } catch(e) {if(alive.current)setError(e instanceof ApiError&&e.status===404?'尚未查到原操作，未重新发送':errorText(e))} finally {sending.current=false;if(alive.current)setBusy('')}
  }
  const shown=entries.filter(e=>product===undefined||e.product_id===product);
  return <section className="section"><h2>草稿操作记录</h2>{error&&<p className="notice error" role="alert">{error}</p>}{!storageOK?<p className="notice error">无法读取本地原操作记录</p>:!shown.length?<p className="empty">此浏览器尚无草稿操作记录。</p>:<div className="table-scroll"><table><thead><tr><th>产品</th><th>结果</th><th>创建时间</th><th></th></tr></thead><tbody>{shown.map(e=><tr key={e.id}><td>{e.request.name}<span className="id muted">{e.id}</span></td><td>{outcome(e)}</td><td>{when(e.created_at)}</td><td>{unresolved(e)?<button disabled={!!busy||!storageOK} onClick={()=>void resolve(e)}>查询原草稿操作</button>:e.result&&<a href={productURL(e.result.product_id)}>查看产品</a>}</td></tr>)}</tbody></table></div>}</section>;
}
