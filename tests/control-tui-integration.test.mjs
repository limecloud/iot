import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root,startStack,until } from '../tools/dev-stack.mjs';
import { origin,post,fixture,cloudClient } from './helpers/control.mjs';
import { ControlTerminal } from '../packages/cli/src/control-tui.mjs';
import { executeControl } from '../packages/cli/src/control.mjs';

const exec=promisify(execFile),base='/api/v1/spaces/space-demo';
test('云终端真实Go/MySQL/TLS/WSS/MQTT：明确配对、单条命令、丢回执及重开原查询',{timeout:150000,skip:!process.env.LIMEIOT_TEST_CONTROL_CA_FILE},async()=>{
  const directory=path.join(root,'.dev','control-tui-journey-'+randomBytes(8).toString('hex'));await mkdir(directory,{mode:0o700});
  const key=path.join(directory,'identity.pk8');await exec(path.join(root,'target/debug/limeiot-gateway'),['identity-init',key]);
  const stack=await startStack({directory,gatewayEnv:{LIMEIOT_CONTROL_ALLOWED_ORIGINS:origin,LIMEIOT_GATEWAY_KEY_FILE:key,LIMEIOT_CONTROL_CA_FILE:process.env.LIMEIOT_TEST_CONTROL_CA_FILE,LIMEIOT_CONTROL_RELAY_ENABLED:'1'}});
  const sessionFile=path.join(directory,'session.json');
  const login=await executeControl(['auth','login','--endpoint',origin,'--token-file',process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,'--session-file',sessionFile]);assert.equal(login.exit_code,0);
  let terminal=new ControlTerminal({sessionFile});
  const invoke=async packet=>{const result=await terminal.handle(packet);assert.equal(result.exit_code,0,JSON.stringify(result));return result.value;};
  const commit=review=>({op:'commit',task_id:review.review.task_id,review_digest:review.review_digest});
  const prepare=async(operation_id,input,fields={})=>invoke({op:'prepare',operation_id,...fields,...(input===undefined?{}:{input})});
  try {
    const space=await invoke(commit(await prepare('spaces.create',{request_key:'tui-family',name:'终端家庭'})));
    const pairFile=path.join(directory,'pairing.json');
    await invoke(commit(await prepare('pairings.create',{request_key:'tui-pairing',scopes:['devices.read','commands.write']},{space_id:space.space_id,output_file:pairFile})));
    const pair=JSON.parse(await readFile(pairFile,'utf8'));
    const local=(await stack.request(base+'/control-pairings',post({control_origin:pair.control_origin,pairing_id:pair.pairing.pairing_id,code:pair.code},'tui-pairing-approve'))).value;
    const review=await until(async()=>{const value=(await stack.request(base+'/control-pairings/'+local.link_id)).value;return value.status==='awaiting_approval'&&value;});
    await stack.request(base+'/control-pairings/'+local.link_id+'/approve',post({review_revision:review.review_revision}));
    const binding=(await until(async()=>{const value=(await stack.request(base+'/control-pairings/'+local.link_id)).value;return value.status==='active'&&value;})).binding;
    const cloud=await cloudClient();await until(async()=>(await cloud.connection(binding)).connected);
    const devices=await invoke({op:'read',operation_id:'devices.list',space_id:space.space_id});const lamp=devices.items.find(item=>item.device_id==='device-lamp');assert.ok(lamp);
    await invoke({op:'read',operation_id:'models.get',space_id:space.space_id,id:lamp.model_revision});
    const input={request_key:'tui-device-original',gateway_id:binding.gateway_id,binding_revision:binding.revision,device_id:lamp.device_id,model_revision:lamp.model_revision,expires_at:new Date(Date.now()+25000).toISOString(),operation:{type:'property.set',path:'light.power',value:true}};
    const before=(await fixture()).remote_posts;const task=await prepare('commands.create',input,{space_id:space.space_id});assert.equal((await fixture()).remote_posts,before);
    await fixture({drop_remote_responses:true});const lost=await terminal.handle(commit(task));assert.equal(lost.exit_code,6);assert.equal((await fixture()).remote_posts,before+1);
    assert.deepEqual(JSON.parse(await readFile(lost.original.record_file,'utf8')).input,input);
    await fixture({restart_api:true});await until(async()=>(await cloud.connection(binding)).connected);
    terminal=new ControlTerminal({sessionFile});let restored=await invoke(commit(await prepare('commands.create',input,{space_id:space.space_id})));
    assert.equal((await fixture()).remote_posts,before+1);
    for(let index=0;index<10&&restored.status!=='confirmed';index++)restored=await invoke(commit(await prepare('commands.reconcile',undefined,{space_id:space.space_id,id:restored.remote_id})));
    assert.equal(restored.status,'confirmed');assert.equal(restored.local_result.evidence.type,'device_result');
    assert.equal((await invoke({op:'read',operation_id:'commands.resolve',space_id:space.space_id,id:input.request_key})).remote_id,restored.remote_id);
    assert.equal((await stack.request(base+'/commands')).value.items.length,1);assert.equal((await fixture()).remote_posts,before+1);
    await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,real_mysql:true,real_go:true,real_tls:true,real_wss:true,real_mqtt:true,simulated_device:true,hardware:false,remote_commands:1,explicit_commit:true,lost_response_recovered:true,process_restart_query_only:true}));
  } finally {await fixture({});await stack.close();}
});
