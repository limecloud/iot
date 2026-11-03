import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { root,freePort,startStack,stop,until } from '../tools/dev-stack.mjs';
import { createAdbFixture } from './helpers/android-tv.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo',devicePath=base+'/devices/device-lamp';
const post=(body,key)=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
async function lines(file){try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}

test('同一逻辑设备组合：mTLS能力证明、唯一路径、网页撤销与重启不补发', {timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(root,'.dev/tv-composition-')),adbState=path.join(directory,'adb-state');await mkdir(adbState,{mode:0o700});
  const adb=await createAdbFixture(adbState);
  await writeFile(path.join(adbState,'scenario.json'),JSON.stringify({database:path.join(directory,'gateway.sqlite')}));
  const modelPath=path.join(root,'contracts/models/android-tv-remote.json');
  const validated=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',modelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:process.env.LIMEIOT_MODEL_VALIDATOR??path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);assert.equal(validated.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=validated.normalized_model;config.devices[0].model_revision=validated.model_revision;delete config.devices[0].routes;
  const configPath=path.join(directory,'config','gateway.json'),tvPath=path.join(directory,'tv.json');await mkdir(path.dirname(configPath));await writeFile(configPath,JSON.stringify(config));
  await writeFile(tvPath,JSON.stringify({schema_version:1,bindings:[{device_id:'device-lamp',adapter_id:'tv-adb',config:{schema_version:1,adb_path:adb,state_directory:adbState,server_port:5049,target:'192.168.31.94:5555',fingerprint:'Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys',device_serial:'sample-tv-001',applications:[{application_id:'com.example.player',category:'leanback'}],timeout_ms:3000}}]}));
  const provision='import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n';
  await exec('python3',['-c',provision,directory],{cwd:root,timeout:20000});
  const tlsPort=await freePort();
  const stack=await startStack({directory,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configPath,LIMEIOT_TV_CONFIG:tvPath},brokerTls:{port:tlsPort,ca:path.join(directory,'broker-tls/ca.crt'),certificate:path.join(directory,'broker-tls/server.crt'),key:path.join(directory,'broker-tls/server.key')}});t.after(()=>stack.close());await stop(stack.lamp);
  const credentials={port:tlsPort,ca:await readFile(path.join(directory,'credentials/ca.crt')),cert:await readFile(path.join(directory,'credentials/device.crt')),key:await readFile(path.join(directory,'credentials/private.key'))};
  let mqtt,boot,session,sequence,snapshot;t.after(()=>mqtt?.close());
  async function publish(kind,body){const envelope={v:1,kind,message_id:randomUUID(),device_id:'device-lamp',model_revision:validated.model_revision,boot_id:boot,seq:++sequence,body};if(session)envelope.session_id=session;assert.equal(await mqtt.publish('limeiot/v1/space-demo/device-lamp/up/'+kind,JSON.stringify(envelope)),0);}
  async function heartbeat(){await publish('state',{type:'snapshot',revision:++snapshot,properties:[]});}
  async function connect(){mqtt?.close();mqtt=await mqttProbe(credentials);await mqtt.subscribe('limeiot/v1/space-demo/device-lamp/down/+');boot=randomUUID();session=undefined;sequence=0;snapshot=0;await publish('hello',{challenge:randomUUID(),execution_paths:['apps.launch']});const welcome=JSON.parse((await mqtt.message()).payload);assert.equal(welcome.kind,'welcome');session=welcome.session_id;await heartbeat();await until(async()=>(await stack.request(devicePath)).value.session_id===session&&(await stack.request(devicePath)).value.ready);}
  await connect();
  const binding=(await stack.request(devicePath+'/execution-binding')).value,route=(await stack.request(base+'/execution-adapters')).value.items[0].route;
  const change={type:'bindings.compose',device_id:'device-lamp',route,native_paths:['apps.launch'],expected_native_session:session,expected_binding_revision:binding.revision,expected_model_revision:validated.model_revision};
  const rejected=await stack.request(base+'/execution-operations',post({...change,expected_native_session:'old-session'},'stale-session'));assert.equal(rejected.value.reason,'execution_native_proof_required');
  assert.deepEqual(await lines(path.join(adbState,'calls.jsonl')),[]);
  const input=path.join(directory,'compose.json');await writeFile(input,JSON.stringify(change));
  const cli=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','invoke','execution-changes.create','--space-id','space-demo','--idempotency-key','compose','--state-dir',path.join(directory,'cli-state'),'--input',input],{cwd:root,env:stack.env,timeout:6000})).stdout);assert.equal(cli.status,'applied');assert.equal(cli.result.state,'composed');
  await heartbeat();
  await until(async()=>{const view=(await stack.request(devicePath)).value;return view.action_availability?.['apps.launch']&&view.action_availability?.['remote.press'];});
  assert.equal((await stack.request(devicePath+'/applications')).value.error.code,'execution_offer_unavailable');
  async function command(key,action='remote.press'){const result=await stack.request(base+'/commands',post({device_id:'device-lamp',model_revision:validated.model_revision,expires_at:new Date(Date.now()+12000).toISOString(),operation:{type:'action.invoke',path:action,value:action==='apps.launch'?{application_id:'com.example.player'}:{key:'home'}}},key));assert.equal(result.status,202,JSON.stringify(result));return result.value;}
  async function confirmed(command){await until(async()=>(await stack.request(base+'/commands/'+command.command_id)).value.status==='confirmed');}
  async function nativeEffect(command){const down=JSON.parse((await mqtt.message()).payload);assert.equal(down.kind,'command');assert.equal(down.body.operation.path,'apps.launch');assert.equal(down.message_id,command.command_id);
    const query='import sys,json,sqlite3\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nv,b=c.execute("SELECT version,body FROM snapshot").fetchone()\ns=json.loads(b)\nprint(json.dumps({"version":v,"command":s["commands"][sys.argv[2]],"binding":s["execution_registry"]["bindings"]["device-lamp"]}))';
    const durable=JSON.parse((await exec('python3',['-c',query,stack.env.LIMEIOT_DB,command.command_id],{timeout:5000})).stdout);
    assert.equal(durable.version,10);assert.equal(durable.command.status,'dispatched');assert.equal(durable.command.execution_route,undefined);assert.deepEqual(durable.binding.native_paths,['apps.launch']);
    await appendFile(path.join(directory,'native-effects.jsonl'),JSON.stringify({command_id:command.command_id,durable_before_effect:true})+'\n');return down;}
  const remote=await command('remote-first'),native=await command('native-second','apps.launch');const down=await nativeEffect(native);await confirmed(remote);
  await publish('result',{command_id:native.command_id,status:'confirmed',evidence:{type:'action_result',path:'apps.launch',input_digest:await documentDigest(down.body.operation.value),output:{},completion:'submitted',observed_at:new Date().toISOString()}});await confirmed(native);
  await assert.rejects(mqtt.message(200),/mqtt_packet_timeout/);
  assert.equal((await lines(path.join(adbState,'effects.jsonl'))).length,1);
  await publish('availability',{online:false});mqtt.close();
  await until(async()=>{const view=(await stack.request(devicePath)).value;return view.action_availability?.['apps.launch']===false&&view.action_availability?.['remote.press']===true;});
  await confirmed(await command('adapter-while-native-offline'));
  await connect();
  const unknown=await command('native-with-lost-result','apps.launch');await nativeEffect(unknown);await stack.restartGateway();
  assert.equal((await stack.request(base+'/commands/'+unknown.command_id)).value.status,'unknown');
  await connect();await assert.rejects(mqtt.message(200),/mqtt_packet_timeout/);
  const browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});page.setDefaultTimeout(12000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT);await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
  const tv=page.getByRole('article',{name:'电视',exact:true});await tv.getByText('电视接入与应用',{exact:true}).click();await tv.getByRole('button',{name:'读取接入信息',exact:true}).click();await expect(tv.getByText('接入状态：已组合接入',{exact:true})).toBeVisible();
  await expect(tv.getByRole('button',{name:'读取应用列表',exact:true})).toHaveCount(0);
  await tv.getByRole('button',{name:'撤销电视接入',exact:true}).click();await expect(tv.getByText('接入状态：已撤销',{exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(directory,'composition-mobile.png'),fullPage:true});
  const old=await stack.request(base+'/execution-operations',post(change,'compose'));assert.equal(old.value.operation_id,cli.operation_id);assert.equal((await stack.request(devicePath+'/execution-binding')).value.state,'revoked');
  await stack.restartGateway();assert.equal((await stack.request(devicePath+'/execution-binding')).value.state,'revoked');
  assert.equal((await lines(path.join(adbState,'effects.jsonl'))).length,2);assert.equal((await lines(path.join(directory,'native-effects.jsonl'))).length,2);
  for(const proof of await lines(path.join(adbState,'durable.jsonl'))){assert.equal(proof.version,10);assert.equal(proof.command.request.operation.path,'remote.press');assert.equal(proof.command.status,'dispatched');assert.deepEqual(proof.binding.native_paths,['apps.launch']);}
  await writeFile(path.join(directory,'tv-composition-result.json'),JSON.stringify({passed:true,logical_device_count:1,real_http:true,real_mtls:true,real_mqtt:true,real_sqlite:true,browser:true,explicit_native_session_proof:true,native_protocol_fixture:true,fake_adb:true,exclusive_paths:true,path_specific_offline:true,durable_before_effect:true,original_operation_does_not_reactivate:true,restart_unknown_not_replayed:true,revocation_survives_restart:true,native_effects:2,adapter_effects:2,snapshot_version:8,android_tv_agent:false,native_app_runtime:false,same_device_adb_coexistence:false,hardware:false,full_goal_completed:false},null,2)+'\n');
});
