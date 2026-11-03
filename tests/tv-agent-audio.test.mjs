import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { base, post, commandResult } from './helpers/actions.mjs';
import { createAdbFixture } from './helpers/android-tv.mjs';
import { tvAgentRuntime } from './helpers/tv-agent.mjs';

const exec = promisify(execFile), devicePath = base + '/devices/device-lamp';
const nativePaths = ['apps.launch', 'audio.set_muted', 'audio.set_volume'];
async function lines(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('实际JVM音频与网页/假ADB：量化采样、唯一路径、未知不重放及撤销', {timeout:240000}, async t => {
  const runtime = await tvAgentRuntime();
  const directory = await mkdtemp(path.join(root, '.dev/tv-agent-audio-'));
  t.diagnostic('evidence: ' + directory);
  const adbState = path.join(directory, 'adb-state'); await mkdir(adbState, {mode:0o700});
  const adb = await createAdbFixture(adbState);
  await writeFile(path.join(adbState, 'scenario.json'), JSON.stringify({database:path.join(directory, 'gateway.sqlite')}));
  const tvConfig = path.join(directory, 'tv.json');
  await writeFile(tvConfig, JSON.stringify({schema_version:1,bindings:[{device_id:'device-lamp',adapter_id:'tv-adb',config:{
    schema_version:1,adb_path:adb,state_directory:adbState,server_port:5049,target:'192.168.31.94:5555',
    fingerprint:'Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys',device_serial:'sample-tv-001',
    applications:[{application_id:'com.example.player',category:'leanback'}],timeout_ms:3000,
  }}]}));
  const modelPath = path.join(root, 'contracts/models/android-tv-audio-remote.json');
  const validation = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs','model','validate','--input',modelPath], {
    cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')},timeout:5000,
  })).stdout); assert.equal(validation.valid, true);
  const config = JSON.parse(await readFile(path.join(root, 'deploy/dev/config.json'), 'utf8'));
  config.models[0] = validation.normalized_model; config.devices[0].model_revision = validation.model_revision;
  delete config.devices[0].routes;
  const configPath = path.join(directory, 'config/gateway.json'); await mkdir(path.dirname(configPath));
  await writeFile(configPath, JSON.stringify(config));
  const provision = 'import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n';
  await exec('python3', ['-c',provision,directory], {cwd:root,timeout:20000});
  const tlsPort = await freePort();
  const stack = await startStack({directory,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configPath,LIMEIOT_TV_CONFIG:tvConfig},
    brokerTls:{port:tlsPort,ca:path.join(directory,'broker-tls/ca.crt'),certificate:path.join(directory,'broker-tls/server.crt'),key:path.join(directory,'broker-tls/server.key')}});
  t.after(() => stack.close()); await stop(stack.lamp);
  const broker = 'ssl://127.0.0.1:' + tlsPort;
  await exec('python3', ['tools/tv-agent-enrollment.py','--identity-directory',path.join(directory,'credentials'),
    '--broker',broker,'--model-profile','android-tv-audio-remote','--output',path.join(directory,'credentials/enrollment.json')], {cwd:root,timeout:15000});
  const systemFile = path.join(directory, 'audio-system.json');
  async function system(change) {
    let previous = {minimum:0,maximum:15,index:6,muted:false,permitted:true,unknown_after_effect:false};
    try { previous = JSON.parse(await readFile(systemFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, 'audio-external.next');
    await writeFile(temporary, JSON.stringify({...previous,...change})); await rename(temporary, systemFile);
  }
  await system({});
  let worker, done, launches = 0;
  async function launch() {
    const previous = (await stack.request(devicePath)).value.boot_id; launches++;
    worker = spawn(runtime.executable, runtime.args, {cwd:root,env:{...process.env,LIMEIOT_TV_AGENT_JOURNEY:'1',
      LIMEIOT_TV_AGENT_PROFILE:'android-tv-audio-remote',LIMEIOT_TV_AGENT_DIRECTORY:directory,
      LIMEIOT_TV_AGENT_BROKER:broker,LIMEIOT_TV_AGENT_GATEWAY_DATABASE:stack.env.LIMEIOT_DB},stdio:['ignore','pipe','pipe']});
    const output = createWriteStream(path.join(directory, 'jvm-' + launches + '.log'));
    worker.stdout.pipe(output); worker.stderr.pipe(output); worker.once('exit', () => output.end());
    done = new Promise((resolve,reject) => { worker.once('error',reject); worker.once('exit',resolve); }); done.catch(() => {});
    await Promise.race([
      until(async () => { const d=(await stack.request(devicePath)).value; return d.boot_id!==previous && d.native_execution?.ready && d.action_availability['audio.set_volume']; },90000),
      done.then(code => { throw new Error('JVM worker exited before ready: ' + code); }),
    ]);
  }
  async function finish() {
    await writeFile(path.join(directory,'stop'), 'stop'); assert.equal(await done, 0);
    await rename(path.join(directory,'stop'), path.join(directory,'stop-' + launches));
  }
  t.after(async () => { if (worker) await stop(worker); });
  await launch();
  const first = (await stack.request(devicePath)).value;
  assert.equal(first.model_revision, validation.model_revision); assert.deepEqual(first.native_execution.paths, nativePaths);
  assert.equal(first.reported['audio.volume'].value, 40); assert.equal(first.reported['audio.volume'].source, 'tv-agent.audio');

  const browser = await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
  const tv = page.getByRole('article',{name:'电视',exact:true});
  await tv.getByText('电视接入与应用',{exact:true}).click();
  await tv.getByRole('button',{name:'读取接入信息',exact:true}).click();
  await expect(tv.getByText('电视Agent执行：启动应用、设置静音、设置音量',{exact:true})).toBeVisible();
  await expect(tv.getByText('网关执行：遥控按键',{exact:true})).toBeVisible();
  await tv.getByRole('checkbox',{name:'已在电视端核对设备并允许连接',exact:true}).check();
  await tv.getByRole('button',{name:'确认组合电视接入',exact:true}).click();
  await expect(tv.getByText('接入状态：已组合接入',{exact:true})).toBeVisible();
  const binding = (await stack.request(devicePath + '/execution-binding')).value;
  assert.deepEqual(binding.native_paths, nativePaths); assert.deepEqual(Object.keys(binding.routes), ['remote.press']);
  const operations = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('limeiot.execution-operation:')).map(([,v]) => JSON.parse(v)));
  assert.equal(operations.length, 1); const composeKey = operations[0].request.idempotency_key;
  await tv.getByLabel('目标音量（%）',{exact:true}).fill('5');
  await tv.getByRole('button',{name:'设置音量',exact:true}).click();
  const nativeEffects = () => lines(path.join(directory,'effects.jsonl'));
  const adapterEffects = () => lines(path.join(adbState,'effects.jsonl'));
  await until(async () => (await nativeEffects()).length === 1);
  const volume = (await nativeEffects())[0]; assert.equal(volume.path, 'audio.set_volume'); assert.equal(volume.percent, 5);
  const volumeResult = await commandResult(stack, volume.command_id);
  assert.equal(volumeResult.evidence.completion, 'submitted'); assert.deepEqual(volumeResult.evidence.output, {});
  await expect(tv.getByLabel('音量',{exact:true})).toHaveText('7 %');
  assert.equal(JSON.parse(await readFile(systemFile,'utf8')).index, 1); assert.equal((await adapterEffects()).length, 0);
  await tv.getByRole('button',{name:'静音',exact:true}).click();
  await until(async () => (await nativeEffects()).length === 2);
  await commandResult(stack, (await nativeEffects())[1].command_id);
  await expect(tv.getByLabel('静音',{exact:true})).toHaveText('已静音');
  await tv.getByRole('button',{name:'主页',exact:true}).click();
  await until(async () => (await adapterEffects()).length === 1); assert.equal((await nativeEffects()).length, 2);
  const requests = new Map();
  async function command(key, action, value) {
    const body = {device_id:'device-lamp',model_revision:validation.model_revision,expires_at:new Date(Date.now()+12000).toISOString(),operation:{type:'action.invoke',path:action,value}};
    requests.set(key, body); const result = await stack.request(base + '/commands', post(body,key));
    assert.equal(result.status, 202, JSON.stringify(result.value)); return result.value;
  }
  await commandResult(stack, (await command('jvm-audio-app','apps.launch',{application_id:'com.example.player'})).command_id);
  assert.equal((await nativeEffects()).length, 3); assert.equal((await adapterEffects()).length, 1);
  await system({maximum:100,index:41});
  await expect(tv.getByLabel('音量',{exact:true})).toHaveText('41 %');
  const observed = (await stack.request(devicePath)).value.reported;
  assert.equal(observed['audio.volume'].value, 41); assert.equal(observed['audio.volume'].source, 'tv-agent.audio');
  await system({unknown_after_effect:true});
  const uncertain = await command('jvm-audio-unknown','audio.set_muted',{muted:false});
  await commandResult(stack, uncertain.command_id, 'unknown');
  await expect(tv.getByLabel('静音',{exact:true})).toHaveText('未静音');
  const preserved = JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));
  assert.equal(preserved.version, 4); assert.equal(preserved.entries[uncertain.command_id].result.status, 'unknown');
  assert.equal((await nativeEffects()).length, 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path:path.join(directory,'jvm-audio-mobile.png'),fullPage:true});
  await finish();
  await until(async () => { const d=(await stack.request(devicePath)).value; return !d.native_execution.ready && !d.action_availability['audio.set_volume'] && d.action_availability['remote.press']; },20000);
  await expect(tv.getByRole('button',{name:'设置音量',exact:true})).toBeDisabled();
  await tv.getByRole('button',{name:'主页',exact:true}).click();
  await until(async () => (await adapterEffects()).length === 2);
  await system({unknown_after_effect:false}); await stack.restartGateway(); await launch();
  assert.equal((await nativeEffects()).length, 4); assert.equal((await adapterEffects()).length, 2);
  const recovered = await stack.request(base + '/commands', post(requests.get('jvm-audio-unknown'),'jvm-audio-unknown'));
  assert.equal(recovered.value.command_id, uncertain.command_id); assert.equal(recovered.value.status, 'unknown');
  const latest = (await stack.request(devicePath + '/execution-binding')).value;
  assert.equal((await stack.request(base + '/execution-operations', post({type:'bindings.revoke',device_id:'device-lamp',expected_binding_revision:latest.revision},'revoke-jvm-audio'))).value.status, 'applied');
  assert.equal((await stack.request(base + '/execution-operations/by-key/' + composeKey)).value.status, 'applied');
  assert.equal((await stack.request(devicePath + '/execution-binding')).value.state, 'revoked');
  for (const [action,value] of [['audio.set_volume',{percent:10}],['remote.press',{key:'home'}]]) {
    const response = await stack.request(base + '/commands', post({device_id:'device-lamp',model_revision:validation.model_revision,
      expires_at:new Date(Date.now()+10000).toISOString(),operation:{type:'action.invoke',path:action,value}}, 'revoked-jvm-' + action.replaceAll('.','-')));
    assert.equal(response.value.error.code, 'execution_binding_revoked');
  }
  await finish();
  const finalJournal = JSON.parse(await readFile(path.join(directory,'journal.json'),'utf8'));
  assert.deepEqual(finalJournal.entries[uncertain.command_id], preserved.entries[uncertain.command_id]);
  assert.equal((await nativeEffects()).length, 4); assert.equal((await adapterEffects()).length, 2);
  for (const effect of await nativeEffects()) assert.equal(effect.attempt_durable, true);
  assert.equal((await lines(path.join(directory,'gateway-durable.jsonl'))).length, 4);
  for (const proof of await lines(path.join(adbState,'durable.jsonl'))) assert.deepEqual(proof.binding.native_paths, nativePaths);
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory,'result.json'), JSON.stringify({passed:true,actual_jvm_agent:true,native_protocol_fixture:false,
    real_mtls:true,real_mqtt:true,real_gateway:true,real_sqlite:true,explicit_web_composition:true,simulated_audio_port:true,
    android_audio_manager:false,quantized_volume_percent:7,requested_volume_percent:5,external_volume_observed:41,
    submitted_not_reported:true,native_effects:4,adapter_effects:2,native_and_gateway_durable_before_effect:true,
    native_audio_and_apps_only:true,adapter_remote_only:true,unknown_audio_effect_preserved:true,journal_version:4,
    gateway_and_jvm_restart_no_replay:true,native_offline_adapter_independent:true,revoked_both_paths:true,
    original_compose_does_not_reactivate:true,jvm_launches:launches,mobile_width:390,hardware:false,
    native_app_runtime:false,full_goal_completed:false},null,2) + '\n');
});
