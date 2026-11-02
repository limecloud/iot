import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parseExecutionChange, verifyExecutionOperation, verifyExecutionBinding } from '../packages/protocol/execution-bindings.mjs';
const exec=promisify(execFile),revision='sha256:'+'a'.repeat(64),route={adapter_id:'tv-adb',revision};
const change={type:'bindings.bind',device_id:'tv',route,expected_binding_revision:revision,expected_model_revision:revision};
async function operation(key='original') {
  const request={space_id:'space',idempotency_key:key,change};
  return {operation_id:'executionop-original',request,request_digest:await documentDigest(request),status:'applied',reason:null,result:{device_id:'tv',model_revision:revision,revision:'sha256:'+'b'.repeat(64),state:'bound',routes:{'remote.press':route,'apps.launch':route}},created_at:'2026-11-02T00:00:00Z'};
}
test('接入合同严格编译，原请求/输出绑定与重复字段负例',async()=>{
  const schema=JSON.parse(await readFile(path.join(root,'contracts/execution-bindings.schema.json'),'utf8'));
  const catalog=JSON.parse(await readFile(path.join(root,'contracts/tools/catalog.json'),'utf8'));assert.deepEqual(catalog.schemas['execution-change'],schema);
  const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);const validate=ajv.compile(schema);
  assert.equal(validate(change),true,JSON.stringify(validate.errors));assert.equal(validate({...change,shell:'ignored'}),false);
  assert.deepEqual(parseExecutionChange(JSON.stringify(change)),change);
  for(const field of Object.keys(change)){const omitted=structuredClone(change);delete omitted[field];assert.equal(validate(omitted),false);assert.throws(()=>parseExecutionChange(JSON.stringify(omitted)));}
  assert.throws(()=>parseExecutionChange(JSON.stringify({...change,device_id:'tv\n'})));
  assert.throws(()=>parseExecutionChange('{"type":"bindings.revoke","device_id":"tv","device_id":"other","expected_binding_revision":"'+revision+'"}'));
  const saved=await operation();assert.equal(ajv.compile({$defs:schema.$defs,$ref:'#/$defs/operation'})(saved),true);
  await verifyExecutionOperation(saved,saved.request);
  for(const mutate of [value=>{value.request_digest=revision;},value=>{value.result.device_id='other';},value=>{value.result.state='revoked';},value=>{value.result.routes['remote.press'].adapter_id='other';},value=>{value.result.model_revision='sha256:'+'c'.repeat(64);},value=>{value.reason='unexpected';}]){
    const bad=structuredClone(saved);mutate(bad);await assert.rejects(verifyExecutionOperation(bad,saved.request));
  }
  assert.throws(()=>verifyExecutionBinding({...saved.result,routes:{'remote.press\n':route}},'tv'));
  for(const operation_id of ['executionop-','executionop-'+'x'.repeat(101)])await assert.rejects(verifyExecutionOperation({...saved,operation_id}));
  await assert.rejects(verifyExecutionOperation({...saved,result:{...saved.result,revision:change.expected_binding_revision}}));
  await assert.rejects(verifyExecutionOperation({...saved,status:'rejected',reason:'execution_offer_unavailable\n',result:null}));
});
test('CLI接入原请求先私有落盘，丢响应/404只GET且拒绝异参和伪造结果',async t=>{
  let writes=0,reads=0,saved;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='POST'){writes++;saved=await operation(req.headers['idempotency-key']);req.resume();req.socket.destroy();return;}
    reads++;if(reads===1){res.statusCode=404;res.end(JSON.stringify({error:{code:'execution_operation_not_found'}}));}else res.end(JSON.stringify(saved));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const directory=path.join(root,'.dev','execution-boundaries-'+randomBytes(8).toString('hex'));await mkdir(directory,{recursive:true});
  const input=path.join(directory,'input.json'),blocked=path.join(directory,'blocked');await writeFile(input,JSON.stringify(change));await writeFile(blocked,'regular-file');
  const env={...process.env,LIMEIOT_TOKEN:'fixture-owner',LIMEIOT_ENDPOINT:'http://127.0.0.1:'+server.address().port};delete env.LIMEIOT_TOKEN_FILE;
  async function cli(state,code){let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs','invoke','execution-changes.create','--space-id','space','--idempotency-key','original','--state-dir',state,'--input',input],{cwd:root,env,timeout:6000});}catch(error){result=error;}assert.equal(result.code??0,code,result.stderr);return result;}
  await cli(blocked,5);assert.equal(writes,0);
  const state=path.join(directory,'state');await cli(state,6);assert.equal(writes,1);
  await cli(state,6);assert.equal(writes,1);assert.equal(reads,1);
  assert.equal(JSON.parse((await cli(state,0)).stdout).operation_id,saved.operation_id);assert.equal(writes,1);
  await writeFile(input,JSON.stringify({...change,expected_binding_revision:'sha256:'+'c'.repeat(64)}));await cli(state,4);assert.equal(reads,2);assert.equal(writes,1);
  await writeFile(input,JSON.stringify(change));saved.result.routes['remote.press'].adapter_id='forged';await cli(state,6);assert.equal(writes,1);
});
test('组合绑定固定原生能力与适配路径，拒绝重复、重叠及被替换的决定',async()=>{
  const schema=JSON.parse(await readFile(path.join(root,'contracts/execution-bindings.schema.json'),'utf8'));
  const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);const validate=ajv.compile(schema);
  const compose={...change,type:'bindings.compose',native_paths:['apps.launch'],expected_native_session:'native-session'};
  assert.equal(validate(compose),true,JSON.stringify(validate.errors));
  assert.deepEqual(parseExecutionChange(JSON.stringify(compose)),compose);
  for(const mutate of [v=>{delete v.expected_native_session;},v=>{v.native_paths=[];},v=>{v.native_paths=['apps.launch','apps.launch'];},v=>{v.native_paths=['apps.launch\n'];},v=>{v.expected_native_session='session\n';}]){
    const bad=structuredClone(compose);mutate(bad);assert.equal(validate(bad),false);assert.throws(()=>parseExecutionChange(JSON.stringify(bad)));
  }
  assert.throws(()=>parseExecutionChange(JSON.stringify({...compose,native_paths:['remote.press','apps.launch']})));
  const saved=await operation();saved.request.change=compose;saved.request_digest=await documentDigest(saved.request);
  saved.result.state='composed';saved.result.native_paths=['apps.launch'];delete saved.result.routes['apps.launch'];
  assert.equal(ajv.compile({$defs:schema.$defs,$ref:'#/$defs/operation'})(saved),true);
  await verifyExecutionOperation(saved,saved.request);
  for(const mutate of [v=>{v.result.native_paths=['remote.press'];},v=>{v.result.state='bound';},v=>{delete v.result.native_paths;},v=>{v.result.routes['apps.launch']=route;},v=>{v.result.native_paths=['apps.launch','other.action'];}]){
    const bad=structuredClone(saved);mutate(bad);await assert.rejects(verifyExecutionOperation(bad,saved.request));
  }
});
