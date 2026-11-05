import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { root, startStack, until, binaryDirectory } from '../tools/dev-stack.mjs';
import { origin, post, cloudClient, fixture } from './helpers/control.mjs';
import { actionState, startActionStack } from './helpers/actions.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo';

test('原生控制面库：属性/动作、真实HTTPS/WSS/MQTT、明确批准、丢响应与重启原键恢复', {timeout:480000,skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE}, async()=>{
  assert.equal(new URL(origin).protocol,'https:');assert.ok(process.env.LIMEIOT_TEST_CONTROL_CA_FILE);
  const directory=await mkdtemp(path.join(tmpdir(),'limeiot-native-clients-'));
  let browser,child,stack;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
    const token=(await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,'utf8')).trim();
    const cases=[['ios','property'],['android','property'],['ios','action'],['android','action']];
    if(process.env.LIMEIOT_DOTNET)cases.push(['windows','property'],['windows','action']);
    for(const [target,mode] of cases){
      const scratch=path.join(directory,target+'-'+mode);await mkdir(scratch,{mode:0o700});
      const artifacts=path.join(root,'.dev',`native-remote-${target}-${mode}-${randomBytes(8).toString('hex')}`);await mkdir(artifacts,{recursive:true});
      const key=path.join(artifacts,'identity.pk8');await exec(path.join(binaryDirectory,'limeiot-gateway'),['identity-init',key]);
      stack=await (mode==='action'?startActionStack:startStack)({directory:artifacts,gatewayEnv:{LIMEIOT_CONTROL_ALLOWED_ORIGINS:origin,LIMEIOT_GATEWAY_KEY_FILE:key,LIMEIOT_CONTROL_CA_FILE:process.env.LIMEIOT_TEST_CONTROL_CA_FILE,LIMEIOT_CONTROL_RELAY_ENABLED:'1'}});
      const cloud=await cloudClient(),pair=await cloud.pair(),space=pair.pairing.space_id;
      const local=(await stack.request(`${base}/control-pairings`,post({control_origin:pair.control_origin,pairing_id:pair.pairing.pairing_id,code:pair.code},'native-pair'))).value;
      const review=await until(async()=>{const v=(await stack.request(`${base}/control-pairings/${local.link_id}`)).value;return v.status==='awaiting_approval'&&v});
      await stack.request(`${base}/control-pairings/${local.link_id}/approve`,post({review_revision:review.review_revision}));
      const binding=(await until(async()=>{const v=(await stack.request(`${base}/control-pairings/${local.link_id}`)).value;return v.status==='active'&&v})).binding;
      await until(async()=>(await cloud.connection(binding)).connected);
      const args=target==='windows'?['run','--project',path.join(root,'packages/dotnet/LimeIoT.Client.Checks')]:target==='ios'?['run','ClientChecks']:['gradlew','--no-daemon','--configure-on-demand',':core:test','--rerun-tasks'];
      const childEnv={...process.env,LIMEIOT_NATIVE_CONTROL_CHECK:'1',LIMEIOT_NATIVE_CHECK_ACTION:mode==='action'?'1':'0',LIMEIOT_NATIVE_CHECK_DIRECTORY:scratch,LIMEIOT_NATIVE_CHECK_SPACE:space};delete childEnv.LIMEIOT_ENDPOINT;
      child=spawn(target==='windows'?process.env.LIMEIOT_DOTNET:target==='ios'?'swift':'sh',args,{cwd:target==='windows'?root:path.join(root,'apps',target),env:childEnv,stdio:['ignore','pipe','pipe']});
      let output='',finished=false;
      child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});
      const done=new Promise(resolve=>{child.once('exit',code=>{finished=true;resolve({code})});child.once('error',error=>{finished=true;resolve({error})})});
      async function waitFile(name){const deadline=Date.now()+60000;while(Date.now()<deadline){try{return await readFile(path.join(scratch,name),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}if(finished){const result=await done;throw new Error(`${target} exited waiting for ${name} (${result.code??'spawn error'}): ${output}`)}await delay(100)}throw new Error(`${target} timed out waiting for ${name}`)}
      let login;
      const deadline=Date.now()+60000;
      while(Date.now()<deadline){
        try{login=JSON.parse(await readFile(path.join(scratch,'login.json'),'utf8'));break}catch(e){if(!['ENOENT'].includes(e.code)&&!(e instanceof SyntaxError))throw e}
        if(finished){const result=await done;throw new Error(`${target} exited before authorization (${result.code??'spawn error'}): ${output}`)}
        await delay(100);
      }
      assert.ok(login,`${target} authorization was not produced`);
      assert.equal((await stat(path.join(scratch,'login.json'))).mode&0o777,0o600);
      assert.equal(login.verification_uri,origin+'/console/?native='+login.authorization_id);
      const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
      await page.goto(login.verification_uri);await page.getByLabel('实例凭据',{exact:true}).fill(token);await page.getByRole('button',{name:'登录私有实例',exact:true}).click();
      await page.getByLabel('应用中的授权码',{exact:true}).fill(login.user_code);await page.getByRole('button',{name:'批准登录',exact:true}).click();await page.getByText('请求已结束，请返回应用。',{exact:true}).waitFor();
      await waitFile('operation.json');const before=await fixture({drop_remote_responses:true});
      await writeFile(path.join(scratch,'send'),'send',{mode:0o600});await waitFile('unknown');
      await fixture({restart_api:true});await until(async()=>(await cloud.connection(binding)).connected);
      await writeFile(path.join(scratch,'recover'),'recover',{mode:0o600});
      const result=await done;child=undefined;assert.equal(result.code,0,`${target} client failed: ${output}`);
      const after=await fixture();assert.equal(after.remote_posts-before.remote_posts,1,'original native create cannot replay');
      const commands=(await stack.request(`${base}/commands`)).value.items;assert.equal(commands.length,1);assert.equal(commands[0].status,'confirmed');
      if(mode==='action'){
        assert.equal(commands[0].request.operation.type,'action.invoke');assert.equal(commands[0].evidence.type,'action_result');assert.equal(commands[0].evidence.completion,'submitted');
        assert.equal(commands[0].evidence.input_digest,await documentDigest(commands[0].request.operation.value));assert.equal((await actionState(stack)).action_log.length,1);
      }
      await writeFile(path.join(artifacts,'result.json'),JSON.stringify({passed:true,target,operation_type:mode==='action'?'action.invoke':'property.set',real_https:true,untrusted_ca_rejected:true,real_wss:true,real_mysql:true,simulated_device:true,hardware:false,native_app:false,remote_commands:1,response_loss:true,process_restart:true}));
      const session=await page.request.get(origin+'/api/console/v1/auth/session');assert.equal(session.status(),200,'child logout must preserve browser parent');
      await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('实例凭据',{exact:true}).waitFor();await context.close();
      await stack.close();stack=undefined;
      console.log(`${target==='windows'?'.NET':target==='ios'?'Swift':'Kotlin'} ${mode}：HTTPS授权、丢响应/重启原键恢复、仅1条设备命令与独立退出通过。`);
    }
  }finally{
    if(child?.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited}
    await fixture({});await stack?.close();await browser?.close();await rm(directory,{recursive:true,force:true});
  }
});
