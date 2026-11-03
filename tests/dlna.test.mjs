import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { root,startStack,stop,until } from '../tools/dev-stack.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { verifyExecutionAdapters } from '../packages/protocol/execution-bindings.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { rendererFixture } from './helpers/dlna.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo',devicePath=base+'/devices/device-lamp';
const post=(input,key)=>({method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(input)});

test('DLNA已有空间软件闭环：明确绑定、网页/CLI/自动化、先落盘、丢回执及重启不重播', {timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(root,'.dev/dlna-journey-'));
  const fixture=await rendererFixture(path.join(directory,'gateway.sqlite'));t.after(()=>fixture.close());
  const modelPath=path.join(root,'contracts/models/dlna-speaker.json');
  const model=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',modelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);assert.equal(model.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=model.normalized_model;config.devices[0].model_revision=model.model_revision;delete config.devices[0].routes;
  const configPath=path.join(directory,'config.json'),audioPath=path.join(directory,'audio.json');
  await writeFile(configPath,JSON.stringify(config));
  const writeConfig=()=>writeFile(audioPath,JSON.stringify({schema_version:1,bindings:[{device_id:'device-lamp',adapter_id:'speaker-dlna',config:fixture.config}]}));await writeConfig();
  const stack=await startStack({directory,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configPath,LIMEIOT_AUDIO_CONFIG:audioPath}});t.after(()=>stack.close());await stop(stack.lamp);
  const mqtt=await mqttProbe({port:Number(stack.env.LIMEIOT_MQTT_PORT),username:'device-lamp',password:stack.env.LIMEIOT_MQTT_PASSWORD});t.after(()=>mqtt.close());await mqtt.subscribe('limeiot/v1/space-demo/device-lamp/down/+');
  assert.equal(fixture.descriptions.length,0);assert.equal(fixture.effects.length,0);
  const env={...stack.env};delete env.LIMEIOT_TOKEN_FILE;
  const cli=async(operation,args=[],expectedExit=0)=>{
    let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs','invoke',operation,'--space-id','space-demo',...args],{cwd:root,env,timeout:10000});}catch(error){result=error;}
    assert.equal(result.code??0,expectedExit,result.stderr);return JSON.parse(result.stdout);
  };
  const offers=await cli('execution-adapters.list');verifyExecutionAdapters(offers);assert.equal(offers.items.length,1);assert.equal(offers.items[0].kind,'dlna');assert.equal(offers.items[0].route.revision,await documentDigest(fixture.config));assert.equal(JSON.stringify(offers).includes(fixture.config.media[0].url),false);
  const browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});page.setDefaultTimeout(12000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT);await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
  const speaker=page.getByRole('article',{name:'音箱',exact:true});await speaker.getByRole('button',{name:'读取接入信息',exact:true}).click();await expect(speaker.getByText('接入状态：尚未绑定适配器',{exact:true})).toBeVisible();
  await expect(speaker.getByRole('button',{name:'播放音频',exact:true})).toBeDisabled();assert.equal(fixture.descriptions.length,0);
  // 本地原请求无法保存时，绑定零POST；恢复存储后仍要求明确批准。
  let posts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/execution-operations'))posts++;});
  await speaker.getByRole('checkbox',{name:'已核对音箱和获准音频',exact:true}).check();
  await page.evaluate(()=>{window.__audioOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('fixture_write_failed');};});
  await speaker.getByRole('button',{name:'确认绑定音箱',exact:true}).click();await expect(speaker.getByText('无法保存接入操作记录，尚未发送请求',{exact:true})).toBeVisible();assert.equal(posts,0);assert.equal(fixture.descriptions.length,0);
  await page.evaluate(()=>{Storage.prototype.setItem=window.__audioOriginalSetItem;});await page.reload();await speaker.getByRole('button',{name:'读取接入信息',exact:true}).click();await speaker.getByRole('checkbox',{name:'已核对音箱和获准音频',exact:true}).check();
  await speaker.getByRole('button',{name:'确认绑定音箱',exact:true}).click();await expect(speaker.getByText('接入状态：已绑定',{exact:true})).toBeVisible();
  await until(async()=>(await stack.request(devicePath)).value.ready);
  await speaker.getByLabel('获准音频',{exact:true}).selectOption('chime');await speaker.getByRole('button',{name:'播放音频',exact:true}).click();
  await expect(speaker.getByText('最近操作：输入已提交',{exact:true})).toBeVisible();assert.deepEqual(fixture.effects.map(e=>e.action),['SetVolume','SetAVTransportURI','Play']);assert.equal(fixture.pulls.length,1);
  await speaker.getByLabel('播放音量',{exact:true}).fill('7');await speaker.getByRole('button',{name:'设置音量',exact:true}).click();await until(()=>fixture.effects.length===4);await until(async()=>(await stack.request(base+'/commands')).value.items.every(c=>c.status==='confirmed'));
  await speaker.getByRole('button',{name:'停止播放',exact:true}).click();await until(()=>fixture.effects.length===5);await until(async()=>(await stack.request(base+'/commands')).value.items.every(c=>c.status==='confirmed'));
  await expect(speaker.getByText('最近操作：输入已提交',{exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
  await page.screenshot({path:path.join(directory,'audio-mobile.png'),fullPage:true});
  const input=(media='chime')=>({device_id:'device-lamp',model_revision:model.model_revision,expires_at:new Date(Date.now()+8000).toISOString(),operation:{type:'action.invoke',path:'playback.play',value:{media_id:media}}});
  const forbidden=await stack.request(base+'/commands',post(input('unapproved'),'forbidden-media'));assert.equal(forbidden.status,202);await until(async()=>(await stack.request(base+'/commands/'+forbidden.value.command_id)).value.status==='failed');assert.equal(fixture.effects.length,5);
  // 规则预演复用既有DSL，无业务请求；真实按钮只触发一次播报。
  const rule=JSON.parse(await readFile(path.join(root,'contracts/examples/button-chime.json'),'utf8'));
  assert.equal((await stack.request(base+'/rules:validate',post(rule))).value.valid,true);
  const simulation=(await stack.request(base+'/rules:simulate',post({rule,event:{device_id:'device-button',path:'button.pressed',historical:false,data:{count:1}}}))).value;assert.equal(simulation.executed,false);assert.equal(simulation.matched,true);assert.equal(fixture.effects.length,5);
  await stack.request(base+'/rule-deployments',post(rule));const event={event_id:'audio-once',occurred_at:new Date().toISOString(),historical:false,data:{count:1}};stack.button.stdin.write(JSON.stringify(event)+'\n');
  const run=await until(async()=>(await stack.request(base+'/runs')).value.items[0]);await until(async()=>(await stack.request(base+'/commands/'+run.command_ids[0])).value.status==='confirmed');assert.equal(fixture.effects.length,8);assert.equal(fixture.pulls.length,2);
  stack.button.stdin.write(JSON.stringify(event)+'\n');await until(async()=>(await stack.request(base+'/events?after=0')).value.items.filter(e=>e.type==='device.event').length>=2);assert.equal(fixture.effects.length,8);
  // CLI采用原键；Play已受理后响应断开，结果未知且不重试、不自动Stop。
  fixture.setFault('drop-play');const original=input(),inputPath=path.join(directory,'play.json');await writeFile(inputPath,JSON.stringify(original));
  const accepted=await cli('commands.create',['--input',inputPath,'--idempotency-key','lost-audio']);await until(async()=>(await stack.request(base+'/commands/'+accepted.command_id)).value.status==='unknown');assert.equal(fixture.effects.length,11);assert.equal(fixture.pulls.length,3);
  await stack.restartGateway();fixture.setFault('');await until(async()=>(await stack.request(devicePath)).value.ready);
  const restored=await cli('commands.resolve',['--id','lost-audio'],6);assert.equal(restored.command_id,accepted.command_id);assert.equal(restored.status,'unknown');assert.equal(fixture.effects.length,11);
  assert.equal((await stack.request(base+'/commands',post(original,'lost-audio'))).value.command_id,accepted.command_id);assert.equal(fixture.effects.length,11);
  await assert.rejects(mqtt.message(150),/mqtt_packet_timeout/);
  const originalBinding=(await stack.request(devicePath+'/execution-binding')).value;
  const revoked=await stack.request(base+'/execution-operations',post({type:'bindings.revoke',device_id:'device-lamp',expected_binding_revision:originalBinding.revision},'revoke-audio'));assert.equal(revoked.value.status,'applied');
  assert.equal((await stack.request(base+'/commands',post(input(),'revoked-audio'))).value.error.code,'execution_binding_revoked');
  await stack.restartGateway();assert.equal((await stack.request(devicePath+'/execution-binding')).value.state,'revoked');assert.equal(fixture.effects.length,11);assert.deepEqual((await stack.request(devicePath)).value.reported,{});
  for(const proof of fixture.proofs){assert.equal(proof.command.status,'dispatched');assert.equal(proof.command.execution_route.adapter_id,'speaker-dlna');assert.deepEqual(proof.command.execution_route,proof.binding.route);assert.ok(proof.binding.generation);}
  const report={passed:true,real_http:true,real_sqlite:true,real_mqtt:true,simulated_renderer:true,media_range_pulls:fixture.pulls.length,soap_mutations:fixture.effects.length,browser:true,cli:true,rule_simulation_zero_effects:true,event_deduplication:true,durable_before_each_mutation:true,binding_storage_failure_zero_posts:true,forbidden_media_zero_effects:true,unknown_no_retry:true,restart_no_replay:true,revoke_persistent:true,mqtt_action_messages:0,reported_unchanged:true,hardware:false,hardware_status:'用户要求跳过',audible_output:false,native_app_runtime:false,nas_image_rebuilt:false,published:false,full_goal_completed:false};
  await writeFile(path.join(directory,'dlna-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(directory,'dlna-result.json')}));
});

test('候选DTO保留电视兼容并严格验证DLNA，不泄露或接受媒体URL',()=>{
  const route={adapter_id:'speaker',revision:'sha256:'+'a'.repeat(64)};
  const item={kind:'dlna',device_id:'device-speaker',route,compatible:true,target:'127.0.0.1:12345',udn:'uuid:software-speaker',volume_limit:20,playback_volume:10,media:[{media_id:'chime',expires_at:'2030-01-01T00:00:00Z'}]};
  const page=items=>({items,next_cursor:null});assert.equal(verifyExecutionAdapters(page([item])).items.length,1);
  for(const mutate of [x=>x.url='http://example.org',x=>x.volume_limit=100,x=>x.media.push(x.media[0]),x=>x.media[0].expires_at='invalid',x=>x.kind='unknown']){const bad=structuredClone(item);mutate(bad);assert.throws(()=>verifyExecutionAdapters(page([bad])));}
  assert.equal(verifyExecutionAdapters(page([{device_id:'tv',route:{...route,adapter_id:'tv'},compatible:true,target:'192.168.1.4:5555',fingerprint:'sample',device_serial:'serial',applications:[],paths:['remote.press']},item])).items.length,2);
});

test('正式配置Schema与可复制示例一致，缺字段和未知参数拒绝',async()=>{
  const schema=JSON.parse(await readFile(path.join(root,'contracts/dlna-config.schema.json'),'utf8'));
  const source=await readFile(path.join(root,'gateway/adapters/dlna/README.md'),'utf8');
  const config=JSON.parse(source.match(/```json\n(.*?)\n```/s)[1]);
  const ajv=new Ajv({strict:true,allErrors:true});addFormats(ajv);const validate=ajv.compile(schema);
  assert.equal(validate(config),true,JSON.stringify(validate.errors));
  for(const name of Object.keys(config.bindings[0].config)) {const bad=structuredClone(config);delete bad.bindings[0].config[name];assert.equal(validate(bad),false,name);}
  const extra=structuredClone(config);extra.bindings[0].config.shell='reboot';assert.equal(validate(extra),false);
  const managed=structuredClone(config);managed.bindings[0].config.managed_media=true;managed.bindings[0].config.media=[];assert.equal(validate(managed),true,JSON.stringify(validate.errors));
  managed.bindings[0].config.media=config.bindings[0].config.media;assert.equal(validate(managed),false);
});
