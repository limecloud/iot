import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,readFile,writeFile,stat,symlink,readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root,startStack,until } from '../tools/dev-stack.mjs';
import { cloudClient,fixture,origin,post } from './helpers/control.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo';

test('远程CLI与Agent工具：独立会话、耐久原请求、真实TLS/WSS/MQTT及响应丢失不补发',{timeout:150000,skip:!process.env.LIMEIOT_TEST_CONTROL_CA_FILE},async()=>{
  const directory=path.join(root,'.dev',`control-cli-${randomBytes(8).toString('hex')}`);await mkdir(directory,{mode:0o700});
  const key=path.join(directory,'identity.pk8');await exec(path.join(root,'target/debug/limeiot-gateway'),['identity-init',key]);
  const s=await startStack({directory,gatewayEnv:{LIMEIOT_CONTROL_ALLOWED_ORIGINS:origin,LIMEIOT_GATEWAY_KEY_FILE:key,LIMEIOT_CONTROL_CA_FILE:process.env.LIMEIOT_TEST_CONTROL_CA_FILE,LIMEIOT_CONTROL_RELAY_ENABLED:'1'}});
  const session=path.join(directory,'session.json'),inputFile=path.join(directory,'input.json');
  const env={...process.env,LIMEIOT_TOKEN:'must-not-use-local-token',LIMEIOT_ENDPOINT:'http://untrusted.invalid'};
  async function cli(args,code=0){let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs','control','--session-file',session,...args],{cwd:root,env,timeout:20000})}catch(e){result=e}assert.ok((Array.isArray(code)?code:[code]).includes(result.code??0),result.stderr);return result}
  async function invoke(args,code=0){return JSON.parse((await cli(args,code)).stdout)}
  async function input(value){await writeFile(inputFile,JSON.stringify(value));return ['--input',inputFile]}
  const cloud=await cloudClient();
  try{
    const catalog=await invoke(['schema']);assert.equal(catalog.mode,'control_plane');assert.ok(!catalog.operations.some(v=>v.operation_id.startsWith('admin.')));
    const login=await invoke(['auth','login','--endpoint',origin,'--token-file',process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE]);assert.equal(login.authenticated,true);assert.ok(!('session'in login));assert.equal((await stat(session)).mode&0o777,0o600);
    await cli(['spaces','list','--endpoint','https://wrong.invalid'],2);
    const spaceInput={request_key:'cli-space',name:'CLI家庭'};
    const space=await invoke(['spaces','create',...await input(spaceInput)]);assert.equal((await invoke(['spaces','create',...await input(spaceInput)])).space_id,space.space_id);
    const pairFile=path.join(directory,'pairing.json');
    const pairOutput=await invoke(['pairings','create','--space-id',space.space_id,'--output',pairFile,...await input({request_key:'cli-pair',scopes:['devices.read','commands.write']})]);
    const pair=JSON.parse(await readFile(pairFile,'utf8'));assert.ok(pair.code);assert.ok(!JSON.stringify(pairOutput).includes(pair.code));
    const local=(await s.request(`${base}/control-pairings`,post({control_origin:pair.control_origin,pairing_id:pair.pairing.pairing_id,code:pair.code},'cli-local-pair'))).value;
    const review=await until(async()=>{const v=(await s.request(`${base}/control-pairings/${local.link_id}`)).value;return v.status==='awaiting_approval'&&v});
    await s.request(`${base}/control-pairings/${local.link_id}/approve`,post({review_revision:review.review_revision}));
    const binding=(await until(async()=>{const v=(await s.request(`${base}/control-pairings/${local.link_id}`)).value;return v.status==='active'&&v})).binding;
    await until(async()=>(await cloud.connection(binding)).connected);
    const lamp=(await invoke(['devices','list','--space-id',space.space_id])).items.find(d=>d.device_id==='device-lamp');assert.ok(lamp);
    assert.equal((await invoke(['models','get',lamp.model_revision,'--space-id',space.space_id])).revision,lamp.model_revision);
    const command={request_key:'cli-original',gateway_id:binding.gateway_id,binding_revision:binding.revision,device_id:lamp.device_id,model_revision:lamp.model_revision,expires_at:new Date(Date.now()+25000).toISOString(),operation:{type:'property.set',path:'light.power',value:true}};
    // 先让原记录落盘失败，确认没有远程提交。
    const isolated=path.join(directory,'unwritable');await mkdir(isolated,{mode:0o700});const badSession=path.join(isolated,'session.json');await writeFile(badSession,await readFile(session),{mode:0o600});await writeFile(path.join(isolated,'operations'),'occupied');
    const before=(await fixture()).remote_posts;
    const failed=await cli(['commands','create','--space-id',space.space_id,...await input(command),'--session-file',badSession],5);assert.equal(JSON.parse(failed.stderr).error.code,'original_record_unavailable');assert.equal((await fixture()).remote_posts,before);
    await fixture({drop_remote_responses:true});const lost=await cli(['commands','create','--space-id',space.space_id,...await input(command)],6);assert.equal(JSON.parse(lost.stderr).error.code,'operation_unknown');const record=JSON.parse(lost.stderr).original.record_file;
    assert.deepEqual(JSON.parse(await readFile(record,'utf8')).input,command);assert.equal((await stat(record)).mode&0o777,0o600);
    await fixture({restart_api:true});await until(async()=>(await cloud.connection(binding)).connected);
    const recovered=await invoke(['commands','create','--space-id',space.space_id,...await input(command)]);assert.equal((await fixture()).remote_posts,before+1);
    let result=recovered;for(let i=0;i<10&&result.status!=='confirmed';i++)result=await invoke(['commands','reconcile',recovered.remote_id,'--space-id',space.space_id],[0,6]);
    assert.equal(result.status,'confirmed');assert.equal(result.local_result.evidence.type,'device_result');
    assert.equal((await invoke(['commands','resolve',command.request_key,'--space-id',space.space_id])).remote_id,result.remote_id);
    await cli(['commands','create','--space-id',space.space_id,...await input({...command,operation:{...command.operation,value:false}})],4);assert.equal((await fixture()).remote_posts,before+1);
    const commands=(await s.request(`${base}/commands`)).value.items;assert.equal(commands.length,1);
    const raw=JSON.parse(await readFile(session,'utf8'));const linked=path.join(directory,'linked.json');await symlink(session,linked);await cli(['auth','status','--session-file',linked],5);
    const records=await readdir(path.join(directory,'operations'));for(const file of records){const text=await readFile(path.join(directory,'operations',file),'utf8');assert.ok(!text.includes(raw.session)&&!text.includes(pair.code))}
    await invoke(['auth','logout']);assert.deepEqual(JSON.parse(await readFile(session,'utf8')),{logged_out:true});
    await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,real_mysql:true,real_wss:true,simulated_device:true,hardware:false,remote_commands:1,response_lost_recovered:true,no_secret_stdout:true}));
  }finally{await fixture({});await s.close()}
});
