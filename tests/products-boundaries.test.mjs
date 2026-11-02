import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDraftJSON, validProductOperation } from '../packages/protocol/products.mjs';

test('草稿输入拒绝静默丢字段、数值失真与资源超限',()=>{
  for(const text of ['[]','null','{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"x":{"y":1,"y":2}}','{"n":9007199254740992}','{"n":1e400}','{"x":"\\ud800"}','{"x":'+ '['.repeat(17)+'0'+']'.repeat(17)+'}','{"x":['+'0,'.repeat(2047)+'0]}','{"x":"'+'x'.repeat(8192)+'"}'])assert.throws(()=>parseDraftJSON(text));
  assert.deepEqual(parseDraftJSON('{"a":1,"b":{"c":[true,null,"😀"]}}'),{a:1,b:{c:[true,null,'😀']}});
  assert.throws(()=>parseDraftJSON('{"request_key":"a","name":"产品","model":{"a":1,"a":2}}',true));
  assert.throws(()=>parseDraftJSON('{"request_key":"a","name":"产品","model":{"x":'+ '['.repeat(17)+'0'+']'.repeat(17)+'}}',true));
  assert.doesNotThrow(()=>parseDraftJSON(JSON.stringify({x:Array(2046).fill(0)})));
  assert.throws(()=>parseDraftJSON(JSON.stringify({request_key:'a',name:'产品',model:{x:Array(2047).fill(0)}}),true));
});
test('草稿原决定必须绑定主体、资源、完整输入与草稿状态',()=>{
  const principal='p-'+'1'.repeat(64),product='product-'+'2'.repeat(64),request={request_key:'original',name:'环境灯',model:{a:true}};
  const expected={kind:'products.create',product_id:null,request};
  const now=new Date().toISOString();
  const operation={operation_id:'prodop-'+'3'.repeat(64),principal_id:principal,kind:'products.create',product_id:product,request_digest:'4'.repeat(64),request,status:'saved',created_at:now,product:{product_id:product,principal_id:principal,name:'环境灯',revision:'prodrev-'+'5'.repeat(64),document_digest:'sha256:'+'6'.repeat(64),model:{a:true},status:'draft',validation:'unvalidated',created_at:now,updated_at:now}};
  assert.equal(validProductOperation(operation,principal,expected),true);
  for(const changed of [{...operation,status:'conflict'},{...operation,principal_id:'other'},{...operation,product_id:'other'},{...operation,request:{...request,model:{a:false}}},{...operation,product:{...operation.product,validation:'validated'}},{...operation,kind:'products.save'}])assert.equal(validProductOperation(changed,principal,expected),false);
});
