import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { root, startStack, stop, freePort, until } from '../../tools/dev-stack.mjs';
import { rendererFixture } from './dlna.mjs';
const exec = promisify(execFile);
export function pcmWav() {
  const bytes=Buffer.alloc(32044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
  for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE((i%500)-250,i);return bytes;
}
export async function mediaStack(t, prefix='media-client-', options={}) {
  const directory=options.directory??await mkdtemp(path.join(root,'.dev/'+prefix)),bytes=pcmWav();
  const fixture=await rendererFixture(path.join(directory,'gateway.sqlite'),{expectedMedia:bytes});t.after(()=>fixture.close());fixture.config.media=[];fixture.config.managed_media=true;
  const modelPath=path.join(root,'contracts/models/dlna-speaker.json');
  const model=JSON.parse((await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',modelPath],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')},timeout:5000})).stdout);assert.equal(model.valid,true);
  const config=JSON.parse(await readFile(path.join(root,'deploy/dev/config.json'),'utf8'));config.models[0]=model.normalized_model;config.devices[0].model_revision=model.model_revision;delete config.devices[0].routes;
  const configPath=path.join(directory,'config.json'),audioPath=path.join(directory,'audio.json'),mediaPort=options.mediaPort??await freePort();
  await writeFile(configPath,JSON.stringify(config));await writeFile(audioPath,JSON.stringify({schema_version:1,bindings:[{device_id:'device-lamp',adapter_id:'speaker-dlna',config:fixture.config}]}));
  const stack=await startStack({directory,credentials:options.credentials,modelPaths:{lamp:modelPath},gatewayEnv:{LIMEIOT_CONFIG:configPath,LIMEIOT_AUDIO_CONFIG:audioPath,LIMEIOT_MEDIA_LISTEN:`127.0.0.1:${mediaPort}`,LIMEIOT_MEDIA_ORIGIN:`http://127.0.0.1:${mediaPort}`}});t.after(()=>stack.close());await stop(stack.lamp);
  async function bindSpeaker() {
    const base='/api/v1/spaces/space-demo',initial=(await stack.request(base+'/devices/device-lamp/execution-binding')).value,offers=(await stack.request(base+'/execution-adapters')).value;
    const result=await stack.request(base+'/execution-operations',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'bind-speaker'},body:JSON.stringify({type:'bindings.bind',device_id:'device-lamp',expected_binding_revision:initial.revision,expected_model_revision:model.model_revision,route:offers.items[0].route})});assert.equal(result.value.status,'applied');await until(async()=>(await stack.request(base+'/devices/device-lamp')).value.ready);return result.value.result;
  }
  return {directory,bytes,fixture,stack,model,mediaPort,bindSpeaker};
}
