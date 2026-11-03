import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,copyFile,cp,stat } from 'node:fs/promises';
import path from 'node:path';
import { root,freePort,stop,until } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
const exec=promisify(execFile),manager=path.join(root,'deploy/nas/manage.py'),snapshot='data/gateway.sqlite.media.json',base='/api/v1/spaces/space-demo';
const post=(value,key)=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(value)});

test('NAS媒体：明确配置、实时快照备份、新目录恢复、旧地址失效及损坏拒绝',{timeout:150000},async t=>{
  const parent=await mkdtemp(path.join(root,'.dev/nas-media-')),directory=path.join(parent,'installation'),backup=path.join(parent,'backup'),restored=path.join(parent,'restored'),mediaPort=await freePort(),origin=`http://127.0.0.1:${mediaPort}`;
  const manage=(...args)=>exec('python3',[manager,...args],{cwd:root,timeout:45000});
  await manage('init','--directory',directory,'--origin','https://127.0.0.1:18443');
  await manage('media-config','--directory',directory,'--media-origin',origin);
  const metadata=JSON.parse(await readFile(path.join(directory,'installation.json'),'utf8'));assert.equal(metadata.media_origin,origin);
  const secret=async name=>(await readFile(path.join(directory,'secrets',name),'utf8')).trim();
  const credentials={owner:await secret('owner-token'),gateway:await secret('gateway-password'),lamp:await secret('device-lamp-password'),button:await secret('device-button-password')};
  const {bytes,fixture,stack,model,bindSpeaker}=await mediaStack(t,'unused-',{directory:path.join(directory,'data'),mediaPort,credentials});const binding=await bindSpeaker();
  await copyFile(path.join(directory,'data/config.json'),path.join(directory,'config/gateway.json'));await copyFile(path.join(directory,'data/audio.json'),path.join(directory,'config/audio.json'));const audioConfig=await readFile(path.join(directory,'config/audio.json'),'utf8');await manage('media-config','--directory',directory,'--media-origin',origin);assert.equal(await readFile(path.join(directory,'config/audio.json'),'utf8'),audioConfig);
  let compose=['docker','compose'];try {await exec(compose[0],[...compose.slice(1),'version']);}catch{compose=['docker-compose'];}
  const rendered=JSON.parse((await exec(compose[0],[...compose.slice(1),'--env-file',path.join(directory,'compose.env'),'-f','deploy/nas/compose.yaml','-f','deploy/nas/compose.media.yaml','config','--format','json'],{cwd:root,timeout:15000})).stdout);
  assert.equal(rendered.services.gateway.environment.LIMEIOT_MEDIA_ORIGIN,origin);assert.equal(rendered.services.gateway.environment.LIMEIOT_MEDIA_DB,'/data/gateway.sqlite.media.json');assert.equal(rendered.services.gateway.ports[0].host_ip,'127.0.0.1');assert.equal(Number(rendered.services.gateway.ports[0].target),mediaPort);assert.ok(rendered.networks.media);assert.equal(rendered.networks.media.internal??false,false);
  const uploaded=(await stack.request(base+'/media-operations',post({type:'media.upload',content_base64:bytes.toString('base64'),retain_seconds:600},'nas-upload'))).value,media=uploaded.result.media;
  const grant=(await stack.request(base+'/media-operations',post({type:'media.grant',media_id:media.media_id,device_id:'device-lamp',expected_binding_revision:binding.revision,valid_for_seconds:300},'nas-grant'))).value;
  const play=async key=>{const response=await stack.request(base+'/commands',post({device_id:'device-lamp',model_revision:model.model_revision,expires_at:new Date(Date.now()+8000).toISOString(),operation:{type:'action.invoke',path:'playback.play',value:{media_id:media.media_id}}},key));assert.equal(response.status,202);await until(async()=>(await stack.request(base+'/commands/'+response.value.command_id)).value.status==='confirmed');return response.value.command_id;};
  const command=await play('before-backup');assert.equal(fixture.effects.length,3);
  const sourceBytes=await readFile(path.join(directory,snapshot)),state=JSON.parse(sourceBytes),privateGrant=state.grants[grant.result.grant_id].grant,oldUrl=`${origin}/media/v1/${privateGrant.grant_id}/${privateGrant.token}.wav`;
  await manage('backup','--directory',directory,'--output',backup);const manifest=JSON.parse(await readFile(path.join(backup,'backup.json'),'utf8'));
  assert.equal(manifest.media_snapshot.included,true);assert.equal(manifest.files[snapshot],createHash('sha256').update(sourceBytes).digest('hex'));assert.deepEqual(await readFile(path.join(backup,snapshot)),sourceBytes);assert.equal(Object.keys(manifest.files).some(name=>name.endsWith('.media.lock')||name.endsWith('.tmp')),false);assert.equal((await stat(path.join(backup,snapshot))).mode&0o777,0o600);
  await stack.request(base+'/media-operations',post({type:'media.delete',media_id:media.media_id},'source-delete'));assert.equal((await fetch(oldUrl)).status,404);
  await manage('restore','--directory',restored,'--backup',backup);assert.deepEqual(await readFile(path.join(restored,snapshot)),sourceBytes);assert.equal(JSON.parse(await readFile(path.join(restored,'installation.json'),'utf8')).media_origin,origin);
  await stop(stack.gateway);fixture.setDatabase(path.join(restored,'data/gateway.sqlite'));
  stack.gateway=stack.launch('restored-media-gateway',path.join(root,'target/debug/limeiot-gateway'),[],{LIMEIOT_DB:path.join(restored,'data/gateway.sqlite'),LIMEIOT_CONFIG:path.join(restored,'config/gateway.json'),LIMEIOT_AUDIO_CONFIG:path.join(restored,'config/audio.json'),LIMEIOT_TOKEN:undefined,LIMEIOT_TOKEN_FILE:path.join(restored,'secrets/owner-token')});await until(async()=>(await stack.request('/healthz')).value.broker_connected);await until(async()=>(await stack.request(base+'/devices/device-lamp')).value.ready);
  const page=(await stack.request(base+'/media')).value;assert.equal(page.items[0].available,true);assert.equal(page.grants[0].active_in_process,false);assert.equal((await fetch(oldUrl)).status,404);assert.equal((await stack.request(base+'/commands/'+command)).value.status,'confirmed');assert.equal(fixture.effects.length,3);
  const original=(await stack.request(base+'/media-operations/by-key/nas-grant')).value;assert.equal(original.operation_id,grant.operation_id);assert.equal(original.result.issued_in_process,false);
  await stack.request(base+'/media-operations',post({type:'media.grant',media_id:media.media_id,device_id:'device-lamp',expected_binding_revision:binding.revision,valid_for_seconds:300},'after-restore-grant'));await play('after-restore-play');assert.equal(fixture.effects.length,6);assert.equal(fixture.renderedPulls.length,2);
  const bad=path.join(parent,'future-backup');await cp(backup,bad,{recursive:true});const future=JSON.parse(await readFile(path.join(bad,snapshot),'utf8'));future.schema_version=3;await writeFile(path.join(bad,snapshot),JSON.stringify(future));const badManifest=JSON.parse(await readFile(path.join(bad,'backup.json'),'utf8'));badManifest.files[snapshot]=createHash('sha256').update(await readFile(path.join(bad,snapshot))).digest('hex');await writeFile(path.join(bad,'backup.json'),JSON.stringify(badManifest));await assert.rejects(manage('restore','--directory',path.join(parent,'refused-future'),'--backup',bad),/invalid_media_snapshot/);await assert.rejects(stat(path.join(parent,'refused-future')),error=>error.code==='ENOENT');
  badManifest.media_snapshot.included=false;await writeFile(path.join(bad,'backup.json'),JSON.stringify(badManifest));await assert.rejects(manage('restore','--directory',path.join(parent,'refused-policy'),'--backup',bad),/incomplete_media_backup/);
  const report={passed:true,compose_rendered:true,configured_existing_installation:true,preserves_audio_config:true,live_media_snapshot_byte_exact:true,manifest_hash:true,restored_new_directory:true,private_permissions:true,old_backup_restores_body:true,old_grant_inactive_after_restore:true,original_receipt_no_regrant:true,no_command_replay:true,new_explicit_grant_playback:true,unsupported_snapshot_and_missing_marker_denied:true,soap_mutations:fixture.effects.length,media_range_pulls:fixture.renderedPulls.length,real_http:true,real_sqlite:true,real_mqtt:true,host_software:true,container_runtime:false,nas_image_rebuilt:false,hardware:false,hardware_status:'用户要求跳过',published:false,full_goal_completed:false};await writeFile(path.join(parent,'nas-media-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(parent,'nas-media-result.json')}));
});

test('NAS媒体origin拒绝公网、凭据、DNS、路径、默认/特权端口与非规范IPv4',async()=>{
  await exec('python3',['-c',`from media_state import media_origin
assert media_origin('http://192.168.1.2:17882') == 17882
for value in ['https://192.168.1.2:17882','http://example.org:17882','http://8.8.8.8:17882','http://169.254.1.1:17882','http://192.168.1.2:80','http://192.168.1.2:17882/','http://user@192.168.1.2:17882','http://192.168.001.2:17882','http://192.168.1.2:17882?x=1']:
 try: media_origin(value)
 except ValueError: pass
 else: raise AssertionError(value)`],{cwd:path.join(root,'deploy/nas'),timeout:10000});
});
