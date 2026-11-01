import { spawn } from 'node:child_process';
import { randomBytes,pbkdf2Sync } from 'node:crypto';
import { mkdir,writeFile,access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

export const root=fileURLToPath(new URL('../',import.meta.url));
export async function freePort() {const server=net.createServer();await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
export async function until(check,timeout=10000) {const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await check();if(last)return last;}catch{}await delay(100);}throw new Error('readiness_timeout');}
export async function stop(child) {if(!child||child.exitCode!==null||child.signalCode)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGINT');await Promise.race([exited,delay(4000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}
export async function startStack({directory,apiPort,mqttPort,dropResults=false,credentials,firmware=false,firmwareStoreFailure=0,gatewayEnv={}}={}) {
  directory??=path.join(root,'.dev',`run-${Date.now()}-${randomBytes(4).toString('hex')}`);await mkdir(directory,{recursive:true});
  apiPort??=await freePort();mqttPort??=await freePort();
  const brokerBinary=process.env.LIMEIOT_MOSQUITTO??path.join(root,'.dev/tools/mosquitto-build/src/mosquitto');
  await access(brokerBinary);
  const token=credentials?.owner??randomBytes(32).toString('hex'),password=credentials?.gateway??randomBytes(32).toString('hex');
  const devicePasswords={'device-lamp':credentials?.lamp??password,'device-button':credentials?.button??password};
  const env={...process.env,LIMEIOT_TOKEN:token,LIMEIOT_MQTT_PASSWORD:password,LIMEIOT_MQTT_HOST:'127.0.0.1',LIMEIOT_MQTT_PORT:String(mqttPort),LIMEIOT_LISTEN:`127.0.0.1:${apiPort}`,LIMEIOT_ENDPOINT:`http://127.0.0.1:${apiPort}`,LIMEIOT_PUBLIC_ORIGIN:`http://127.0.0.1:${apiPort}`,LIMEIOT_CONFIG:path.join(root,'deploy/dev/config.json'),LIMEIOT_DB:path.join(directory,'gateway.sqlite'),...gatewayEnv};
  delete env.LIMEIOT_TOKEN_FILE;
  const passwordLines=['gateway','device-lamp','device-button'].map(user=>{const salt=randomBytes(12),hash=pbkdf2Sync(user==='gateway'?password:devicePasswords[user],salt,101,64,'sha512');return `${user}:$7$101$${salt.toString('base64')}$${hash.toString('base64')}`;});
  await writeFile(path.join(directory,'passwords'),passwordLines.join('\n')+'\n',{mode:0o600});
  await writeFile(path.join(directory,'acl'),['user gateway','topic read limeiot/v1/space-demo/+/up/+','topic write limeiot/v1/space-demo/+/down/+',...['device-lamp','device-button'].flatMap(user=>[`user ${user}`,`topic read limeiot/v1/space-demo/${user}/down/+`,`topic write limeiot/v1/space-demo/${user}/up/+`])].join('\n')+'\n');
  await writeFile(path.join(directory,'mosquitto.conf'),`listener ${mqttPort} 127.0.0.1\nallow_anonymous false\npassword_file ${path.join(directory,'passwords')}\nacl_file ${path.join(directory,'acl')}\npersistence false\nmax_packet_size 17000\nmax_queued_messages 100\n`);
  await writeFile(path.join(directory,'session.env'),Object.entries(env).filter(([key])=>key.startsWith('LIMEIOT_')).map(([key,value])=>`export ${key}='${String(value).replaceAll("'","'\\''")}'`).join('\n')+'\n',{mode:0o600});
  const children=[];
  const launch=(name,command,args,extra={})=>{
    const child=spawn(command,args,{cwd:root,env:{...env,...extra},stdio:['pipe','pipe','pipe']});
    const log=createWriteStream(path.join(directory,`${name}.log`),{flags:'a'});child.stdout.pipe(log);child.stderr.pipe(log);child.once('exit',()=>log.end());children.push(child);return child;
  };
  const request=async(resource,options={})=>{const response=await fetch(new URL(resource,env.LIMEIOT_ENDPOINT),{...options,headers:{Authorization:`Bearer ${token}`,...options.headers},signal:AbortSignal.timeout(2000)});const value=await response.json();return {status:response.status,value};};
  const stack={env,directory,children,launch,request,async close(){await Promise.all(children.map(stop));},async restartGateway(){await stop(stack.gateway);stack.gateway=launch('gateway',path.join(root,'target/debug/limeiot-gateway'),[]);await until(async()=>{const r=await request('/healthz');return r.value.broker_connected;});}};
  const device=(name,extra={})=>launch(name,firmware?path.join(root,'.dev/firmware-host/host-device'):path.join(root,'target/debug/limeiot-simulator'),firmware?[`device-${name}`,name,path.join(directory,`firmware-${name}`)]:[`device-${name}`,`contracts/models/${name}.json`,path.join(directory,`${name}.json`)],{LIMEIOT_SIM_DROP_RESULTS:dropResults?'1':'0',LIMEIOT_MQTT_PASSWORD:devicePasswords[`device-${name}`],LIMEIOT_FIRMWARE_FAIL_STORE:String(firmwareStoreFailure),...extra});
  stack.restartDevice=async(name,extra={})=>{if(!['lamp','button'].includes(name))throw new Error('invalid device');const previous=(await request(`/api/v1/spaces/space-demo/devices/device-${name}`)).value.boot_id;await stop(stack[name]);stack[name]=device(name,extra);await until(async()=>{const r=await request(`/api/v1/spaces/space-demo/devices/device-${name}`);return r.value.ready&&r.value.boot_id!==previous;});};
  try {
    stack.broker=launch('broker',brokerBinary,['-c',path.join(directory,'mosquitto.conf')]);
    await until(()=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:mqttPort});socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));}));
    await stack.restartGateway();
    stack.lamp=device('lamp');
    stack.button=device('button');
    await until(async()=>{const r=await request('/api/v1/spaces/space-demo/devices');return r.value.items?.length===2&&r.value.items.every(device=>device.ready);});
    return stack;
  } catch(error) {await stack.close();throw new Error(`${error.message}; logs: ${directory}`);}
}
