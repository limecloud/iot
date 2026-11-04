import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { freePort,startStack,until } from '../../tools/dev-stack.mjs';
import { documentDigest } from '../../packages/protocol/model-validation.mjs';
export const base='/api/v1/spaces/space-demo';
export const post=(body,key)=>({method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});
export const input=()=>({instructions:'用简短中文回答。不要保存暗号石榴。',messages:[{role:'user',content:'我喜欢积木。'},{role:'assistant',content:'你喜欢搭什么？'},{role:'user',content:'我刚才说喜欢什么？'}],retain_seconds:600,expires_at:new Date(Date.now()+60000).toISOString()});
export async function textStack(t,options={}) {
  const calls=[],holds=[],errors=[];let mode='ok',directory;
  const text='你刚才说喜欢积木。';
  const provider=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      assert.equal(req.url,'/api/chat');assert.equal(req.headers.authorization,undefined);
      const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.model,'fixture:text');assert.equal(body.stream,false);assert.equal(body.keep_alive,0);assert.equal(body.tools,undefined);
      assert.deepEqual(body.options,{num_ctx:4096,num_predict:1024,temperature:0});assert.equal(body.messages[0].role,'system');
      const hasInstructions=body.messages[1]?.role==='system';
      const context={instructions:hasInstructions?body.messages[1].content:'',messages:body.messages.slice(hasInstructions?2:1)};
      const contextDigest=await documentDigest(context);
      const raw=await readFile(path.join(directory,'gateway.sqlite.media.json'),'utf8'),disk=JSON.parse(raw);
      assert.equal(disk.schema_version,5);assert.ok(Object.values(disk.texts).some(task=>task.status==='running'&&task.input.context_digest===contextDigest));
      if(context.instructions)assert.equal(raw.includes(context.instructions),false);assert.equal(raw.includes(context.messages.at(-1).content),false);
      calls.push({context_digest:contextDigest,message_count:context.messages.length,durable_before_provider:true});
      const reply={model:'fixture:text',done:true,done_reason:'stop',message:{role:'assistant',content:text},prompt_eval_count:25,eval_count:8};
      const respond=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));};
      if(mode==='hold')holds.push(respond);
      else if(mode==='lost')req.socket.destroy();
      else if(mode==='redirect'){res.writeHead(302,{Location:'/never-follow'});res.end();}
      else if(mode==='reject'){res.writeHead(422);res.end();}
      else if(mode==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});res.end(' '.repeat(65537));}
      else if(mode==='duplicate'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"done":true,"done":false}');}
      else {if(mode==='tool')reply.message.tool_calls=[{function:{name:'commands.create',arguments:{}}}];if(mode==='truncated')reply.done_reason='length';if(mode==='model')reply.model='another:text';if(mode==='invalid')reply.message.content='x'.repeat(2049);if(mode==='usage')reply.eval_count=1025;respond();}
    } catch(error){errors.push(error.message);res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const port=await freePort();
  const stack=await startStack({...options,gatewayEnv:{...options.gatewayEnv,LIMEIOT_MEDIA_LISTEN:`127.0.0.1:${port}`,LIMEIOT_MEDIA_ORIGIN:`http://127.0.0.1:${port}`,LIMEIOT_TEXT_URL:`http://127.0.0.1:${provider.address().port}`,LIMEIOT_TEXT_MODEL:'fixture:text',LIMEIOT_TEXT_CA_FILE:''}});t.after(()=>stack.close());directory=stack.directory;
  const finish=key=>until(async()=>{const r=await stack.request(base+'/text-generations/by-key/'+key);return r.status===200&&r.value.status!=='running'&&r.value;});
  return {stack,directory,calls,holds,errors,text,finish,setMode(value){mode=value;}};
}
