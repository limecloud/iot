import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,mkdtemp,readFile,writeFile,rename,stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { root,freePort,startStack,stop,until } from '../tools/dev-stack.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { tvAgentRuntime } from './helpers/tv-agent.mjs';
const exec=promisify(execFile);
const base='/api/v1/spaces/space-demo';

test('TV Agent设备核心：mTLS、超过128条回收、旧快照/网关重启核对与旧命令不重放', {timeout:240000}, async t=>{
  const runtime=await tvAgentRuntime();
  const directory=await mkdtemp(path.join(root,'.dev/tv-agent-'));await mkdir(path.join(directory,'config'));
  const modelPath=path.join(root,'contracts/models/android-tv-agent.json');
  const validation=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',modelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:process.env.LIMEIOT_MODEL_VALIDATOR??path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);
  assert.equal(validation.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=validation.normalized_model;config.devices[0].model_revision=validation.model_revision;
  const configFile=path.join(directory,'config/gateway.json');await writeFile(configFile,JSON.stringify(config));
  const provision='import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n';
  await exec('python3',['-c',provision,directory],{cwd:root,timeout:20000});
  const tlsPort=await freePort();
  const stack=await startStack({directory,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configFile},brokerTls:{port:tlsPort,ca:path.join(directory,'broker-tls/ca.crt'),certificate:path.join(directory,'broker-tls/server.crt'),key:path.join(directory,'broker-tls/server.key')}});t.after(()=>stack.close());await stop(stack.lamp);
  const broker='ssl://127.0.0.1:'+tlsPort;
  const enrollmentFile=path.join(directory,'credentials/enrollment.json');
  const packageArgs=['tools/tv-agent-enrollment.py','--identity-directory',path.join(directory,'credentials'),'--broker',broker,'--output',enrollmentFile];
  const packaging=JSON.parse((await exec('python3',packageArgs,{cwd:root,timeout:15000})).stdout);
  assert.equal(packaging.status,'ok');assert.equal(packaging.device_id,'device-lamp');
  assert.equal((await stat(enrollmentFile)).mode&0o777,0o600);
  const enrollmentBytes=await readFile(enrollmentFile);assert.ok(!JSON.stringify(packaging).includes('PRIVATE KEY'));
  await assert.rejects(exec('python3',packageArgs,{cwd:root,timeout:15000}));
  assert.deepEqual(await readFile(enrollmentFile),enrollmentBytes,'never replace existing secret material');
  for (const invalidBroker of ['tcp://127.0.0.1:1883','ssl://@127.0.0.1:8883','ssl://127.0.0.1:8883?','ssl://127.0.0.1:8883/','ssl://127.0.0.1:65536']) {
    await assert.rejects(exec('python3',['tools/tv-agent-enrollment.py','--identity-directory',path.join(directory,'credentials'),'--broker',invalidBroker,'--output',path.join(directory,'credentials/rejected.json')],{cwd:root,timeout:15000}));
    await assert.rejects(stat(path.join(directory,'credentials/rejected.json')));
  }
  const tlsCredentials={ca:await readFile(path.join(directory,'credentials/ca.crt')),cert:await readFile(path.join(directory,'credentials/device.crt')),key:await readFile(path.join(directory,'credentials/private.key'))};
  const allowed=await mqttProbe({port:tlsPort,...tlsCredentials});allowed.close();
  await assert.rejects(mqttProbe({port:tlsPort,ca:tlsCredentials.ca}));
  const workerEnv={...process.env,LIMEIOT_TV_AGENT_JOURNEY:'1',LIMEIOT_TV_AGENT_DIRECTORY:directory,LIMEIOT_TV_AGENT_BROKER:broker,LIMEIOT_TV_AGENT_PROBE_HOSTNAME:'1'};
  let worker;
  const launch=()=>{
    worker=spawn(runtime.executable,runtime.args,{cwd:root,env:workerEnv,stdio:['ignore','pipe','pipe']});
    const stream=createWriteStream(path.join(directory,'jvm.log'),{flags:'a'});worker.stdout.pipe(stream);worker.stderr.pipe(stream);worker.once('exit',()=>stream.end());
    const done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>resolve(code));});
    done.catch(()=>{});return done;
  };
  t.after(async()=>{if(worker)await stop(worker);});
  async function ready(previousBoot){await until(async()=>{const d=(await stack.request(base+'/devices/device-lamp')).value;return d.ready&&d.boot_id!==previousBoot&&d.boot_id;},90000);}
  async function command(key,app='com.example.player'){
    const result=await stack.request(base+'/commands',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({device_id:'device-lamp',model_revision:validation.model_revision,expires_at:new Date(Date.now()+12000).toISOString(),operation:{type:'action.invoke',path:'apps.launch',value:{application_id:app}}})});
    assert.equal(result.status,202);return result.value;
  }
  const oldBoot=(await stack.request(base+'/devices/device-lamp')).value.boot_id;
  let done=launch();await ready(oldBoot);
  const first=await command('agent-first');await until(async()=>(await stack.request(base+'/commands/'+first.command_id)).value.status==='confirmed');
  await until(async()=>Object.keys(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries).length===0);
  let journal=JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));assert.equal(journal.model_revision,validation.model_revision);assert.equal(journal.version,2);assert.equal(journal.high_watermark,1);
  const effects=()=>readFile(path.join(directory,'effects.jsonl'),'utf8').then(raw=>raw.trim().split('\n').map(JSON.parse));
  assert.equal((await effects()).length,1);assert.equal((await effects())[0].attempt_durable,true);
  const denied=await command('agent-denied','com.android.settings');await until(async()=>(await stack.request(base+'/commands/'+denied.command_id)).value.status==='failed');assert.equal((await effects()).length,1);
  for(let index=0;index<130;index++) {
    const accepted=await command('agent-capacity-'+index);
    await until(async()=>(await stack.request(base+'/commands/'+accepted.command_id)).value.status==='confirmed');
  }
  await until(async()=>Object.keys(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries).length===0);
  assert.equal((await effects()).length,131);
  const firstBoot=(await stack.request(base+'/devices/device-lamp')).value.boot_id;
  await writeFile(path.join(directory,'stop'),'stop');assert.equal(await done,0);
  await rename(path.join(directory,'stop'),path.join(directory,'first-stop'));
  // 恢复设备旧快照并重启原网关，只核对原结果，不补发应用启动。
  const unacknowledged=await readFile(path.join(directory,'unacknowledged.json'));
  const original=Object.values(JSON.parse(unacknowledged).entries)[0].command;
  await writeFile(path.join(directory,'journal.json'),unacknowledged);
  await stack.restartGateway();
  workerEnv.LIMEIOT_TV_AGENT_PROBE_HOSTNAME='0';done=launch();await ready(firstBoot);assert.equal((await effects()).length,131);
  await until(async()=>Object.keys(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries).length===0);
  assert.equal(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).high_watermark,132);
  const current=(await stack.request(base+'/devices/device-lamp')).value;
  const publisher=await mqttProbe({port:Number(stack.env.LIMEIOT_MQTT_PORT),username:'gateway',password:stack.env.LIMEIOT_MQTT_PASSWORD});
  try {
    assert.equal(await publisher.publish('limeiot/v1/space-demo/device-lamp/down/command',JSON.stringify({...original,session_id:current.session_id,body:{...original.body,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+10000).toISOString()}})),0);
  } finally {publisher.close();}
  const second=await command('agent-second');await until(async()=>(await stack.request(base+'/commands/'+second.command_id)).value.status==='confirmed');
  assert.equal((await effects()).length,132);
  await until(async()=>Object.keys(JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8')).entries).length===0);
  await writeFile(path.join(directory,'stop'),'stop');assert.equal(await done,0);
  journal=JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));assert.equal(Object.keys(journal.entries).length,0);assert.equal(journal.high_watermark,133);
  assert.deepEqual((await stack.request(base+'/devices/device-lamp')).value.reported,{});
  await writeFile(path.join(directory,'tv-agent-result.json'),JSON.stringify({passed:true,device_core:true,exact_model:true,real_mqtt:true,real_mtls:true,client_certificate_required:true,wrong_hostname_rejected_by_device_transport:true,real_http:true,real_sqlite:true,jvm_process_restart:true,durable_before_effect:true,grant_refusal_zero_effects:true,application_effects:132,receipt_reclamation_beyond_128:true,original_result_reconciled_after_gateway_and_device_restart:true,old_device_snapshot_boundary_restored:true,retired_command_repack_zero_effects:true,journal_high_watermark:133,journal_retained_entries:0,simulated_application_port:true,android_app:false,hardware:false,same_device_adb_coexistence:false,full_goal_completed:false},null,2)+'\n');
});
