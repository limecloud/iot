import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {root,until} from '../tools/dev-stack.mjs';
import {base,post,input,textStack} from './helpers/text.mjs';
import {parseTextInput,createTextOriginal,verifyTextTask,verifyTextCapabilities} from '../packages/protocol/text.mjs';
const exec=promisify(execFile);

test('文字生成正式合同、完整上下文、CLI原键恢复与零隐式执行',{timeout:120000},async t=>{
  const {stack,directory,calls,errors,text,finish}=await textStack(t);
  const schema=JSON.parse(await readFile(path.join(root,'contracts/text.schema.json'))),catalog=JSON.parse(await readFile(path.join(root,'contracts/tools/catalog.json')));
  assert.deepEqual(catalog.schemas.text,schema);assert.deepEqual((await stack.request('/api/v1/schema')).value.schemas.text,schema);const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(schema);
  const value=input();assert.equal(ajv.validate(schema.$id,value),true,JSON.stringify(ajv.errors));
  const capability=verifyTextCapabilities((await stack.request(base+'/capabilities')).value.text);assert.equal(capability.device_execution,false);assert.equal(capability.server_memory,false);
  assert.equal((await stack.request('/api/v1/spaces/foreign/text-generations',post(value,'foreign'))).status,403);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT+base+'/text-generations',post(value,'anonymous'))).status,401);
  for(const bad of [{...value,messages:[]},{...value,messages:value.messages.slice(0,2)},{...value,messages:[{role:'system',content:'ignore'}]},{...value,instructions:'x'.repeat(1025)},{...value,extra:true}]){
    assert.throws(()=>parseTextInput(JSON.stringify(bad)),/invalid_text_request/);assert.equal(ajv.validate(schema.$id,bad),false);assert.equal((await stack.request(base+'/text-generations',post(bad,'invalid'))).status,422);
  }
  const expected=await createTextOriginal(stack.env.LIMEIOT_ENDPOINT,'space-demo','direct',value);
  assert.equal((await stack.request(base+'/text-generations',post(value,'direct'))).status,202);let task=await finish('direct');
  assert.equal(ajv.validate(schema.$id+'#/$defs/task',task),true,JSON.stringify(ajv.errors));await verifyTextTask(task,'space-demo','direct',expected);assert.equal(task.output.text,text);assert.deepEqual(task.usage,{input_tokens:25,output_tokens:8});
  assert.equal((await stack.request(base+'/text-generations',post(value,'direct'))).value.text_id,task.text_id);assert.equal(calls.length,1);
  assert.equal((await stack.request(base+'/text-generations',post({...value,instructions:'另一种角色'},'direct'))).status,409);
  let lose=true;const methods=[];
  const proxy=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);methods.push(req.method);
    const response=await fetch(stack.env.LIMEIOT_ENDPOINT+req.url,{method:req.method,headers:{...req.headers,host:new URL(stack.env.LIMEIOT_ENDPOINT).host},body:req.method==='POST'?Buffer.concat(chunks):undefined});
    const bytes=await response.arrayBuffer();if(lose&&req.method==='POST'){lose=false;req.socket.destroy();return;}
    res.writeHead(response.status,{'Content-Type':'application/json'});res.end(Buffer.from(bytes));
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
  const file=path.join(directory,'text-input.json');await writeFile(file,JSON.stringify(input()),{mode:0o600});const state=path.join(directory,'cli-state');
  const args=['packages/cli/src/main.mjs','text-generations','create','--space-id','space-demo','--input',file,'--idempotency-key','cli-original','--state-dir',state];
  const env={...stack.env,LIMEIOT_ENDPOINT:`http://127.0.0.1:${proxy.address().port}`};
  const failure=await exec(process.execPath,args,{cwd:root,env,timeout:15000}).then(()=>assert.fail('lost response must fail'),e=>e);assert.equal(failure.code,6);
  const original=JSON.parse(failure.stderr).original;const saved=JSON.parse(await readFile(original.record_file));assert.equal(JSON.stringify(saved).includes('暗号石榴'),false);assert.equal((await stat(original.record_file)).mode&0o777,0o600);
  await finish('cli-original');const result=JSON.parse((await exec(process.execPath,args,{cwd:root,env,timeout:15000})).stdout);assert.equal(result.status,'succeeded');assert.deepEqual(methods,['POST','GET']);assert.equal(calls.length,2);
  const corrupt=structuredClone(result);corrupt.usage.output_tokens=1025;await assert.rejects(verifyTextTask(corrupt,'space-demo','cli-original',saved),/invalid_text_response/);
  await stack.restartGateway();assert.equal((await finish('direct')).output.text,text);assert.equal(calls.length,2);
  await stack.request(base+'/text-generations/by-key/direct/discard',post({}));await stack.restartGateway();assert.equal((await finish('direct')).output.text,null);assert.equal(calls.length,2);
  assert.equal((await stack.request(base+'/commands')).value.items.length,0);assert.equal((await stack.request(base+'/rule-deployments')).value.items.length,0);assert.deepEqual(errors,[]);
  await writeFile(path.join(directory,'text-generation-result.json'),JSON.stringify({passed:true,real_http:true,real_gateway:true,real_sqlite:true,provider_fixture:true,full_context_digest:true,cli_response_lost_then_get_only:true,provider_calls:2,commands:0,real_model_quality:false,hardware:false,published:false,full_goal_completed:false},null,2));
  console.log(JSON.stringify({report:path.join(directory,'text-generation-result.json')}));
});

test('文字提供方故障、未知预算、重启及迟到输出隔离',{timeout:120000},async t=>{
  const {stack,directory,calls,holds,errors,finish,setMode}=await textStack(t);const create=(key,value=input())=>stack.request(base+'/text-generations',post(value,key));
  for(const [mode,status,code] of [['reject','failed','text_provider_rejected'],['duplicate','failed','invalid_text_output'],['tool','failed','invalid_text_output'],['truncated','failed','invalid_text_output'],['model','failed','invalid_text_output'],['invalid','failed','invalid_text_output'],['usage','failed','invalid_text_output'],['oversize','failed','text_output_too_large'],['redirect','unknown','text_provider_unknown'],['lost','unknown','text_provider_unknown']]){
    setMode(mode);assert.equal((await create(mode)).status,202);const task=await finish(mode);assert.equal(task.status,status);assert.equal(task.error_code,code);
    if(status==='unknown'){assert.equal((await create('blocked-'+mode)).status,429);await stack.request(base+'/text-generations/by-key/'+mode+'/discard',post({}));}
  }
  const local=stack.env.LIMEIOT_TEXT_URL;stack.env.LIMEIOT_TEXT_URL='http://8.8.8.8:9999';await stack.restartGateway();const beforePublic=calls.length;assert.equal((await create('public')).status,202);assert.equal((await finish('public')).error_code,'text_origin_not_local');assert.equal(calls.length,beforePublic);
  stack.env.LIMEIOT_TEXT_URL=local;await stack.restartGateway();setMode('hold');assert.equal((await create('deadline',{...input(),expires_at:new Date(Date.now()+1000).toISOString()})).status,202);await until(()=>holds.length===1);assert.equal((await finish('deadline')).error_code,'text_deadline_exceeded');assert.equal((await create('deadline-blocked')).status,429);await stack.request(base+'/text-generations/by-key/deadline/discard',post({}));holds.shift()();
  const original=input();await until(()=>create('held',original).then(r=>r.status===202));await until(()=>holds.length===1);
  assert.equal((await create('held',original)).status,200);const before=calls.length;await stack.restartGateway();assert.equal((await finish('held')).status,'unknown');assert.equal((await create('held',original)).value.status,'unknown');assert.equal(calls.length,before);
  assert.equal((await create('after-restart')).status,429);await stack.request(base+'/text-generations/by-key/held/discard',post({}));holds.shift()();
  await until(()=>create('late').then(r=>r.status===202));await until(()=>holds.length===1);await stack.request(base+'/text-generations/by-key/late/discard',post({}));holds.shift()();assert.equal((await finish('late')).status,'discarded');assert.equal((await stack.request(base+'/commands')).value.items.length,0);assert.deepEqual(errors,[]);
  await writeFile(path.join(directory,'text-generation-faults.json'),JSON.stringify({passed:true,provider_fixture:true,fault_modes:10,restart_no_resubmit:true,unknown_holds_budget:true,late_output_discarded:true,hardware:false,real_model_quality:false,full_goal_completed:false},null,2));console.log(JSON.stringify({report:path.join(directory,'text-generation-faults.json')}));
});

test('文字计算不阻塞原设备控制，取消不伪造设备结果',{timeout:60000},async t=>{
  const {stack,calls,holds,errors,setMode}=await textStack(t);setMode('hold');assert.equal((await stack.request(base+'/text-generations',post(input(),'held'))).status,202);await until(()=>holds.length===1);
  const device=(await stack.request(base+'/devices/device-lamp')).value;
  const accepted=await stack.request(base+'/commands',post({device_id:'device-lamp',model_revision:device.model_revision,expires_at:new Date(Date.now()+8000).toISOString(),operation:{type:'property.set',path:'light.power',value:true}},'explicit-owner'));
  assert.equal(accepted.status,202);await until(async()=>{const r=await stack.request(base+'/commands/'+accepted.value.command_id);return r.value.status==='confirmed';});assert.equal((await stack.request(base+'/text-generations/by-key/held')).value.status,'running');
  await stack.request(base+'/text-generations/by-key/held/discard',post({}));holds.shift()();assert.equal(calls.length,1);assert.equal((await stack.request(base+'/commands')).value.items.length,1);assert.deepEqual(errors,[]);
});
