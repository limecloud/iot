import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { root,startStack } from '../tools/dev-stack.mjs';

const base='/api/v1/spaces/space-demo',exec=promisify(execFile);
test('内置模型网页：存储失败零POST、两种来源不能绕过未知原操作、原结果恢复及移动视口', {timeout:90000}, async t=>{
  const stack=await startStack();t.after(()=>stack.close());
  const vector=JSON.parse(await readFile(path.join(root,'contracts/examples/model-release.json'),'utf8'));
  const apply=async(change,key)=>{
    const r=await stack.request(base+'/model-operations',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(change)});
    assert.equal(r.status,200);assert.equal(r.value.status,'applied');return r.value.result.value;
  };
  const trust=await apply({type:'trust.add',trust:vector.trust,expected_signing_key_id:vector.trust.signing_key_id},'fixture-trust');
  const installed=await apply({type:'models.install',trust_id:trust.trust_id,artifact:vector.artifact,expected_release_id:null},'fixture-install');
  const bundle=(await stack.request(base+'/model-bundles')).value.items.find(v=>v.model.model_id.includes('android-tv-agent'));
  const browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(12000);
  let posts=0,hideResults=true;const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith(base+'/model-operations'))posts++;});
  await page.route('**'+base+'/model-operations/by-key/**',async route=>{
    if(hideResults)await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'model_operation_not_found'}})});
    else await route.continue();
  });
  async function enter(){
    await page.goto(stack.env.LIMEIOT_ENDPOINT);
    await expect(page.getByRole('heading',{name:/^(我的设备|连接我的家)$/})).toBeVisible();
    if(await page.getByLabel('所有者凭据',{exact:true}).isVisible()){
      await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);
      await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
    }
    await page.getByRole('heading',{name:'我的设备',exact:true}).waitFor();
    await page.getByRole('button',{name:'家庭导航',exact:true}).click();
    await page.getByRole('button',{name:'设备接入',exact:true}).click();
  }
  const bindings=page.getByRole('region',{name:'绑定设备模型',exact:true});
  async function prepare(id){
    await bindings.getByLabel('设备编号',{exact:true}).fill('device-lamp');
    await expect(bindings.getByLabel('目标模型',{exact:true}).locator(`option[value="${id}"]`)).toHaveCount(1);
    await bindings.getByLabel('目标模型',{exact:true}).selectOption(id);
    await bindings.getByRole('button',{name:'读取设备当前绑定',exact:true}).click();
    await expect(bindings.getByRole('button',{name:'确认绑定',exact:true})).toBeVisible();
  }
  await enter();await prepare(installed.installation_id);
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('denied','QuotaExceededError');};});
  await bindings.getByRole('button',{name:'确认绑定',exact:true}).click();
  await expect(page.getByText('无法保存或读取本机操作记录，请检查浏览器存储设置',{exact:true})).toBeVisible();assert.equal(posts,0);
  await enter();await prepare(installed.installation_id);
  async function loseResponse(){
    await page.route('**'+base+'/model-operations',async route=>{await route.fetch();await route.abort('failed');await page.unroute('**'+base+'/model-operations');});
    await bindings.getByRole('button',{name:'确认绑定',exact:true}).click();
    await expect(page.getByText('结果未知，请查询原操作',{exact:true})).toBeVisible();
  }
  await loseResponse();assert.equal(posts,1);
  await prepare(bundle.bundle_id);await bindings.getByRole('button',{name:'确认绑定',exact:true}).click();
  await expect(page.getByText('请先查询同类原操作',{exact:true})).toBeVisible();assert.equal(posts,1);
  await enter();await expect(page.getByRole('region',{name:'模型原操作'}).getByText('结果未知',{exact:true})).toBeVisible();assert.equal(posts,1);
  hideResults=false;await enter();await expect(page.getByRole('region',{name:'模型原操作'}).getByText('已完成',{exact:true})).toBeVisible();assert.equal(posts,1);
  hideResults=true;await prepare(bundle.bundle_id);await loseResponse();assert.equal(posts,2);
  await prepare(installed.installation_id);await bindings.getByRole('button',{name:'确认绑定',exact:true}).click();
  await expect(page.getByText('请先查询同类原操作',{exact:true})).toBeVisible();assert.equal(posts,2);
  hideResults=false;await stack.restartGateway();await enter();
  await expect(page.getByRole('region',{name:'模型原操作'}).getByText('已完成',{exact:true})).toHaveCount(2);assert.equal(posts,2);
  const view=(await stack.request(base+'/devices/device-lamp/model-binding')).value;
  assert.equal(view.binding.bundle_id,bundle.bundle_id);assert.ok(!('installation_id' in view.binding));
  const audit=JSON.parse((await exec('python3',['-c',"import sys,json,sqlite3\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nv,h,b=c.execute('SELECT version,config_hash,body FROM snapshot').fetchone()\ns=json.loads(b)\nprint(json.dumps({'version':v,'config_hash':h,'binding':s['model_registry']['bindings']['device-lamp']}))",stack.env.LIMEIOT_DB],{timeout:5000})).stdout);
  assert.equal(audit.version,10);assert.equal(audit.binding.bundle_id,bundle.bundle_id);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(stack.directory,'model-bundles-mobile.png'),fullPage:true});
  await writeFile(path.join(stack.directory,'model-bundles-web-result.json'),JSON.stringify({passed:true,storage_failure_zero_posts:true,cross_source_pending_guard_both_directions:true,lost_response_and_404_original_only:true,restart_original_only:true,posts,snapshot_version:audit.version,browser:true,hardware:false,full_goal_completed:false},null,2)+'\n');
});
