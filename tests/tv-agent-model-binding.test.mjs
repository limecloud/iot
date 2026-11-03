import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { root,freePort,startStack,stop,until } from '../tools/dev-stack.mjs';
import { tvAgentRuntime } from './helpers/tv-agent.mjs';
import { verifyModelBundles,verifyModelOperation } from '../packages/protocol/model-registry.mjs';

const exec=promisify(execFile),base='/api/v1/spaces/space-demo';
test('已有TV Agent跨内置模型：明确CLI换绑、完整confirmed/unknown日志迁移及网关/JVM重启不重放', {timeout:180000},async t=>{
  const runtime=await tvAgentRuntime(),directory=await mkdtemp(path.join(root,'.dev/tv-agent-model-binding-'));
  const appModelPath=path.join(root,'contracts/models/android-tv-agent.json');
  const validated=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',appModelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);assert.equal(validated.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=validated.normalized_model;config.devices[0].model_revision=validated.model_revision;
  await mkdir(path.join(directory,'config'));
  const configFile=path.join(directory,'config/gateway.json'),configBytes=JSON.stringify(config);await writeFile(configFile,configBytes);
  await exec('python3',['-c','import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n',directory],{cwd:root,timeout:20000});
  const tlsPort=await freePort(),broker='ssl://127.0.0.1:'+tlsPort;
  const stack=await startStack({directory,modelPaths:{lamp:appModelPath},gatewayEnv:{LIMEIOT_CONFIG:configFile},brokerTls:{port:tlsPort,ca:path.join(directory,'broker-tls/ca.crt'),certificate:path.join(directory,'broker-tls/server.crt'),key:path.join(directory,'broker-tls/server.key')}});t.after(()=>stack.close());await stop(stack.lamp);
  // 只在本测试Broker中阻断退休确认，保留真实已确认/未知日志供迁移；命令和结果仍正常传递。
  const aclFile=path.join(directory,'acl');await writeFile(aclFile,(await readFile(aclFile,'utf8')).replace('topic read limeiot/v1/space-demo/device-lamp/down/+','topic read limeiot/v1/space-demo/device-lamp/down/welcome\ntopic read limeiot/v1/space-demo/device-lamp/down/command'));assert.equal(stack.broker.kill('SIGHUP'),true);
  const enrollment=path.join(directory,'credentials/enrollment.json');
  async function packageMaterial(output,profile){await exec('python3',['tools/tv-agent-enrollment.py','--identity-directory',path.join(directory,'credentials'),'--broker',broker,'--model-profile',profile,'--output',output],{cwd:root,timeout:15000});}
  await packageMaterial(enrollment,'android-tv-agent');
  const env={...process.env,LIMEIOT_TV_AGENT_JOURNEY:'1',LIMEIOT_TV_AGENT_DIRECTORY:directory,LIMEIOT_TV_AGENT_BROKER:broker,LIMEIOT_TV_AGENT_PROFILE:'android-tv-agent'};
  let worker,done,sequence=0;
  t.after(async()=>{if(worker)await stop(worker);});
  const launch=()=>{
    worker=spawn(runtime.executable,runtime.args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
    const stream=createWriteStream(path.join(directory,`jvm-${++sequence}.log`));worker.stdout.pipe(stream);worker.stderr.pipe(stream);worker.once('exit',()=>stream.end());
    done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>resolve(code));});done.catch(()=>{});
  };
  async function finish(){await writeFile(path.join(directory,'stop'),'stop');assert.equal(await done,0);await rename(path.join(directory,'stop'),path.join(directory,`stop-${sequence}`));}
  const journal=async()=>JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));
  const effects=async()=>{try{return (await readFile(path.join(directory,'effects.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const device=async()=>(await stack.request(base+'/devices/device-lamp')).value;
  const ready=async(previousBoot,revision)=>until(async()=>{const d=await device();return d.ready&&d.boot_id!==previousBoot&&d.model_revision===revision&&d;},30000);
  async function command(key,revision,path='apps.launch'){
    return stack.request(base+'/commands',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({device_id:'device-lamp',model_revision:revision,expires_at:new Date(Date.now()+15000).toISOString(),operation:{type:'action.invoke',path,value:path==='apps.launch'?{application_id:'com.example.player'}:{key:'home'}}})});
  }
  const beforeBoot=(await device()).boot_id;launch();let current=await ready(beforeBoot,validated.model_revision);
  const first=await command('before-confirmed',validated.model_revision);assert.equal(first.status,202);
  await until(async()=>(await stack.request(base+'/commands/'+first.value.command_id)).value.status==='confirmed');
  await until(async()=>(await journal()).entries[first.value.command_id]?.result?.status==='confirmed');await finish();
  env.LIMEIOT_TV_AGENT_EFFECT_UNKNOWN='1';launch();current=await ready(current.boot_id,validated.model_revision);
  const second=await command('before-unknown',validated.model_revision);assert.equal(second.status,202);
  await until(async()=>(await stack.request(base+'/commands/'+second.value.command_id)).value.status==='unknown');
  await until(async()=>(await journal()).entries[second.value.command_id]?.result?.status==='unknown');await finish();
  const originalJournal=await journal();assert.equal(originalJournal.version,2);assert.equal(originalJournal.high_watermark,2);assert.equal(Object.keys(originalJournal.entries).length,2);assert.equal((await effects()).length,2);
  const audit=async()=>JSON.parse((await exec('python3',['-c',"import sys,json,sqlite3\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nv,h,b=c.execute('SELECT version,config_hash,body FROM snapshot').fetchone()\nprint(json.dumps({'version':v,'config_hash':h,'body':json.loads(b)}))",stack.env.LIMEIOT_DB],{timeout:5000})).stdout);
  const before=await audit();assert.equal(before.version,10);
  const page=await verifyModelBundles((await stack.request(base+'/model-bundles')).value),bundle=page.items.find(v=>v.model.model_id==='urn:limeiot:model:android-tv-remote:1');assert.ok(bundle);
  assert.equal((await fetch(stack.env.LIMEIOT_ENDPOINT+base+'/model-bundles')).status,401);
  assert.equal((await stack.request('/api/v1/spaces/other/model-bundles')).status,403);
  assert.equal((await stack.request(base+'/model-bundles/bundle-'+'0'.repeat(64))).status,404);
  const state=path.join(directory,'cli-state'),input=path.join(directory,'bind.json');
  const change={type:'devices.bind-bundle',device_id:'device-lamp',bundle_id:bundle.bundle_id,expected_model_revision:validated.model_revision,expected_binding_revision:null};await writeFile(input,JSON.stringify(change));
  async function cli(args){return JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs',...args,'--space-id','space-demo','--state-dir',state],{cwd:root,env:stack.env,timeout:16000})).stdout);}
  assert.equal((await cli(['model-bundles','get',bundle.bundle_id])).model_revision,bundle.model_revision);
  const changed=await cli(['model-changes','create','--input',input,'--idempotency-key','switch-model']);
  const {cli:cliRecord,...original}=changed;assert.ok(cliRecord.record_file);await verifyModelOperation(original,{space_id:'space-demo',idempotency_key:'switch-model',change});assert.equal(original.status,'applied');
  assert.equal((await device()).ready,false);assert.equal((await audit()).config_hash,before.config_hash);assert.equal(await readFile(configFile,'utf8'),configBytes);
  const nextEnrollment=path.join(directory,'credentials/remote-enrollment.json');await packageMaterial(nextEnrollment,'android-tv-remote');await rename(enrollment,path.join(directory,'credentials/previous-enrollment.json'));await rename(nextEnrollment,enrollment);
  env.LIMEIOT_TV_AGENT_PROFILE='android-tv-remote';env.LIMEIOT_TV_AGENT_EFFECT_UNKNOWN='0';launch();current=await ready(current.boot_id,bundle.model_revision);
  const migrated=await journal();assert.equal(migrated.version,3);assert.equal(migrated.high_watermark,2);assert.deepEqual(migrated.entries,originalJournal.entries);assert.equal((await effects()).length,2);
  assert.equal(current.action_availability['apps.launch'],true);assert.equal(current.action_availability['remote.press'],false);
  const denied=await command('uncomposed-remote',bundle.model_revision,'remote.press');assert.equal(denied.value.error.code,'execution_capability_unavailable');assert.equal((await effects()).length,2);
  const third=await command('after-confirmed',bundle.model_revision);assert.equal(third.status,202);await until(async()=>(await stack.request(base+'/commands/'+third.value.command_id)).value.status==='confirmed');
  await until(async()=>(await journal()).high_watermark===3);await finish();
  const migratedBeforeRestart=await journal();assert.deepEqual(migratedBeforeRestart.entries[first.value.command_id],originalJournal.entries[first.value.command_id]);assert.deepEqual(migratedBeforeRestart.entries[second.value.command_id],originalJournal.entries[second.value.command_id]);
  await stack.restartGateway();launch();await ready(current.boot_id,bundle.model_revision);
  assert.deepEqual((await journal()).entries,migratedBeforeRestart.entries);assert.equal((await effects()).length,3);
  const reread=await cli(['model-changes','resolve','switch-model']);assert.deepEqual(reread,original);
  assert.equal((await stack.request(base+'/commands/'+second.value.command_id)).value.status,'unknown');await finish();
  const saved=await audit();assert.equal(saved.version,10);assert.equal(saved.config_hash,before.config_hash);assert.equal(saved.body.model_registry.bindings['device-lamp'].bundle_id,bundle.bundle_id);
  assert.deepEqual(saved.body.commands[first.value.command_id].envelope,before.body.commands[first.value.command_id].envelope);assert.deepEqual(saved.body.commands[second.value.command_id].envelope,before.body.commands[second.value.command_id].envelope);
  const actual=await effects();assert.equal(actual.length,3);assert.equal(new Set(actual.map(v=>v.command_id)).size,3);assert.ok(actual.every(v=>v.attempt_durable));
  await writeFile(path.join(directory,'model-binding-result.json'),JSON.stringify({passed:true,existing_gateway_device:true,real_http:true,real_mtls:true,real_mqtt:true,real_sqlite:true,jvm_processes:sequence,config_hash_unchanged:true,confirmed_and_unknown_preserved:true,complete_old_envelopes_preserved:true,command_sequence_preserved:true,explicit_cli_bundle_binding:true,original_operation_readonly:true,uncomposed_remote_unavailable:true,restart_no_replay:true,application_effects:actual.length,snapshot_version:saved.version,withheld_receipt_delivery:true,simulated_application_port:true,native_app_runtime:false,same_device_adb_coexistence:false,hardware:false,full_goal_completed:false},null,2)+'\n');
});
