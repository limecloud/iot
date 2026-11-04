import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {root,until,freePort,stop} from '../tools/dev-stack.mjs';
import {base,post,input,textStack} from './helpers/text.mjs';
const exec=promisify(execFile),snapshot='data/gateway.sqlite.media.json',manager=path.join(root,'deploy/nas/manage.py');
test('NAS文字v5原字节备份及新目录恢复，未知任务不重发',{timeout:150000},async t=>{
  const parent=await mkdtemp(path.join(root,'.dev/text-nas-')),installation=path.join(parent,'installation'),backup=path.join(parent,'backup'),restored=path.join(parent,'restored');
  const manage=(...args)=>exec('python3',[manager,...args],{cwd:root,timeout:45000});
  await manage('init','--directory',installation,'--origin','https://127.0.0.1:18443');
  const secret=async name=>(await readFile(path.join(installation,'secrets',name),'utf8')).trim();
  const credentials={owner:await secret('owner-token'),gateway:await secret('gateway-password'),lamp:await secret('device-lamp-password'),button:await secret('device-button-password')};
  const {stack,calls,holds,errors,text,finish,setMode}=await textStack(t,{directory:path.join(installation,'data'),credentials});
  await manage('media-config','--directory',installation,'--media-origin',stack.env.LIMEIOT_MEDIA_ORIGIN);
  assert.equal((await stack.request(base+'/text-generations',post(input(),'completed'))).status,202);assert.equal((await finish('completed')).output.text,text);
  setMode('hold');assert.equal((await stack.request(base+'/text-generations',post(input(),'running'))).status,202);await until(()=>holds.length===1);
  const bytes=await readFile(path.join(installation,snapshot));const disk=JSON.parse(bytes);assert.equal(disk.schema_version,5);
  await manage('backup','--directory',installation,'--output',backup);assert.deepEqual(await readFile(path.join(backup,snapshot)),bytes);assert.equal((await stat(path.join(backup,snapshot))).mode&0o777,0o600);
  await manage('restore','--directory',restored,'--backup',backup);assert.deepEqual(await readFile(path.join(restored,snapshot)),bytes);
  stack.env.LIMEIOT_DB=path.join(restored,'data/gateway.sqlite');stack.env.LIMEIOT_CONFIG=path.join(restored,'config/gateway.json');await stack.restartGateway();
  assert.equal((await finish('completed')).output.text,text);const unknown=await finish('running');assert.equal(unknown.status,'unknown');assert.equal(unknown.request_digest,disk.texts.running.request_digest);assert.equal(calls.length,2);
  assert.equal((await stack.request(base+'/text-generations',post(input(),'blocked'))).status,429);
  await stack.request(base+'/text-generations/by-key/running/discard',post({}));holds.shift()();await stack.request(base+'/text-generations/by-key/completed/discard',post({}));await stack.restartGateway();assert.equal((await finish('completed')).output.text,null);assert.equal((await finish('running')).status,'discarded');assert.equal(calls.length,2);
  const bad=path.join(parent,'bad-v4.json');await writeFile(bad,JSON.stringify({...disk,schema_version:4}),{mode:0o600});
  const rejected=await exec('python3',['-c','import sys;sys.path.insert(0,"deploy/nas");from media_state import read_snapshot;read_snapshot(sys.argv[1],"space-demo")',bad],{cwd:root}).then(()=>assert.fail('old snapshot must reject text tasks'),error=>error);assert.notEqual(rejected.code,0);
  let compose=['docker','compose'];try{await exec('docker',['compose','version']);}catch{compose=['docker-compose'];}
  const config=JSON.parse((await exec(compose[0],[...compose.slice(1),'--env-file',path.join(installation,'compose.env'),'-f','deploy/nas/compose.yaml','-f','deploy/nas/compose.media.yaml','-f','deploy/nas/compose.text.yaml','config','--format','json'],{cwd:root,timeout:15000,env:{...process.env,LIMEIOT_TEXT_URL:'http://192.168.1.2:11434',LIMEIOT_TEXT_MODEL:'fixture:text'}})).stdout);
  assert.equal(config.services.gateway.environment.LIMEIOT_TEXT_URL,'http://192.168.1.2:11434');assert.equal(config.services.gateway.environment.LIMEIOT_TEXT_MODEL,'fixture:text');assert.deepEqual(errors,[]);
  await writeFile(path.join(parent,'text-generation-nas-result.json'),JSON.stringify({passed:true,host_software:true,snapshot_v5:true,backup_byte_exact:true,restored_new_directory:true,unknown_no_resubmit:true,clear_survives_restart:true,compose_rendered:true,provider_calls:2,provider_fixture:true,container_runtime:false,new_nas_image:false,hardware:false,real_model_quality:false,published:false,full_goal_completed:false},null,2));console.log(JSON.stringify({report:path.join(parent,'text-generation-nas-result.json')}));
});

test('NAS两套Nginx允许有界转义文本，其他路由上限独立',{timeout:120000},async t=>{
  const {stack,directory,calls,errors,finish}=await textStack(t),gateway=new URL(stack.env.LIMEIOT_ENDPOINT);
  const value=input();value.instructions='';value.messages=Array.from({length:7},(_,i)=>({role:i%2===0?'user':'assistant',content:'a'.repeat(256)+'\n'.repeat(768)}));
  const body=JSON.stringify(value).replaceAll('a','\\u0061');assert.ok(Buffer.byteLength(body)>16384);assert.ok(Buffer.byteLength(body)<=65536);
  for(const template of ['nginx.conf','nginx.platform.conf']){
    const prefix=await mkdtemp(path.join(directory,'nginx-')),port=await freePort(),config=path.join(prefix,'nginx.conf');
    for(const name of ['client_body','proxy','fastcgi','uwsgi','scgi'])await mkdir(path.join(prefix,name));
    let source=await readFile(path.join(root,'deploy/nas',template),'utf8');
    source=source.replace(/stream \{[\s\S]*?\n\}\nhttp \{/,'http {').replace('pid /tmp/nginx.pid;',`pid ${prefix}/nginx.pid;`).replaceAll('resolver 127.0.0.11','resolver 127.0.0.1').replaceAll('server gateway:17880 resolve;',`server 127.0.0.1:${gateway.port};`).replaceAll('server control:8080 resolve;',`server 127.0.0.1:${gateway.port};`).replace('listen 8443 ssl;',`listen 127.0.0.1:${port};`).replace(/^\s*ssl_(?:certificate|certificate_key|protocols).*;$/gm,'').replaceAll('/tmp/client_body',prefix+'/client_body').replaceAll('/tmp/proxy',prefix+'/proxy').replaceAll('/tmp/fastcgi',prefix+'/fastcgi').replaceAll('/tmp/uwsgi',prefix+'/uwsgi').replaceAll('/tmp/scgi',prefix+'/scgi');
    if(process.platform==='darwin')source=source.replaceAll(' 64k;',' 256k;');
    await writeFile(config,source);const nginx=stack.launch('text-nginx-'+template,process.env.LIMEIOT_NGINX??'nginx',['-e','stderr','-p',prefix+'/','-c',config,'-g','daemon off;']);
    const call=(resource,body,key)=>new Promise((resolve,reject)=>{const req=http.request(`http://127.0.0.1:${port}`+resource,{method:body===undefined?'GET':'POST',headers:{Host:gateway.host,Authorization:'Bearer '+stack.env.LIMEIOT_TOKEN,...(body===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Idempotency-Key':key})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));});req.setTimeout(10000,()=>req.destroy(new Error('proxy_timeout')));req.on('error',reject);req.end(body);});
    await until(async()=>(await call('/healthz')).status===200);const key=template.replaceAll('.','-');const result=await call(base+'/text-generations',body,key);assert.equal(result.status,202,result.text);assert.equal((await finish(key)).status,'succeeded');
    assert.equal((await call(base+'/text-generations','x'.repeat(65537),'large')).status,413);assert.equal((await call(base+'/commands',JSON.stringify({padding:'x'.repeat(17000)}),'other')).status,413);await stop(nginx);
  }
  assert.equal(calls.length,2);assert.deepEqual(errors,[]);await writeFile(path.join(directory,'text-generation-ingress-result.json'),JSON.stringify({passed:true,real_nginx:true,templates:2,body_above_16k:true,request_limit:65536,other_routes_still_limited:true,provider_fixture:true,container_tls_dns_substituted:true,container_runtime:false,new_nas_image:false,hardware:false,full_goal_completed:false},null,2));console.log(JSON.stringify({report:path.join(directory,'text-generation-ingress-result.json')}));
});
