import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root, freePort, startStack, stop, until } from '../tools/dev-stack.mjs';
import { base, post, commandResult } from './helpers/actions.mjs';
import { createAdbFixture } from './helpers/android-tv.mjs';
import { mqttProbe } from './support/mqtt-probe.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';

const exec = promisify(execFile), devicePath = base + '/devices/device-lamp';
const nativePaths = ['apps.launch', 'audio.set_muted', 'audio.set_volume'];
async function effects(directory) {
  try { return (await readFile(path.join(directory, 'effects.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('网页明确组合音频原生端与ADB：唯一路径、实际状态、未知恢复及撤销', {timeout:120000}, async t => {
  const directory = await mkdtemp(path.join(root, '.dev/tv-audio-composition-web-'));
  t.diagnostic('evidence: ' + directory);
  const adbState = path.join(directory, 'adb-state'); await mkdir(adbState, {mode:0o700});
  const adb = await createAdbFixture(adbState);
  await writeFile(path.join(adbState, 'scenario.json'), JSON.stringify({database:path.join(directory, 'gateway.sqlite')}));
  const tvConfig = path.join(directory, 'tv.json');
  await writeFile(tvConfig, JSON.stringify({schema_version:1, bindings:[{device_id:'device-lamp', adapter_id:'tv-adb', config:{
    schema_version:1, adb_path:adb, state_directory:adbState, server_port:5049,
    target:'192.168.31.94:5555', fingerprint:'Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys',
    device_serial:'sample-tv-001', applications:[], timeout_ms:3000,
  }}]}));
  const modelPath = path.join(root, 'contracts/models/android-tv-audio-remote.json');
  const validated = JSON.parse((await exec(process.execPath, ['packages/cli/src/main.mjs', 'model', 'validate', '--input', modelPath], {
    cwd:root, env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')}, timeout:5000,
  })).stdout); assert.equal(validated.valid, true);
  const config = JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));
  config.models[0] = validated.normalized_model; config.devices[0].model_revision = validated.model_revision;
  const configPath = path.join(directory,'config/gateway.json'); await mkdir(path.dirname(configPath));
  await writeFile(configPath, JSON.stringify(config));
  const provision = 'import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.cwd()/"deploy/nas"))\nimport device_identity\np=Path(sys.argv[1])\ndevice_identity.initialize(p,"127.0.0.1")\ndevice_identity.issue(p,"device-lamp",p/"credentials")\n';
  await exec('python3', ['-c', provision, directory], {cwd:root, timeout:20000});
  const port = await freePort();
  const stack = await startStack({directory, modelPaths:{lamp:modelPath},
    gatewayEnv:{LIMEIOT_CONFIG:configPath,LIMEIOT_TV_CONFIG:tvConfig}, brokerTls:{port, ca:path.join(directory,'broker-tls/ca.crt'),
      certificate:path.join(directory,'broker-tls/server.crt'), key:path.join(directory,'broker-tls/server.key')}});
  t.after(() => stack.close()); await stop(stack.lamp);
  const credentials = {port, ca:await readFile(path.join(directory,'credentials/ca.crt')),
    cert:await readFile(path.join(directory,'credentials/device.crt')), key:await readFile(path.join(directory,'credentials/private.key'))};
  let mqtt, boot, session, sequence, snapshot, timer;
  let publishQueue = Promise.resolve();
  t.after(() => { clearInterval(timer); mqtt?.close(); });
  const revision = (await stack.request(devicePath)).value.model_revision;
  function publish(kind, body) {
    const sent = publishQueue.then(async () => {
      const envelope = {v:1,kind,message_id:randomUUID(),device_id:'device-lamp',model_revision:revision,boot_id:boot,seq:++sequence,body};
      if (session) envelope.session_id = session;
      assert.equal(await mqtt.publish('limeiot/v1/space-demo/device-lamp/up/' + kind, JSON.stringify(envelope)), 0);
    });
    publishQueue = sent.catch(() => {}); return sent;
  }
  function heartbeat() {
    const observed_at = new Date().toISOString();
    return publish('state', {type:'snapshot',revision:++snapshot,properties:[
      {path:'audio.volume',value:41,observed_at,quality:'confirmed',source:'audio-protocol-fixture'},
      {path:'audio.muted',value:false,observed_at,quality:'confirmed',source:'audio-protocol-fixture'},
    ]});
  }
  async function connect() {
    clearInterval(timer); await publishQueue; mqtt?.close();
    mqtt = await mqttProbe(credentials); await mqtt.subscribe('limeiot/v1/space-demo/device-lamp/down/+');
    boot = randomUUID(); session = undefined; sequence = 0; snapshot = 0;
    await publish('hello', {challenge:randomUUID(),execution_paths:nativePaths});
    const welcome = JSON.parse((await mqtt.message()).payload); assert.equal(welcome.kind, 'welcome'); session = welcome.session_id;
    await heartbeat();
    timer = setInterval(() => void heartbeat().catch(() => {}), 1000);
    await until(async () => (await stack.request(devicePath)).value.native_execution?.ready === true);
  }
  await connect();
  const initial = (await stack.request(devicePath + '/execution-binding')).value;
  const candidate = (await stack.request(base + '/execution-adapters')).value.items[0];
  assert.equal(candidate.compatible, true); assert.deepEqual(candidate.paths, ['apps.launch','remote.press']);
  const change = {type:'bindings.compose',device_id:'device-lamp',route:candidate.route,native_paths:nativePaths,
    expected_native_session:session,expected_binding_revision:initial.revision,expected_model_revision:revision};
  assert.equal((await stack.request(base + '/execution-operations', post({...change,expected_native_session:'stale-session'}, 'stale'))).value.reason, 'execution_native_proof_required');
  assert.equal((await stack.request(base + '/execution-operations', post({...change,native_paths:['apps.launch']}, 'unsafe'))).value.reason, 'execution_model_incompatible');
  assert.equal((await effects(adbState)).length, 0);

  const browser = await chromium.launch({headless:true,executablePath:process.env.LIMEIOT_BROWSER_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'}); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let posts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/execution-operations')) posts++; });
  await page.goto(stack.env.LIMEIOT_ENDPOINT);
  await page.getByLabel('所有者凭据',{exact:true}).fill(stack.env.LIMEIOT_TOKEN);
  await page.getByRole('button',{name:'连接家庭网关',exact:true}).click();
  const tv = page.getByRole('article',{name:'电视',exact:true});
  async function review() {
    await tv.getByText('电视接入与应用',{exact:true}).click();
    await tv.getByRole('button',{name:'读取接入信息',exact:true}).click();
    await expect(tv.getByText('电视Agent执行：启动应用、设置静音、设置音量',{exact:true})).toBeVisible();
    await expect(tv.getByText('网关执行：遥控按键',{exact:true})).toBeVisible();
    assert.equal(await tv.getByRole('button',{name:'确认绑定电视',exact:true}).count(), 0);
    await tv.getByRole('checkbox',{name:'已在电视端核对设备并允许连接',exact:true}).check();
  }
  await review();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key,value) { if (key.startsWith('limeiot.execution-operation:')) throw new Error('fixture-storage-fault'); return original.call(this,key,value); };
  });
  await tv.getByRole('button',{name:'确认组合电视接入',exact:true}).click();
  await expect(tv.getByText('无法保存接入操作记录，尚未发送请求',{exact:true})).toBeVisible();
  assert.equal(posts, 0);
  await page.reload(); await review();
  await page.route('**/execution-operations', async route => { await route.fetch(); await route.abort(); });
  await tv.getByRole('button',{name:'确认组合电视接入',exact:true}).click();
  await expect(tv.getByText('接入结果未知，请查询原操作',{exact:true})).toBeVisible();
  assert.equal(posts, 1);
  await page.unroute('**/execution-operations');
  await page.reload();
  await tv.getByText('电视接入与应用',{exact:true}).click();
  await tv.getByRole('button',{name:'查询接入原操作',exact:true}).click();
  await expect(tv.getByText('接入状态：已组合接入',{exact:true})).toBeVisible();
  assert.equal(posts, 1);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('limeiot.execution-operation:')).map(([,value]) => JSON.parse(value)));
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].request.change, change);
  await until(async () => { const state=(await stack.request(devicePath)).value; return state.action_availability['remote.press'] && state.action_availability['audio.set_volume']; });
  assert.deepEqual((await stack.request(devicePath + '/execution-binding')).value.routes, {'remote.press':candidate.route});
  await tv.getByLabel('目标音量（%）',{exact:true}).fill('5');
  await tv.getByRole('button',{name:'设置音量',exact:true}).click();
  const volume = JSON.parse((await mqtt.message()).payload);
  assert.equal(volume.kind, 'command'); assert.equal(volume.body.operation.path, 'audio.set_volume');
  assert.deepEqual(volume.body.operation.value, {percent:5});
  await publish('result', {command_id:volume.message_id,status:'confirmed',evidence:{type:'action_result',path:'audio.set_volume',
    input_digest:await documentDigest({percent:5}),output:{},completion:'submitted',observed_at:new Date().toISOString()}});
  await commandResult(stack, volume.message_id);
  await expect(tv.getByLabel('音量',{exact:true})).toHaveText('41 %');
  await tv.getByRole('button',{name:'主页',exact:true}).click();
  await until(async () => (await effects(adbState)).length === 1);
  await expect(tv.getByRole('button',{name:'主页',exact:true})).toBeEnabled();
  await assert.rejects(mqtt.message(200), /mqtt_packet_timeout/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path:path.join(directory,'audio-composition-mobile.png'),fullPage:true});

  clearInterval(timer); await publishQueue; await publish('availability', {online:false}); mqtt.close();
  await until(async () => { const state=(await stack.request(devicePath)).value; return state.ready && !state.native_execution.ready && !state.action_availability['audio.set_volume'] && state.action_availability['remote.press']; });
  await expect(tv.getByRole('button',{name:'设置音量',exact:true})).toBeDisabled();
  await tv.getByRole('button',{name:'主页',exact:true}).click();
  await until(async () => (await effects(adbState)).length === 2);
  await stack.restartGateway();
  await connect();
  await assert.rejects(mqtt.message(200), /mqtt_packet_timeout/);
  assert.equal((await effects(adbState)).length, 2);
  const binding = (await stack.request(devicePath + '/execution-binding')).value;
  assert.equal((await stack.request(base + '/execution-operations', post({type:'bindings.revoke',device_id:'device-lamp',expected_binding_revision:binding.revision}, 'revoke'))).value.status, 'applied');
  const original = (await stack.request(base + '/execution-operations/by-key/' + saved[0].request.idempotency_key)).value;
  assert.equal(original.status, 'applied');
  assert.equal((await stack.request(devicePath + '/execution-binding')).value.state, 'revoked');
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory,'result.json'), JSON.stringify({passed:true,real_gateway:true,real_mtls:true,real_mqtt:true,real_sqlite:true,
    native_protocol_fixture:true,native_tv_agent:false,fake_adb:true,explicit_web_composition:true,
    stale_session_and_unsafe_partition_rejected:true,storage_failure_zero_posts:true,response_loss_only_queries_original:true,
    native_audio_only:true,adapter_remote_only:true,submitted_not_reported:true,native_offline_not_adapter_ready:true,
    restart_no_replay:true,original_result_does_not_reactivate_revoked:true,adapter_effects:2,volume_requests:1,
    mobile_width:390,hardware:false,full_goal_completed:false}, null, 2) + '\n');
});
