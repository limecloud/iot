import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root } from '../tools/dev-stack.mjs';
import { fixture, origin, post } from './helpers/control.mjs';

test('原生授权真实浏览器闭环：明确批准、丢失响应与重启恢复、独立子会话及取消撤销', {timeout:90000,skip:!process.env.LIMEIOT_TEST_ADMIN_TOKEN_FILE}, async()=>{
  const directory=path.join(root,'.dev',`native-auth-${randomBytes(8).toString('hex')}`);
  await mkdir(directory,{recursive:true});
  const ownerToken=(await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,'utf8')).trim();
  const key=randomBytes(32).toString('hex'),verifier=randomBytes(32).toString('hex');
  const start={request_key:key,code_challenge:createHash('sha256').update(verifier).digest('base64url'),platform:'ios'};
  const proof={request_key:key,code_verifier:verifier};
  async function native(route,value,status=200){
    const response=await fetch(origin+'/api/native/v1/authorizations'+route,{...post(value),signal:AbortSignal.timeout(12000)});
    const body=await response.json();assert.equal(response.status,status,body.error?.code);assert.equal(response.headers.get('cache-control'),'no-store');return body;
  }
  let browser;
  try{
    await fixture({drop_native_responses:true});
    await assert.rejects(native('',start));
    await fixture({restart_api:true});
    const initiated=await native('',start),restored=await native('',start);
    assert.deepEqual(restored,initiated);assert.equal(initiated.status,'pending');
    assert.equal(initiated.verification_uri,origin+'/console/?native='+initiated.authorization_id);
    assert.equal((await native('/poll',proof)).material,undefined);
    browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}}),page=await context.newPage(),errors=[];
    let workspaceRequests=0;page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/\/api\/console\/v1\/spaces/.test(r.url()))workspaceRequests++});
    await page.goto(initiated.verification_uri);
    await page.getByLabel('实例凭据',{exact:true}).fill(ownerToken);
    await page.getByRole('button',{name:'登录私有实例',exact:true}).click();
    await page.getByRole('heading',{name:'授权应用登录',exact:true}).waitFor();
    const approve=page.getByRole('button',{name:'批准登录',exact:true});
    await expect(approve).toBeDisabled();assert.equal((await native('/poll',proof)).status,'pending');
    await page.screenshot({path:path.join(directory,'authorization-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(directory,'authorization-mobile.png'),fullPage:true});
    for(const secret of [key,verifier,start.code_challenge,initiated.user_code])assert.ok(!(await page.content()).includes(secret));
    await page.getByLabel('应用中的授权码',{exact:true}).fill(initiated.user_code);
    const decisionPattern='**/api/console/v1/native-authorizations/*';
    await page.route(decisionPattern,async route=>{if(route.request().method()!=='POST')return route.continue();await route.fetch();await route.abort('failed');await page.unroute(decisionPattern)});
    await approve.click();await page.getByRole('alert').waitFor();await expect(approve).toBeEnabled();
    await approve.click();await page.getByText('请求已结束，请返回应用。',{exact:true}).waitFor();
    await fixture({drop_native_responses:true});await assert.rejects(native('/poll',proof));
    await fixture({restart_api:true});
    const approved=await native('/poll',proof),again=await native('/poll',proof);assert.deepEqual(again,approved);
    const material=approved.material;assert.equal(approved.status,'approved');assert.equal(material.origin,origin);assert.equal(material.audience,'console');
    assert.ok(/^[a-f0-9]{64}$/.test(material.session));assert.ok(Date.parse(material.expires_at)<=Date.now()+3600000);
    const cookie='__Host-limeiot_console='+material.session;
    const sessionResponse=await fetch(origin+'/api/console/v1/auth/session',{headers:{Cookie:cookie}});assert.equal(sessionResponse.status,200);const session=await sessionResponse.json();
    assert.equal(session.principal.principal_id,material.principal_id);
    const admin=await fetch(origin+'/api/admin/v1/status',{headers:{Cookie:cookie}});assert.equal(admin.status,401);await admin.body.cancel();
    for(const secret of [key,verifier,ownerToken,material.session]){
      assert.ok(!(await page.content()).includes(secret));assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes(secret));
    }
    await native('/cancel',proof);await native('/cancel',proof);
    const cancelled=await native('/poll',proof);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.material,undefined);
    const rejected=await fetch(origin+'/api/console/v1/auth/session',{headers:{Cookie:cookie}});assert.equal(rejected.status,401);await rejected.body.cancel();
    await page.reload();await page.getByText('请求已结束，请返回应用。',{exact:true}).waitFor();
    await page.screenshot({path:path.join(directory,'cancelled-mobile.png'),fullPage:true});
    for(const [platform,label] of [['macos','macOS'],['windows','Windows']]){
      const desktopKey=randomBytes(32).toString('hex'),desktopProof={request_key:desktopKey,code_verifier:verifier};
      const desktop=await native('',{...start,request_key:desktopKey,platform});
      await page.goto(desktop.verification_uri);await expect(page.getByText('LimeIoT '+label,{exact:true})).toBeVisible();
      await expect(approve).toBeDisabled();assert.equal((await native('/poll',desktopProof)).status,'pending');
      await page.getByLabel('应用中的授权码',{exact:true}).fill(desktop.user_code);await approve.click();await page.getByText('请求已结束，请返回应用。',{exact:true}).waitFor();
      assert.equal((await native('/poll',desktopProof)).status,'approved');await native('/cancel',desktopProof);
    }
    const finalKey=randomBytes(32).toString('hex'),finalProof={request_key:finalKey,code_verifier:verifier};
    const final=await native('',{...start,request_key:finalKey,platform:'android'});
    await page.goto(final.verification_uri);await page.getByLabel('应用中的授权码',{exact:true}).fill(final.user_code);await approve.click();await page.getByText('请求已结束，请返回应用。',{exact:true}).waitFor();
    assert.equal((await native('/poll',finalProof)).status,'approved');
    await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('实例凭据',{exact:true}).waitFor();
    await native('/poll',finalProof,401);
    assert.equal(workspaceRequests,0);assert.deepEqual(errors,[]);
    await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,real_mysql:true,real_browser:true,pkce:true,process_restart:true,response_loss:true,hardware:false,native_app:false}));
  }finally{await fixture({});await browser?.close()}
});
