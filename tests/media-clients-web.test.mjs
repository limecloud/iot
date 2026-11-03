import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { root,until } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
import { verifyMediaPage,verifyMediaOperation } from '../packages/protocol/media.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo',devicePath=base+'/devices/device-lamp';

test('媒体CLI与390px家庭网页：私有原记录、丢回执只查询、授权播放、撤销删除和重启恢复',{timeout:150000},async t=>{
  const {directory,bytes,fixture,stack,bindSpeaker}=await mediaStack(t);const binding=await bindSpeaker(),file=path.join(directory,'chime.wav');await writeFile(file,bytes);
  const env={...stack.env};delete env.LIMEIOT_TOKEN_FILE;
  async function cli(args) {const value=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs',...args,'--space-id','space-demo','--state-dir',path.join(directory,'cli-state')],{cwd:root,env,timeout:10000})).stdout);return value;}
  const args=['media','upload','--file',file,'--retain-seconds','600','--idempotency-key','cli-upload'],uploaded=await cli(args),firstMedia=uploaded.result.media.media_id;
  assert.equal((await cli(args)).operation_id,uploaded.operation_id);assert.equal((await cli(['invoke','media.list'])).items.length,1);
  const cliRecord=JSON.parse(await readFile(uploaded.cli.record_file,'utf8'));assert.equal('content_base64' in cliRecord.change,false);
  const browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});page.setDefaultTimeout(15000);
  await page.goto(stack.env.LIMEIOT_ENDPOINT+'/?view=media');await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();await expect(page.getByRole('heading',{name:'音频',exact:true})).toBeVisible();
  const upload=page.getByRole('region',{name:'上传音频',exact:true}),grantForm=page.getByRole('region',{name:'播放授权',exact:true});
  let posts=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname===base+'/media-operations')posts++;});
  await upload.getByLabel('WAV 文件',{exact:true}).setInputFiles({name:'chime.wav',mimeType:'audio/wav',buffer:bytes});
  await page.evaluate(()=>{window.__mediaSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('limeiot.media-operation:'))throw new DOMException('blocked','QuotaExceededError');return window.__mediaSetItem.call(this,key,value);};});
  await upload.getByRole('button',{name:'上传音频',exact:true}).click();await expect(page.getByText('无法保存音频操作记录，尚未发送请求',{exact:true})).toBeVisible();assert.equal(posts,0);
  await page.evaluate(()=>{Storage.prototype.setItem=window.__mediaSetItem;});await page.reload();
  let lost;
  await page.route('**'+base+'/media-operations',async route=>{
    if(route.request().postDataJSON()?.type!=='media.upload'){await route.continue();return;}
    const response=await route.fetch();lost={key:route.request().headers()['idempotency-key'],value:await response.json()};await route.abort('failed');
  });
  await upload.getByLabel('WAV 文件',{exact:true}).setInputFiles({name:'chime.wav',mimeType:'audio/wav',buffer:bytes});await upload.getByRole('button',{name:'上传音频',exact:true}).click();await expect(page.getByText('音频操作结果未知，请查询原操作',{exact:true})).toBeVisible();assert.equal(posts,1);assert.ok(lost);const secondMedia=lost.value.result.media.media_id;
  const originalRecords=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('limeiot.media-operation:')).map(([,raw])=>JSON.parse(raw)));assert.equal(originalRecords.length,1);assert.equal('content_base64' in originalRecords[0].change,false);assert.equal(JSON.stringify(originalRecords).includes('/media/v1/'),false);
  await page.unroute('**'+base+'/media-operations');await page.reload();await page.getByText(/^音频操作记录/).click();await expect(page.getByText('已读取原回执',{exact:true})).toBeVisible();await page.getByText(/^音频操作记录/).click();
  assert.equal(posts,1);const snapshot=verifyMediaPage((await stack.request(base+'/media')).value,'space-demo');assert.equal(snapshot.items.length,2);
  await grantForm.getByLabel('音频',{exact:true}).selectOption(secondMedia);await grantForm.getByLabel('授权音箱',{exact:true}).selectOption('device-lamp');
  await expect(grantForm.getByRole('button',{name:'创建播放授权',exact:true})).toBeDisabled();await grantForm.getByLabel('允许所选音箱读取此音频',{exact:true}).check();
  const grantResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/media-operations'&&r.request().postDataJSON().type==='media.grant');
  await grantForm.getByRole('button',{name:'创建播放授权',exact:true}).click();const response=await grantResponse,grant=await response.json();verifyMediaOperation(grant,'space-demo',response.request().headers()['idempotency-key']);assert.equal('download_url' in grant.result,false);
  await expect(page.getByText('播放授权已创建',{exact:true})).toBeVisible();await expect(grantForm.getByText('当前可用',{exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});await page.screenshot({path:path.join(directory,'media-mobile.png'),fullPage:true});
  await page.goto(stack.env.LIMEIOT_ENDPOINT+'/?view=devices');const speaker=page.getByRole('article',{name:'音箱',exact:true});await speaker.getByRole('button',{name:'读取接入信息',exact:true}).click();await speaker.getByLabel('获准音频',{exact:true}).selectOption(secondMedia);await speaker.getByRole('button',{name:'播放音频',exact:true}).click();await expect(speaker.getByText('最近操作：输入已提交',{exact:true})).toBeVisible();assert.equal(fixture.renderedPulls.length,1);assert.equal(fixture.effects.length,3);
  await page.goto(stack.env.LIMEIOT_ENDPOINT+'/?view=media');const row=page.getByRole('article',{name:`播放授权 ${grant.result.grant_id}`,exact:true});await row.getByRole('button',{name:'撤销播放授权',exact:true}).click();await expect(page.getByText('播放授权已撤销',{exact:true})).toBeVisible();await expect(row.getByText('已撤销',{exact:true})).toBeVisible();
  const fileRow=page.getByRole('article',{name:`音频 ${secondMedia}`,exact:true});await fileRow.getByRole('button',{name:'删除音频',exact:true}).click();await page.getByRole('button',{name:'确认删除音频',exact:true}).click();await expect(page.getByText('音频已删除',{exact:true})).toBeVisible();
  const grantPath=path.join(directory,'grant.json');await writeFile(grantPath,JSON.stringify({type:'media.grant',media_id:firstMedia,device_id:'device-lamp',expected_binding_revision:binding.revision,valid_for_seconds:300}));const granted=await cli(['invoke','media-changes.create','--input',grantPath,'--idempotency-key','cli-grant']);assert.equal(granted.result.issued_in_process,true);assert.equal('download_url' in granted.result,false);
  await stack.restartGateway();await until(async()=>(await stack.request(devicePath)).value.ready);const restored=await cli(['invoke','media-changes.resolve','--id','cli-grant']);assert.equal(restored.operation_id,granted.operation_id);assert.equal(restored.result.issued_in_process,false);assert.equal(fixture.effects.length,3);
  const deletion=path.join(directory,'delete.json');await writeFile(deletion,JSON.stringify({type:'media.delete',media_id:firstMedia}));await cli(['invoke','media-changes.create','--input',deletion,'--idempotency-key','cli-delete']);assert.equal((await cli(args)).operation_id,uploaded.operation_id);assert.equal((await cli(['invoke','media.list'])).items.every(item=>!item.available),true);
  const disk=JSON.parse(await readFile(path.join(directory,'gateway.sqlite.media.json'),'utf8'));assert.equal(Object.values(disk.objects).every(item=>item.content_base64===null),true);
  await page.goto(stack.env.LIMEIOT_ENDPOINT+'/?view=media');await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();await expect(page.getByRole('heading',{name:'音频',exact:true})).toBeVisible();
  // 本地统一工作台的装配检查：控制面身份只读接口用显式夹具，媒体仍访问真实网关。
  await page.route('**/platform.json',route=>route.fulfill({json:{mode:'private'}}));
  await page.route('**/api/console/v1/auth/config',route=>route.fulfill({json:{local:true,oidc:false}}));
  await page.route('**/api/console/v1/auth/session',route=>route.fulfill({json:{audience:'console',principal:{principal_id:'fixture-owner',name:'本地所有者'},csrf_token:'a'.repeat(32),expires_at:new Date(Date.now()+3600000).toISOString()}}));
  await page.route('**/api/console/v1/spaces',route=>route.fulfill({json:{spaces:[]}}));
  await page.goto(stack.env.LIMEIOT_ENDPOINT+'/?view=media');await expect(page.getByRole('heading',{name:'音频',exact:true})).toBeVisible();await page.getByRole('button',{name:'工作台导航',exact:true}).click();await expect(page.getByRole('link',{name:'音频',exact:true})).toBeVisible();await page.getByRole('link',{name:'音频',exact:true}).click();await expect(page.getByRole('heading',{name:'上传音频',exact:true})).toBeVisible();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const report={passed:true,cli:true,browser:true,viewport:390,upload_storage_failure_zero_posts:true,lost_upload_original_only:true,records_exclude_audio_and_tokens:true,explicit_current_binding_grant:true,managed_media_gui_playback:true,soap_mutations:fixture.effects.length,media_range_pulls:fixture.renderedPulls.length,revoke_and_delete:true,restart_original_no_regrant:true,old_upload_does_not_restore_content:true,unified_workspace_media:true,workspace_control_identity_mocked:true,real_http:true,real_sqlite:true,real_mqtt:true,hardware:false,hardware_status:'用户要求跳过',audible_output:false,native_media_ui:false,nas_image_rebuilt:false,published:false,full_goal_completed:false};
  await writeFile(path.join(directory,'media-clients-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(directory,'media-clients-result.json')}));
});
