import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile,readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root } from '../tools/dev-stack.mjs';
import { pcmWav } from './helpers/media.mjs';
import { createMediaOriginal,parseMediaChange,validMediaOriginal,verifyMediaOperation,verifyMediaPage,verifyPcmWav } from '../packages/protocol/media.mjs';
const exec=promisify(execFile),bytes=pcmWav(),change={type:'media.upload',content_base64:bytes.toString('base64'),retain_seconds:600};
function operation(original) {
  const c=original.change,created_at='2026-11-03T00:00:00Z';
  return {space_id:original.space_id,operation_id:'mediaop-original',idempotency_key:original.idempotency_key,request_digest:original.request_digest,kind:c.type,created_at,
    result:{type:'uploaded',media:{media_id:'media-original',space_id:original.space_id,content_type:'audio/wav',purpose:'device_playback',actor:'local_owner',byte_length:c.byte_length,content_digest:c.content_digest,audio:c.audio,created_at,expires_at:'2026-11-03T00:10:00Z'}}};
}
test('媒体输入与WAV边界拒绝重复字段、额外URL、非规范base64和损坏音频',()=>{
  assert.deepEqual(parseMediaChange(JSON.stringify(change)),change);assert.equal(verifyPcmWav(bytes).frames,16000);
  for(const value of [{...change,url:'http://example.org'},{...change,retain_seconds:1},{...change,content_base64:change.content_base64+'='},{type:'media.grant',media_id:'media',device_id:'speaker',expected_binding_revision:'bad',valid_for_seconds:300}]) assert.throws(()=>parseMediaChange(JSON.stringify(value)));
  assert.throws(()=>parseMediaChange('{"type":"media.delete","media_id":"one","media_id":"two"}'));
  for(const i of [0,4,20,22,34,40]) {const bad=Buffer.from(bytes);bad[i]=255;assert.throws(()=>verifyPcmWav(bad));}
  assert.throws(()=>verifyPcmWav(bytes.subarray(0,-1)));
});
test('原记录只保留摘要，回执严格绑定空间、键、输入摘要、实际音频与期限',async()=>{
  const original=await createMediaOriginal('http://127.0.0.1:1','home','upload',change),value=operation(original);
  assert.equal(validMediaOriginal(original,original.origin,'home'),true);assert.equal(JSON.stringify(original).includes(change.content_base64),false);assert.equal('content_base64' in original.change,false);
  verifyMediaOperation(value,'home','upload',original);
  for(const edit of [v=>v.space_id='other',v=>v.idempotency_key='other',v=>v.request_digest='sha256:'+'0'.repeat(64),v=>v.result.media.content_digest='sha256:'+'0'.repeat(64),v=>v.result.media.audio.frames=1,v=>v.result.media.expires_at='2026-11-03T00:09:00Z',v=>v.result.download_url='http://example.org']) {const bad=structuredClone(value);edit(bad);assert.throws(()=>verifyMediaOperation(bad,'home','upload',original));}
});
test('媒体列表拒绝重复、跨空间、正文、令牌和损坏授权，并保留静态/托管候选区别',async()=>{
  const original=await createMediaOriginal('http://127.0.0.1:1','home','upload',change),media=operation(original).result.media;
  const page={space_id:'home',configured:true,items:[{metadata:media,available:true,deleted_at:null}],grants:[],next_cursor:null};verifyMediaPage(page,'home');
  for(const edit of [v=>v.space_id='other',v=>v.items.push(v.items[0]),v=>v.items[0].content_base64=change.content_base64,v=>v.items[0].metadata.space_id='other',v=>v.grants.push({token:'private'}),v=>v.configured=false]) {const bad=structuredClone(page);edit(bad);assert.throws(()=>verifyMediaPage(bad,'home'));}
});
test('正式媒体Schema与AI目录一致，机器输入输出覆盖公开空间回执且无下载凭证',async()=>{
  const schema=JSON.parse(await readFile(path.join(root,'contracts/media.schema.json'),'utf8')),catalog=JSON.parse(await readFile(path.join(root,'contracts/tools/catalog.json'),'utf8'));
  assert.deepEqual(catalog.schemas.media,schema);for(const id of ['media.list','media-changes.create','media-changes.resolve'])assert.ok(catalog.operations.some(o=>o.operation_id===id));
  const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);ajv.addSchema(schema);assert.equal(ajv.getSchema(schema.$id)(change),true);
  const original=await createMediaOriginal('http://127.0.0.1:1','home','upload',change);assert.equal(ajv.getSchema(schema.$id+'#/$defs/operation')(operation(original)),true);
});
test('媒体CLI丢回执后只GET，404不重传；坏原记录零POST，异参和伪造回执拒绝',{timeout:30000},async t=>{
  const directory=await mkdtemp(path.join(root,'.dev/media-cli-')),input=path.join(directory,'input.json'),audio=path.join(directory,'audio.wav');await writeFile(input,JSON.stringify(change));await writeFile(audio,bytes);
  let writes=0,reads=0,firstRead=true,corrupt=false;const saved=new Map();let endpoint;
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST') {writes++;let body='';for await(const chunk of req)body+=chunk;const key=req.headers['idempotency-key'];const original=await createMediaOriginal(endpoint,'home',key,JSON.parse(body));saved.set(key,operation(original));if(key==='lost'){req.socket.destroy();return;}res.end(JSON.stringify(saved.get(key)));return;}
    reads++;const key=decodeURIComponent(req.url.split('/').at(-1));if(firstRead){firstRead=false;res.statusCode=404;res.end(JSON.stringify({error:{code:'media_operation_not_found'}}));return;}
    const value=structuredClone(saved.get(key));if(corrupt)value.result.download_url='http://example.org';res.end(JSON.stringify(value));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));endpoint='http://127.0.0.1:'+server.address().port;
  const env={...process.env,LIMEIOT_ENDPOINT:endpoint,LIMEIOT_TOKEN:'owner'};delete env.LIMEIOT_TOKEN_FILE;
  async function cli(args,code=0,state=path.join(directory,'state')) {let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs',...args,'--space-id','home','--state-dir',state],{cwd:root,env,timeout:7000});}catch(error){result=error;}assert.equal(result.code??0,code,result.stderr);return result;}
  const args=['invoke','media-changes.create','--input',input,'--idempotency-key','lost'];
  await cli(args,6);assert.equal(writes,1);await cli(args,6);assert.equal(writes,1);const restored=JSON.parse((await cli(args)).stdout);assert.equal(restored.idempotency_key,'lost');assert.equal(writes,1);assert.equal(reads,2);
  const records=await readdir(path.join(directory,'state/media-operations'));const record=JSON.parse(await readFile(path.join(directory,'state/media-operations',records[0]),'utf8'));assert.equal('content_base64' in record.change,false);
  await writeFile(input,JSON.stringify({...change,retain_seconds:300}));await cli(args,4);assert.equal(writes,1);await writeFile(input,JSON.stringify(change));
  const blocked=path.join(directory,'blocked');await writeFile(blocked,'not a directory');await cli(args,5,blocked);assert.equal(writes,1);
  const uploaded=JSON.parse((await cli(['media','upload','--file',audio,'--retain-seconds','600','--idempotency-key','file'])).stdout);assert.equal(uploaded.result.media.byte_length,bytes.length);assert.equal(writes,2);
  corrupt=true;await cli(['invoke','media-changes.resolve','--id','file'],6);assert.equal(writes,2);
});
