import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root } from '../tools/dev-stack.mjs';
import { actionState, startActionStack } from './helpers/actions.mjs';

test('电视音频能力与DLNA面板分离，动作回执不冒充观测', {timeout:60000},async t=>{
  const stack=await startActionStack({modelPath:path.join(root,'contracts/models/android-tv-audio-remote.json')});
  t.after(()=>stack.close());
  const browser=await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
  const tv=page.getByRole('article',{name:'电视',exact:true});
  await expect(tv.getByRole('group',{name:'遥控器'})).toBeVisible();
  assert.equal(await tv.getByText('音箱接入与播放',{exact:true}).count(),0);
  const volumeBefore=await tv.getByLabel('音量',{exact:true}).textContent();
  const muteBefore=await tv.getByLabel('静音',{exact:true}).textContent();
  for(const action of ['audio.set_volume','audio.set_muted']) {
    if(action==='audio.set_volume') {
      await tv.getByLabel('目标音量（%）',{exact:true}).fill('5');
      await tv.getByRole('button',{name:'设置音量',exact:true}).click();
    } else await tv.getByRole('button',{name:'静音',exact:true}).click();
    await expect(tv.getByText('最近操作：输入已提交',{exact:true})).toBeVisible();
    await expect.poll(async()=>(await actionState(stack)).action_log.filter(item=>item.path===action).length).toBe(1);
  }
  const log=(await actionState(stack)).action_log;
  assert.deepEqual(log.map(item=>({path:item.path,input:item.input})),[
    {path:'audio.set_volume',input:{percent:5}},{path:'audio.set_muted',input:{muted:true}}]);
  await expect(tv.getByLabel('音量',{exact:true})).toHaveText(volumeBefore);
  await expect(tv.getByLabel('静音',{exact:true})).toHaveText(muteBefore);
  await page.reload();await expect(tv.getByLabel('目标音量（%）',{exact:true})).toBeVisible();
  assert.equal((await actionState(stack)).action_log.length,2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(stack.directory,'capability-panels-mobile.png'),fullPage:true});
  await writeFile(path.join(stack.directory,'capability-panels-result.json'),JSON.stringify({passed:true,
    real_gateway:true,real_mqtt:true,simulated_device:true,native_tv_agent:false,fake_adb:false,
    dlna_panel_absent:true,submitted_not_reported:true,reload_no_replay:true,mobile_width:390,
    hardware:false,full_goal_completed:false},null,2)+'\n');
  t.diagnostic('evidence: '+stack.directory);
});
