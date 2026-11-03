import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root,until } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
const base='/api/v1/spaces/space-demo',devicePath=base+'/devices/device-lamp';
const post=(change,key)=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(change)});
function rawGet(url,options={}) {
  return new Promise((resolve,reject)=>{
    const request=http.request(url,options,response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,bytes:Buffer.concat(chunks)}));});
    request.setTimeout(3000,()=>request.destroy(new Error('download_timeout')));request.on('error',reject);request.end();
  });
}

test('平台媒体软件闭环：上传、明确授权、真实Range播放、撤销、删除及重启原地址失效',{timeout:120000},async t=>{
  const {directory,bytes,fixture,stack,model,mediaPort}=await mediaStack(t,'media-journey-');
  const schema=JSON.parse(await readFile(path.join(root,'contracts/media.schema.json'),'utf8'));const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(schema);
  const validate=(definition,value)=>{const check=ajv.getSchema(schema.$id+'#/$defs/'+definition);assert.equal(check(value),true,JSON.stringify(check.errors));};
  const apply=async(change,key)=>{const result=await stack.request(base+'/media-operations',post(change,key));if(result.status===200)validate('operation',result.value);return result;};
  const list=async()=>{const value=(await stack.request(base+'/media')).value;validate('page',value);return value;};
  // 仅隔离测试读取本机私有快照；公开回执不提供路径凭证。
  const downloadUrl=async receipt=>{const state=JSON.parse(await readFile(path.join(directory,'gateway.sqlite.media.json'),'utf8'));const grant=state.grants[receipt.grant_id].grant;return `http://127.0.0.1:${mediaPort}/media/v1/${grant.grant_id}/${grant.token}.wav`;};
  const upload={type:'media.upload',content_base64:bytes.toString('base64'),retain_seconds:600};assert.ok(JSON.stringify(upload).length>16384);
  assert.equal((await stack.request('/api/v1/spaces/other/media')).status,403);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT+base+'/media')).status,401);
  const invalid=await apply({...upload,content_base64:Buffer.from('invalid').toString('base64')},'bad-upload');assert.equal(invalid.status,422);assert.equal((await list()).items.length,0);
  const accepted=await apply(upload,'upload');assert.equal(accepted.status,200,JSON.stringify(accepted.value));const media=accepted.value.result.media;
  assert.equal(media.byte_length,bytes.length);assert.equal(media.audio.frames,16000);assert.equal((await apply(upload,'upload')).value.operation_id,accepted.value.operation_id);
  assert.equal((await apply({...upload,retain_seconds:300},'upload')).status,409);assert.equal((await list()).items.length,1);
  const initial=(await stack.request(devicePath+'/execution-binding')).value;
  const grantChange=revision=>({type:'media.grant',media_id:media.media_id,device_id:'device-lamp',expected_binding_revision:revision,valid_for_seconds:300});
  assert.notEqual((await apply(grantChange(initial.revision),'unbound')).status,200);assert.equal(fixture.effects.length,0);
  const offers=(await stack.request(base+'/execution-adapters')).value;
  const bind=await stack.request(base+'/execution-operations',post({type:'bindings.bind',device_id:'device-lamp',expected_binding_revision:initial.revision,expected_model_revision:model.model_revision,route:offers.items[0].route},'bind'));assert.equal(bind.value.status,'applied');
  const binding=(await stack.request(devicePath+'/execution-binding')).value;await until(async()=>(await stack.request(devicePath)).value.ready);
  const first=await apply(grantChange(binding.revision),'grant');assert.equal(first.status,200,JSON.stringify(first.value));const grant=first.value.result,url=await downloadUrl(grant);assert.equal('download_url' in grant,false);
  assert.equal(grant.issued_in_process,true);assert.equal((await list()).grants[0].active_in_process,true);assert.equal(JSON.stringify(await list()).includes(url),false);
  assert.equal((await stack.request(base+'/execution-adapters')).value.items[0].media[0].media_id,media.media_id);
  const full=await rawGet(url);assert.equal(full.status,200);assert.deepEqual(full.bytes,bytes);assert.equal(full.headers['cache-control'],'no-store');
  const partial=await rawGet(url,{headers:{Range:'bytes=44-63'}});assert.equal(partial.status,206);assert.deepEqual(partial.bytes,bytes.subarray(44,64));assert.equal(partial.headers['content-range'],`bytes 44-63/${bytes.length}`);
  const suffix=await rawGet(url,{headers:{Range:'bytes=-4'}});assert.equal(suffix.status,206);assert.deepEqual(suffix.bytes,bytes.subarray(-4));
  const head=await rawGet(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),bytes.length);
  const cached=await rawGet(url,{headers:{'If-None-Match':full.headers.etag}});assert.equal(cached.status,304);assert.equal(cached.bytes.length,0);
  assert.equal((await rawGet(url,{headers:{Range:'bytes=0-1,3-4'}})).status,416);
  assert.equal((await rawGet(url,{headers:{Range:'bytes=0-1','If-Range':'"obsolete"'}})).status,200);
  assert.equal((await rawGet(url,{headers:{Host:'example.org'}})).status,404);assert.equal((await rawGet(url,{headers:{Origin:stack.env.LIMEIOT_ENDPOINT}})).status,404);
  let sourceIpHttp='passed';try{assert.equal((await rawGet(url,{localAddress:'127.0.0.2'})).status,404);}catch(error){if(error.code!=='EADDRNOTAVAIL')throw error;sourceIpHttp='unavailable_loopback_alias';}
  assert.equal((await rawGet(url.replace(/([0-9a-f]{64})\.wav$/,`${'0'.repeat(64)}.wav`))).status,404);
  const command=()=>({device_id:'device-lamp',model_revision:model.model_revision,expires_at:new Date(Date.now()+8000).toISOString(),operation:{type:'action.invoke',path:'playback.play',value:{media_id:media.media_id}}});
  const play=await stack.request(base+'/commands',post(command(),'play'));assert.equal(play.status,202);await until(async()=>(await stack.request(base+'/commands/'+play.value.command_id)).value.status==='confirmed');
  assert.deepEqual(fixture.effects.map(e=>e.action),['SetVolume','SetAVTransportURI','Play']);assert.deepEqual(fixture.renderedPulls,[{status:206,byte_length:bytes.length}]);assert.equal(fixture.pulls.length,0);
  assert.equal((await list()).grants[0].pulls.some(p=>p.status===206),true);assert.deepEqual((await stack.request(devicePath)).value.reported,{});
  await apply({type:'media.revoke',grant_id:grant.grant_id},'revoke');assert.equal((await rawGet(url)).status,404);assert.equal((await list()).grants[0].active_in_process,false);
  assert.equal((await stack.request(base+'/media-operations/by-key/grant')).value.operation_id,first.value.operation_id);assert.equal((await rawGet(url)).status,404);
  const denied=await stack.request(base+'/commands',post(command(),'revoked'));await until(async()=>(await stack.request(base+'/commands/'+denied.value.command_id)).value.status==='failed');assert.equal(fixture.effects.length,3);
  const fresh=(await apply(grantChange(binding.revision),'grant-new')).value;
  const freshUrl=await downloadUrl(fresh.result);assert.equal((await rawGet(freshUrl)).status,200);await stack.restartGateway();await until(async()=>(await stack.request(devicePath)).value.ready);
  assert.equal((await rawGet(freshUrl)).status,404);assert.equal((await list()).items[0].available,true);
  const original=(await stack.request(base+'/media-operations/by-key/grant-new')).value;assert.equal(original.operation_id,fresh.operation_id);assert.equal(original.result.issued_in_process,false);assert.equal((await apply(grantChange(binding.revision),'grant-new')).value.operation_id,fresh.operation_id);assert.equal((await rawGet(freshUrl)).status,404);
  const afterRestart=(await apply(grantChange(binding.revision),'grant-after-restart')).value,afterRestartUrl=await downloadUrl(afterRestart.result);assert.equal((await rawGet(afterRestartUrl)).status,200);
  const revokeBinding=await stack.request(base+'/execution-operations',post({type:'bindings.revoke',device_id:'device-lamp',expected_binding_revision:binding.revision},'revoke-binding'));assert.equal(revokeBinding.value.status,'applied');assert.equal((await rawGet(afterRestartUrl)).status,404);assert.equal((await list()).grants.every(g=>!g.binding_current),true);
  await apply({type:'media.delete',media_id:media.media_id},'delete');assert.equal((await list()).items[0].available,false);assert.equal((await apply(upload,'upload')).value.operation_id,accepted.value.operation_id);await stack.restartGateway();assert.equal((await list()).items[0].available,false);
  const disk=JSON.parse(await readFile(path.join(directory,'gateway.sqlite.media.json'),'utf8'));assert.equal(disk.objects[media.media_id].content_base64,null);assert.equal(Object.keys(disk.objects).length,1);
  assert.equal(fixture.effects.length,3);assert.equal(fixture.proofs.every(p=>p.command.status==='dispatched'),true);
  const report={passed:true,real_http:true,real_sqlite:true,real_mqtt:true,simulated_renderer:true,uploaded_bytes:bytes.length,upload_above_default_body_limit:true,durable_before_soap:true,media_range_pulls:fixture.renderedPulls.length,soap_mutations:fixture.effects.length,source_ip_http:sourceIpHttp,host_origin_token_checks:true,range_head_etag:true,revoke_immediate:true,restart_invalidates_urls:true,original_receipt_no_regrant:true,binding_revoke_denies_download:true,delete_no_resurrection:true,hardware:false,hardware_status:'用户要求跳过',audible_output:false,browser:false,cli:false,nas_image_rebuilt:false,published:false,full_goal_completed:false};
  await writeFile(path.join(directory,'media-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(directory,'media-result.json')}));
});
