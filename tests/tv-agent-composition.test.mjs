import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { root,freePort,startStack,stop,until } from '../tools/dev-stack.mjs';
import { createAdbFixture } from './helpers/android-tv.mjs';
import { tvAgentRuntime } from './helpers/tv-agent.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo',devicePath=base+'/devices/device-lamp';
const post=(body,key)=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
async function lines(file){try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}

test('真实JVM TV Agent与假ADB：同设备显式组合、原生日志、单路径离线及未知恢复', {timeout:240000},async t=>{
  const runtime=await tvAgentRuntime();
  const directory=await mkdtemp(path.join(root,'.dev/tv-agent-composition-')),adbState=path.join(directory,'adb-state');await mkdir(adbState,{mode:0o700});
  t.diagnostic('evidence: '+directory);
  const adb=await createAdbFixture(adbState);
  await writeFile(path.join(adbState,'scenario.json'),JSON.stringify({database:path.join(directory,'gateway.sqlite')}));
  const modelPath=path.join(root,'contracts/models/android-tv-remote.json');
  const validated=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',modelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:process.env.LIMEIOT_MODEL_VALIDATOR??path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);assert.equal(validated.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=validated.normalized_model;config.devices[0].model_revision=validated.model_revision;delete config.devices[0].routes;
  const configFile=path.join(directory,'config/gateway.json'),tvFile=path.join(directory,'tv.json');await mkdir(path.dirname(configFile));await writeFile(configFile,JSON.stringify(config));
  await writeFile(tvFile,JSON.stringify({schema_version:1,bindings:[{device_id:'device-lamp',adapter_id:'tv-adb',config:{schema_version:1,adb_path:adb,state_directory:adbState,server_port:5049,target:'192.168.31.94:5555',fingerprint:'Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys',device_serial:'sample-tv-001',applications:[{application_id:'com.example.player',category:'leanback'}],timeout_ms:3000}}]}));
  const provision='import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n';
  await exec('python3',['-c',provision,directory],{cwd:root,timeout:20000});
  const tlsPort=await freePort();
  const stack=await startStack({directory,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configFile,LIMEIOT_TV_CONFIG:tvFile},brokerTls:{port:tlsPort,ca:path.join(directory,'broker-tls/ca.crt'),certificate:path.join(directory,'broker-tls/server.crt'),key:path.join(directory,'broker-tls/server.key')}});t.after(()=>stack.close());await stop(stack.lamp);
  const broker='ssl://127.0.0.1:'+tlsPort,enrollmentFile=path.join(directory,'credentials/enrollment.json');
  const packaged=JSON.parse((await exec('python3',['tools/tv-agent-enrollment.py','--identity-directory',path.join(directory,'credentials'),'--broker',broker,'--model-profile','android-tv-remote','--output',enrollmentFile],{cwd:root,timeout:15000})).stdout);assert.equal(packaged.model_profile,'android-tv-remote');
  const enrollment=JSON.parse(await readFile(enrollmentFile,'utf8')),ajv=new Ajv({strict:true,allErrors:true});
  const validate=ajv.compile(JSON.parse(await readFile(path.join(root,'contracts/tv-agent-enrollment.schema.json'),'utf8')));
  assert.equal(validate(enrollment),true,JSON.stringify(validate.errors));
  for(const bad of [{...enrollment,model_profile:'arbitrary-model'},{...enrollment,schema_version:1},Object.fromEntries(Object.entries(enrollment).filter(([key])=>key!=='model_profile'))])assert.equal(validate(bad),false);
  let worker,done,launches=0;
  const workerEnv={...process.env,LIMEIOT_TV_AGENT_JOURNEY:'1',LIMEIOT_TV_AGENT_PROFILE:'android-tv-remote',LIMEIOT_TV_AGENT_DIRECTORY:directory,LIMEIOT_TV_AGENT_BROKER:broker,LIMEIOT_TV_AGENT_GATEWAY_DATABASE:stack.env.LIMEIOT_DB};
  async function launch(unknown=false){
    const previous=(await stack.request(devicePath)).value.boot_id;workerEnv.LIMEIOT_TV_AGENT_EFFECT_UNKNOWN=unknown?'1':'0';launches++;
    worker=spawn(runtime.executable,runtime.args,{cwd:root,env:workerEnv,stdio:['ignore','pipe','pipe']});
    const stream=createWriteStream(path.join(directory,'jvm-'+launches+'.log'));worker.stdout.pipe(stream);worker.stderr.pipe(stream);worker.once('exit',()=>stream.end());
    done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>resolve(code));});done.catch(()=>{});
    await until(async()=>{const view=(await stack.request(devicePath)).value;return view.ready&&view.boot_id!==previous&&view.session_id&&view.action_availability?.['apps.launch']===true;},90000);
  }
  async function finish(){await writeFile(path.join(directory,'stop'),'stop');assert.equal(await done,0);await rename(path.join(directory,'stop'),path.join(directory,'stop-'+launches));}
  t.after(async()=>{if(worker)await stop(worker);});
  await launch();
  const current=(await stack.request(devicePath)).value,initial=(await stack.request(devicePath+'/execution-binding')).value,route=(await stack.request(base+'/execution-adapters')).value.items[0].route;
  const change={type:'bindings.compose',device_id:'device-lamp',route,native_paths:['apps.launch'],expected_native_session:current.session_id,expected_binding_revision:initial.revision,expected_model_revision:validated.model_revision};
  const input=path.join(directory,'compose.json');await writeFile(input,JSON.stringify(change));
  const approved=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','invoke','execution-changes.create','--space-id','space-demo','--idempotency-key','compose','--state-dir',path.join(directory,'cli-state'),'--input',input],{cwd:root,env:stack.env,timeout:6000})).stdout);assert.equal(approved.status,'applied');
  await until(async()=>{const view=(await stack.request(devicePath)).value;return view.action_availability?.['apps.launch']&&view.action_availability?.['remote.press'];});
  const requests=new Map();
  async function command(key,action='apps.launch',application='com.example.player'){
    const body={device_id:'device-lamp',model_revision:validated.model_revision,expires_at:new Date(Date.now()+12000).toISOString(),operation:{type:'action.invoke',path:action,value:action==='apps.launch'?{application_id:application}:{key:'home'}}};requests.set(key,body);
    const response=await stack.request(base+'/commands',post(body,key));assert.equal(response.status,202,JSON.stringify(response.value));return response.value;
  }
  async function settled(command,status='confirmed'){await until(async()=>(await stack.request(base+'/commands/'+command.command_id)).value.status===status);}
  const remote=await command('remote-first','remote.press'),native=await command('native-second');await settled(remote);await settled(native);
  const refused=await command('native-denied','apps.launch','com.android.settings');await settled(refused,'failed');
  await until(async()=>Object.keys(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries).length===0);
  assert.equal((await lines(path.join(directory,'effects.jsonl'))).length,1);assert.equal((await lines(path.join(adbState,'effects.jsonl'))).length,1);
  await finish();
  await until(async()=>{const view=(await stack.request(devicePath)).value;return view.action_availability?.['apps.launch']===false&&view.action_availability?.['remote.press']===true;},20000);
  await settled(await command('adapter-while-native-offline','remote.press'));
  assert.equal((await stack.request(base+'/commands',post({...requests.get('native-second'),expires_at:new Date(Date.now()+10000).toISOString()},'native-offline'))).value.error.code,'device_offline');
  await launch(true);const uncertain=await command('native-unknown');await settled(uncertain,'unknown');await finish();
  const preserved=JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));assert.equal(preserved.version,3);assert.equal(preserved.model_revision,validated.model_revision);assert.equal(preserved.entries[uncertain.command_id].result.status,'unknown');
  await stack.restartGateway();await launch();
  assert.equal((await stack.request(base+'/commands',post(requests.get('native-unknown'),'native-unknown'))).value.command_id,uncertain.command_id);
  const binding=(await stack.request(devicePath+'/execution-binding')).value;
  assert.equal((await stack.request(base+'/execution-operations',post({type:'bindings.revoke',device_id:'device-lamp',expected_binding_revision:binding.revision},'revoke'))).value.status,'applied');
  const old=await stack.request(base+'/execution-operations',post(change,'compose'));assert.equal(old.value.operation_id,approved.operation_id);assert.equal((await stack.request(devicePath+'/execution-binding')).value.state,'revoked');
  for(const action of ['apps.launch','remote.press'])assert.equal((await stack.request(base+'/commands',post({device_id:'device-lamp',model_revision:validated.model_revision,expires_at:new Date(Date.now()+10000).toISOString(),operation:{type:'action.invoke',path:action,value:action==='apps.launch'?{application_id:'com.example.player'}:{key:'home'}}},'revoked-'+action.replaceAll('.','-')))).value.error.code,'execution_binding_revoked');
  await finish();assert.equal((await lines(path.join(directory,'effects.jsonl'))).length,2);assert.equal((await lines(path.join(adbState,'effects.jsonl'))).length,2);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries[uncertain.command_id],preserved.entries[uncertain.command_id]);
  for(const proof of await lines(path.join(adbState,'durable.jsonl'))){assert.equal(proof.command.status,'dispatched');assert.deepEqual(proof.binding.native_paths,['apps.launch']);}
  const nativeProofs=await lines(path.join(directory,'gateway-durable.jsonl'));assert.equal(nativeProofs.length,2);
  await writeFile(path.join(directory,'tv-agent-composition-result.json'),JSON.stringify({passed:true,android_tv_agent_core:true,native_protocol_fixture:false,real_http:true,real_mtls:true,real_mqtt:true,real_sqlite:true,jvm_launches:launches,same_logical_device:true,logical_device_count:1,fake_adb:true,native_effects:2,adapter_effects:2,local_grant_refusal:true,path_specific_offline:true,journal_version:3,unknown_preserved_across_restart:true,revoked_both_paths:true,original_operation_does_not_reactivate:true,native_app_runtime:false,hardware:false,physical_same_device_proven:false,full_goal_completed:false},null,2)+'\n');
});
