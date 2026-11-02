import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';
import { cloudClient, fixture, origin, post } from './helpers/control.mjs';
import { actionState, startActionStack } from './helpers/actions.mjs';

const exec = promisify(execFile), base = '/api/v1/spaces/space-demo';
test('受限远程控制：真实WSS/MySQL/MQTT、耐久原键、双进程重启、丢失回执不重放及撤销', { timeout: 150000, skip: !process.env.LIMEIOT_TEST_CONTROL_CA_FILE }, async () => {
  const cloud=await cloudClient(), directory=path.join(root,'.dev',`remote-${randomBytes(8).toString('hex')}`);
  await mkdir(directory,{recursive:true});const key=path.join(directory,'identity.pk8');
  await exec(path.join(root,'target/debug/limeiot-gateway'),['identity-init',key]);
  const s=await startStack({directory,gatewayEnv:{LIMEIOT_CONTROL_ALLOWED_ORIGINS:origin,LIMEIOT_GATEWAY_KEY_FILE:key,LIMEIOT_CONTROL_CA_FILE:process.env.LIMEIOT_TEST_CONTROL_CA_FILE,LIMEIOT_CONTROL_RELAY_ENABLED:'1'}});
  const pair=await cloud.pair();let binding,link;
  const here=async id=>(await s.request(`${base}/control-pairings/${id}`)).value;
  const connected=()=>until(async()=>binding&&(await cloud.connection(binding)).connected,15000);
  const commands=async()=>(await s.request(`${base}/commands`)).value.items;
  const cloudBase=`/api/console/v1/spaces/${pair.pairing.space_id}`;
  const create=(input,status=200)=>cloud.call(`${cloudBase}/remote-commands`,input,status);
  const reconcile=id=>cloud.call(`${cloudBase}/remote-commands/${id}/reconcile`,{});
  const recover=key=>cloud.call(`${cloudBase}/remote-commands/by-key/${key}`);
  try {
    const created=await s.request(`${base}/control-pairings`,post({control_origin:pair.control_origin,pairing_id:pair.pairing.pairing_id,code:pair.code},'remote-pair'));
    link=await until(async()=>{const v=await here(created.value.link_id);return v.status==='awaiting_approval'&&v;});
    await s.request(`${base}/control-pairings/${link.link_id}/approve`,post({review_revision:link.review_revision}));
    binding=(await until(async()=>{const v=await here(link.link_id);return v.status==='active'&&v;})).binding;
    await connected();
    const devices=await cloud.call(`${cloudBase}/devices`);assert.equal(devices.items.length,2);assert.equal(devices.next,null);
    assert.ok(devices.items.every(d=>!('seen' in d)&&!('retired_boots' in d)&&!('session_id' in d)));
    const lamp=devices.items.find(d=>d.device_id==='device-lamp');
    assert.equal((await cloud.call(`${cloudBase}/model-releases/${lamp.model_revision}`)).revision,lamp.model_revision);
    await cloud.call(`${cloudBase}/model-releases/sha256:${'0'.repeat(64)}`,undefined,404);
    const input=key=>({request_key:key,gateway_id:binding.gateway_id,binding_revision:binding.revision,device_id:lamp.device_id,model_revision:lamp.model_revision,expires_at:new Date(Date.now()+25000).toISOString(),operation:{type:'property.set',path:'light.power',value:true}});
    const firstInput={...input('remote-normal'),expires_at:new Date(Date.now()+5000).toISOString()},first=await create(firstInput);
    assert.ok(['accepted','dispatched','confirmed'].includes(first.status),JSON.stringify(first));
    const confirmed=await until(async()=>{const v=await reconcile(first.remote_id);return v.status==='confirmed'&&v;});
    assert.equal(confirmed.local_result.evidence.type,'device_result');assert.ok(!('envelope' in confirmed.local_result));
    assert.equal((await create(firstInput)).remote_id,first.remote_id);
    await create({...firstInput,operation:{...firstInput.operation,value:false}},409);
    const rejected=await create({...input('remote-unknown-device'),device_id:'missing-device'});
    assert.equal(rejected.status,'rejected');assert.equal(rejected.local_result.error,'device_not_found');
    const otherSpace=await cloud.pair();
    await cloud.call(`/api/console/v1/spaces/${otherSpace.pairing.space_id}/remote-commands/${first.remote_id}`,undefined,404);
    await cloud.call(`/api/console/v1/spaces/${otherSpace.pairing.space_id}/remote-commands`,input('wrong-space'),404);
    const secondInput=input('remote-parallel');
    const concurrent=await Promise.all([create(secondInput),create(secondInput)]);assert.equal(concurrent[0].remote_id,concurrent[1].remote_id);
    await until(async()=> (await reconcile(concurrent[0].remote_id)).status==='confirmed');
    assert.equal((await commands()).length,2);
    // 已提交的设备动作丢掉全部网关回执；恢复只查旧remote_id，不能再发create。
    await fixture({drop_gateway_frames:true});
    const lostInput=input('remote-lost'),lost=await create(lostInput);assert.equal(lost.status,'unknown');assert.equal(lost.local_result,null);
    await until(async()=>(await commands()).some(c=>c.request.idempotency_key===lost.remote_id&&c.status==='confirmed'));
    assert.equal((await recover(lostInput.request_key)).status,'unknown');
    await fixture({close_relays:true});await connected();
    assert.equal((await create(lostInput)).remote_id,lost.remote_id);assert.equal((await recover(lostInput.request_key)).status,'unknown');
    assert.equal((await reconcile(lost.remote_id)).status,'confirmed');
    assert.ok(Date.parse(firstInput.expires_at)<Date.now());assert.equal((await create(firstInput)).remote_id,first.remote_id);
    await s.restartGateway();await connected();await fixture({restart_api:true});await connected();
    assert.equal((await recover(lostInput.request_key)).status,'confirmed');assert.equal((await create(lostInput)).remote_id,lost.remote_id);
    assert.equal((await commands()).length,3);
    // 不在线时拒绝新请求，不建立待发送队列；已耐久原键仍可读。
    await fixture({reject_relays:true,close_relays:true});await until(async()=>!(await cloud.connection(binding)).connected);
    const offlineInput=input('remote-offline');await create(offlineInput,503);await cloud.call(`${cloudBase}/remote-commands/by-key/remote-offline`,undefined,404);
    assert.equal((await recover(firstInput.request_key)).status,'confirmed');await fixture({});await connected();
    await s.request(`${base}/control-pairings/${link.link_id}/revoke`,post({}));
    await until(async()=>!(await cloud.connection(binding)).connected);await create(input('after-local-revoke'),503);
    await cloud.revoke(binding);await create(input('after-cloud-revoke'),404);
    assert.equal((await commands()).length,3);
    await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,real_wss:true,real_mysql:true,simulated_device:true,remote_commands:3,restarts:['go','rust'],lost_receipt_recovered:true,hardware:false}));
  } finally {await fixture({});await s.close();}
});

test('远程动作CLI：真实HTTPS/WSS/MQTT、动作证据与丢响应原键恢复', { timeout: 90000, skip: !process.env.LIMEIOT_TEST_CONTROL_CA_FILE }, async () => {
  const cloud = await cloudClient(), directory = path.join(root, '.dev', `remote-actions-${randomBytes(8).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  const key = path.join(directory, 'identity.pk8'); await exec(path.join(root, 'target/debug/limeiot-gateway'), ['identity-init', key]);
  const stack = await startActionStack({ directory, gatewayEnv: { LIMEIOT_CONTROL_ALLOWED_ORIGINS: origin, LIMEIOT_GATEWAY_KEY_FILE: key, LIMEIOT_CONTROL_CA_FILE: process.env.LIMEIOT_TEST_CONTROL_CA_FILE, LIMEIOT_CONTROL_RELAY_ENABLED: '1' } });
  const session = path.join(directory, 'session.json'), inputFile = path.join(directory, 'input.json');
  async function cli(args, code = 0) {
    let result;
    try { result = await exec(process.execPath, ['packages/cli/src/main.mjs', 'control', '--session-file', session, ...args], { cwd: root, timeout: 20000 }); } catch (error) { result = error; }
    assert.equal(result.code ?? 0, code, result.stderr);
    return code === 0 ? JSON.parse(result.stdout) : JSON.parse(result.stderr);
  }
  try {
    const pair = await cloud.pair(), cloudBase = `/api/console/v1/spaces/${pair.pairing.space_id}`;
    const local = (await stack.request(base + '/control-pairings', post({ control_origin: pair.control_origin, pairing_id: pair.pairing.pairing_id, code: pair.code }, 'remote-action-pair'))).value;
    const here = async () => (await stack.request(base + '/control-pairings/' + local.link_id)).value;
    const review = await until(async () => { const value = await here(); return value.status === 'awaiting_approval' && value; });
    await stack.request(base + '/control-pairings/' + local.link_id + '/approve', post({ review_revision: review.review_revision }));
    const binding = (await until(async () => { const value = await here(); return value.status === 'active' && value; })).binding;
    await until(async () => (await cloud.connection(binding)).connected);
    await cli(['auth', 'login', '--endpoint', origin, '--token-file', process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE]);
    const device = (await cloud.call(cloudBase + '/devices')).items.find(device => device.device_id === 'device-lamp');
    const model = await cloud.call(cloudBase + '/model-releases/' + device.model_revision);
    assert.equal(model.model.schema_version, 2);
    const input = { request_key: 'remote-action-one', gateway_id: binding.gateway_id, binding_revision: binding.revision, device_id: device.device_id, model_revision: device.model_revision, expires_at: new Date(Date.now() + 25000).toISOString(), operation: { type: 'action.invoke', path: 'remote.press', value: { key: 'home' } } };
    await writeFile(inputFile, JSON.stringify(input));
    const args = ['commands', 'create', '--space-id', pair.pairing.space_id, '--input', inputFile];
    const first = await cli(args);
    const result = await until(async () => {
      const value = await cli(['commands', 'reconcile', first.remote_id, '--space-id', pair.pairing.space_id]);
      return value.status === 'confirmed' && value;
    });
    assert.equal(result.local_result.evidence.type, 'action_result');
    assert.equal(result.local_result.evidence.completion, 'submitted');
    assert.equal((await cli(args)).remote_id, result.remote_id);
    assert.equal((await actionState(stack)).action_log.length, 1);
    const second = { ...input, request_key: 'remote-action-lost', expires_at: new Date(Date.now() + 25000).toISOString(), operation: { ...input.operation, value: { key: 'back' } } };
    await writeFile(inputFile, JSON.stringify(second));
    const before = (await fixture()).remote_posts;
    await fixture({ drop_remote_responses: true });
    assert.equal((await cli(args, 6)).error.code, 'operation_unknown');
    await fixture({});
    const recovered = await cli(args);
    assert.equal((await fixture()).remote_posts, before + 1);
    await until(async () => (await cloud.call(cloudBase + '/remote-commands/' + recovered.remote_id + '/reconcile', {})).status === 'confirmed');
    assert.equal((await cli(args)).local_result.evidence.completion, 'submitted');
    assert.equal((await actionState(stack)).action_log.length, 2);
    await writeFile(path.join(directory, 'remote-actions-result.json'), JSON.stringify({ passed: true, real_https: true, real_wss: true, real_mysql: true, real_mqtt: true, cli_action: true, action_evidence: true, original_key_recovery: true, remote_commands: 2, hardware: false }));
  } finally { await fixture({}); await stack.close(); }
});
