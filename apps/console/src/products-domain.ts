import { sameJSON, validProductInput, validProductOperation } from '../../../packages/protocol/products.mjs';

export interface Product {
  product_id:string; principal_id:string; name:string; revision:string; document_digest:string;
  model:Record<string,unknown>; status:'draft'; validation:'unvalidated'; created_at:string; updated_at:string;
}
export interface ProductInput { request_key:string; name:string; model:Record<string,unknown>; expected_revision?:string }
export interface ProductOperation {
  operation_id:string; principal_id:string; kind:'products.create'|'products.save'; product_id:string;
  request_digest:string; request:ProductInput; status:'saved'|'conflict'; product:Product; created_at:string;
}
export interface DraftEntry {
  version:1; id:string; created_at:string; kind:'products.create'|'products.save'; product_id:string|null;
  request:ProductInput; attempted:boolean; result?:ProductOperation; rejection?:string;
}
export function draftJournal(principal:string) {
  const prefix=`limeiot.products:v1:${principal}:`;
  function validate(value:DraftEntry|null,key:string):asserts value is DraftEntry {
    if(!value||value.version!==1||!['products.create','products.save'].includes(value.kind)||key!==prefix+value.id||
      value.request?.request_key!==value.id||!validProductInput(value.request,value.kind==='products.save')||typeof value.attempted!=='boolean'||!Number.isFinite(Date.parse(value.created_at))||
      value.rejection!==undefined&&typeof value.rejection!=='string'||
      (value.kind==='products.create'?value.product_id!==null:!/^product-[a-f0-9]{64}$/.test(value.product_id??''))||
      (value.result&&!validProductOperation(value.result,principal,value)))throw new Error('local_record_invalid');
  }
  function list():DraftEntry[] {
    const out:DraftEntry[]=[];
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);if(!key?.startsWith(prefix))continue;
      const value=JSON.parse(localStorage.getItem(key)??'null') as DraftEntry|null;validate(value,key);out.push(value);
    }
    return out.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }
  function save(entry:DraftEntry) {
    const key=prefix+entry.id;validate(entry,key);
    const old=localStorage.getItem(key);
    if(old) {
      const prior=JSON.parse(old) as DraftEntry;validate(prior,key);
      if(!sameJSON([prior.kind,prior.product_id,prior.request],[entry.kind,entry.product_id,entry.request])||
        prior.attempted&&!entry.attempted||prior.result&&!sameJSON(prior.result,entry.result)||prior.rejection&&prior.rejection!==entry.rejection)throw new Error('local_record_changed');
    }
    const raw=JSON.stringify(entry);localStorage.setItem(key,raw);
    if(localStorage.getItem(key)!==raw)throw new Error('local_record_unavailable');
    dispatchEvent(new Event('limeiot:products-changed'));
  }
  return {list,save};
}
