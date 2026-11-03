import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, startStack, until } from '../tools/dev-stack.mjs';

const exec=promisify(execFile),prefix='/api/v1/spaces/space-demo';
const variants=[{name:'native',features:[],models:0},{name:'android-tv',features:['android-tv'],models:4},
  {name:'dlna',features:['dlna'],models:1},{name:'standard',features:['android-tv','dlna'],models:5}];

test('可选集成发行组合：真实网关、MQTT、原生命令及SQLite恢复', {timeout:600000},async t=>{
  const directory=await mkdtemp(path.join(root,'.dev/integration-distribution-'));
  t.diagnostic('evidence: '+directory);
  const results=[];
  for(const variant of variants) {
    const flags=['--locked','-p','limeiot-gateway','--no-default-features',
      ...(variant.features.length?['--features',variant.features.join(',')]:[])];
    for(const [command,args] of [['clippy',[...flags,'--','-D','warnings']],['build',flags]]) {
      const result=await exec('cargo',[command,...args],{cwd:root,timeout:180000,maxBuffer:4*1024*1024});
      await writeFile(path.join(directory,`${variant.name}-${command}.log`),result.stdout+result.stderr);
    }
    // 未配置适配器时不接触任何外部设备；MQTT设备均是本任务模拟进程。
    const stack=await startStack({directory:path.join(directory,variant.name),
      gatewayEnv:{LIMEIOT_TV_CONFIG:undefined,LIMEIOT_AUDIO_CONFIG:undefined}});
    try {
      const catalog=(await stack.request(prefix+'/model-bundles')).value.items;
      assert.equal(catalog.length,variant.models);
      assert.equal(catalog.filter(item=>item.model.model_id.includes('android-tv')).length,
        variant.features.includes('android-tv')?4:0);
      assert.equal(catalog.filter(item=>item.model.model_id.includes('dlna')).length,
        variant.features.includes('dlna')?1:0);
      assert.deepEqual((await stack.request(prefix+'/execution-adapters')).value,{items:[],next_cursor:null});
      const device=(await stack.request(prefix+'/devices/device-lamp')).value;
      const body={device_id:device.device_id,model_revision:device.model_revision,
        expires_at:new Date(Date.now()+5000).toISOString(),operation:{type:'property.set',path:'light.power',value:false}};
      const options={method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'native-command'},body:JSON.stringify(body)};
      const created=await stack.request(prefix+'/commands',options);
      assert.equal(created.status,202);
      await until(async()=>(await stack.request(prefix+'/commands/'+created.value.command_id)).value.status==='confirmed');
      assert.equal((await stack.request(prefix+'/devices/device-lamp')).value.reported['light.power'].value,false);
      await stack.restartGateway();
      const original=(await stack.request(prefix+'/commands',options)).value;
      assert.equal(original.command_id,created.value.command_id);
      assert.equal(original.status,'confirmed');
      assert.equal((await stack.request(prefix+'/commands')).value.items.length,1);
      for(const [feature,key] of [['android-tv','LIMEIOT_TV_CONFIG'],['dlna','LIMEIOT_AUDIO_CONFIG']]) {
        if(variant.features.includes(feature))continue;
        await assert.rejects(exec(path.join(root,'target/debug/limeiot-gateway'),[],{
          cwd:root,env:{...stack.env,[key]:path.join(directory,'unused-config.json')},timeout:5000}),
        error=>/integration_not_enabled/.test(error.stderr));
      }
      results.push({...variant,passed:true,native_command:true,restart_original_only:true,disabled_configuration_rejected:true});
    } finally { await stack.close(); }
  }
  await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,variants:results,
    real_gateway:true,real_mqtt:true,real_sqlite:true,simulated_devices:true,hardware:false,full_goal_completed:false},null,2)+'\n');
});
