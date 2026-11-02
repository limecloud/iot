import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium,expect } from '@playwright/test';
import { cloudClient,origin } from './helpers/control.mjs';
import { documentDigest,verifyModelReport } from '../packages/protocol/model-validation.mjs';

test('真实模型校验：会话/CSRF隔离、CLI合同、零产品写入与浏览器报告失效',{skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,timeout:60000},async()=>{
  const core=path.resolve(import.meta.dirname,'..'),cloud=await cloudClient(),endpoint='/api/console/v1/models/validate';
  const lamp=JSON.parse(await readFile(path.join(core,'contracts/models/lamp.json'),'utf8'));
  const before=await cloud.call('/api/console/v1/products');
  const good=await verifyModelReport(await cloud.call(endpoint,{model:lamp}),lamp);assert.equal(good.valid,true);
  const invalid=await verifyModelReport(await cloud.call(endpoint,{model:{}}),{});assert.equal(invalid.valid,false);
  await cloud.call(endpoint,{model:{},unknown:true},400);
  const anon=await fetch(origin+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"model":{}}'});assert.equal(anon.status,401);await anon.body.cancel();
  assert.deepEqual(await cloud.call('/api/console/v1/products'),before);
  const temp=await mkdtemp(path.join(await realpath(tmpdir()),'limeiot-model-http-')),exec=promisify(execFile);
  let browser;
  try {
    const session=path.join(temp,'session.json'),input=path.join(temp,'input.json');
    const args=['packages/cli/src/main.mjs','control','--session-file',session];
    await exec(process.execPath,[...args,'auth','login','--endpoint',origin,'--token-file',process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE],{cwd:core});
    await writeFile(input,JSON.stringify({model:lamp}));
    const result=await exec(process.execPath,[...args,'models','validate','--input',input],{cwd:core});assert.equal(JSON.parse(result.stdout).model_revision,good.model_revision);
    await writeFile(input,'{"model":{}}');const bad=await exec(process.execPath,[...args,'models','validate','--input',input],{cwd:core}).catch(error=>error);assert.equal(bad.code,2);assert.equal(JSON.parse(bad.stdout).valid,false);
    browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/console/?view=products&new=1');await page.getByLabel('实例凭据',{exact:true}).fill((await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,'utf8')).trim());await page.getByRole('button',{name:'登录私有实例',exact:true}).click();
    await page.getByLabel('物模型 JSON',{exact:true}).fill(JSON.stringify(lamp,null,2));await page.getByRole('button',{name:'校验当前输入',exact:true}).click();
    await page.getByText('当前输入校验通过，尚未发布',{exact:true}).waitFor();await page.getByText(good.model_revision,{exact:true}).first().waitFor();
    await page.getByLabel('物模型 JSON',{exact:true}).fill('{}');await expect(page.getByText('当前输入校验通过，尚未发布',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'校验当前输入',exact:true}).click();await page.getByText('当前输入未通过校验',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    const auth=await (await page.request.get(origin+'/api/console/v1/auth/session')).json();
    const cookie=await page.context().cookies();const admin=await browser.newContext();await admin.addCookies(cookie.map(item=>({...item,name:'limeiot_admin'})));
    for(const [resource,data] of [[endpoint,{model:lamp}],['/api/console/v1/models/compare',{baseline:lamp,candidate:lamp}]]) {
      const forbidden=await page.request.post(origin+resource,{data,headers:{Origin:'https://other.invalid','X-CSRF-Token':auth.csrf_token}});assert.equal(forbidden.status(),403);
      const csrf=await page.request.post(origin+resource,{data,headers:{Origin:origin}});assert.equal(csrf.status(),403);
      const crossed=await admin.request.post(origin+resource,{data,headers:{Origin:origin,'X-CSRF-Token':auth.csrf_token}});assert.equal(crossed.status(),401);
    }
    const duplicate=await page.request.post(origin+'/api/console/v1/models/compare',{data:'{"baseline":{},"candidate":{"x":1,"x":2}}',headers:{Origin:origin,'X-CSRF-Token':auth.csrf_token,'Content-Type':'application/json'}});assert.equal(duplicate.status(),400);
    const after=await (await page.request.get(origin+'/api/console/v1/products')).json();assert.deepEqual(after,before);
    assert.equal(good.document_digest,await documentDigest(lamp));
  } finally {await browser?.close();await rm(temp,{recursive:true,force:true})}
});
