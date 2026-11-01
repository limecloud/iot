import { root,startStack } from './dev-stack.mjs';
const stack=await startStack({directory:`${root}.dev/local`,apiPort:17880,mqttPort:18884});
console.log(JSON.stringify({status:'ready',mode:'loopback_simulation',endpoint:stack.env.LIMEIOT_ENDPOINT,environment:`${stack.directory}/session.env`,button_input:'输入 button 并回车发送模拟按键事件'}));
process.stdin.setEncoding('utf8');
process.stdin.on('data',line=>{if(line.trim()==='button')stack.button.stdin.write(JSON.stringify({data:{count:1}})+'\n');});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await stack.close();process.exit(0);});
