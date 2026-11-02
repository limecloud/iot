#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const catalog=JSON.parse(await readFile(new URL('../../../contracts/tools/catalog.json',import.meta.url),'utf8'));
const exits={unauthenticated:3,forbidden:3,idempotency_conflict:4,unsupported_capability:4,device_offline:4};
const fail=(code,status=2)=>{console.error(JSON.stringify({error:{code}}));process.exitCode=status;};
const registryOperation=process.argv[2]==='invoke'?process.argv[3]:`${process.argv[2]}.${process.argv[3]}`;
if(process.argv[2]==='ota') {
  await (await import('./ota.mjs')).runOta(process.argv.slice(3));
} else if(process.argv[2]==='model') {
  await (await import('./model.mjs')).runModel(process.argv.slice(3));
} else if(process.argv[2]==='control') {
  await (await import('./control.mjs')).runControl(process.argv.slice(3));
} else if(['model-trusts.list','model-trusts.get','model-installations.list','model-installations.get','device-models.get','model-changes.create','model-changes.resolve','firmware-trusts.list','firmware-trusts.get','ota-tasks.list','ota-tasks.get','ota-changes.create','ota-changes.resolve','execution-adapters.list','execution-bindings.get','device-applications.list','execution-changes.create','execution-changes.resolve'].includes(registryOperation)) {
  await (await import('./registry.mjs')).runRegistry(process.argv.slice(2));
} else try {
  const {values:flags,positionals}=parseArgs({allowPositionals:true,options:{'space-id':{type:'string'},input:{type:'string'},id:{type:'string'},'idempotency-key':{type:'string'},after:{type:'string'},cursor:{type:'string'},json:{type:'boolean'},endpoint:{type:'string'}}});
  if(positionals[0]==='schema') {
    const operation=positionals[1];
    const selected=catalog.operations.find(item=>item.operation_id===operation);
    if(operation&&!selected) throw new Error('unsupported_operation');
    console.log(JSON.stringify(operation?{...selected,schemas:catalog.schemas}:catalog));
  } else {
    const operationID=positionals[0]==='invoke'?positionals[1]:`${positionals[0]}.${positionals[1]}`;
    const operation=catalog.operations.find(item=>item.operation_id===operationID);
    if(!operation) throw new Error('unsupported_operation');
    if(operation.space_required&&!flags['space-id']) throw new Error('space_id_required');
    const resource=flags.id??positionals[2];
    if(operation.path.includes('{id}')&&!resource) throw new Error('resource_id_required');
    if(operation.input_schema&&!flags.input) throw new Error('input_required');
    const endpoint=new URL(flags.endpoint??process.env.LIMEIOT_ENDPOINT??'http://127.0.0.1:17880');
    if(!(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash) throw new Error('secure_endpoint_required');
    if(process.env.LIMEIOT_TOKEN&&process.env.LIMEIOT_TOKEN_FILE)throw new Error('ambiguous_token_configuration');
    const token=process.env.LIMEIOT_TOKEN??(process.env.LIMEIOT_TOKEN_FILE?(await readFile(process.env.LIMEIOT_TOKEN_FILE,'utf8')).trim():undefined);if(!token) {fail('unauthenticated',3);} else {
      const path=operation.path.replace('{space_id}',encodeURIComponent(flags['space-id']??'')).replace('{id}',encodeURIComponent(resource??''));
      const url=new URL(path,endpoint);if(flags.after!==undefined)url.searchParams.set('after',flags.after);
      if(flags.cursor!==undefined)url.searchParams.set('cursor',flags.cursor);
      const headers={Authorization:`Bearer ${token}`};
      let body;
      if(flags.input) {
        const input=JSON.parse(await readFile(flags.input,'utf8'));
        if(['commands.create','drafts.create','control-pairings.create'].includes(operationID)) {
          if(input.space_id&&input.space_id!==flags['space-id']) throw new Error('space_mismatch');
          const key=flags['idempotency-key']??input.idempotency_key;
          if(!key || (flags['idempotency-key']&&input.idempotency_key&&flags['idempotency-key']!==input.idempotency_key)) throw new Error('invalid_idempotency_key');
          headers['Idempotency-Key']=key;delete input.space_id;delete input.idempotency_key;
        }
        body=JSON.stringify(input);headers['Content-Type']='application/json';
      }
      const response=await fetch(url,{method:operation.method,headers,body,redirect:'error',signal:operationID==='events.stream'?undefined:AbortSignal.timeout(10000)});
      if(operationID==='events.stream'&&response.ok) {
        const decoder=new TextDecoder();let pending='';
        for await (const chunk of response.body) {
          pending+=decoder.decode(chunk,{stream:true});
          let end;
          while((end=pending.indexOf('\n\n'))>=0) {
            const frame=pending.slice(0,end).replaceAll('\r','');pending=pending.slice(end+2);
            for(const line of frame.split('\n')) if(line.startsWith('data: ')) console.log(line.slice(6));
          }
        }
      } else {
        const value=await response.json();
        if(!response.ok) {fail(value.error?.code??'request_failed',exits[value.error?.code]??(response.status>=500?5:2));}
        else {console.log(JSON.stringify(value));if(value.status==='unknown')process.exitCode=6;else if(['failed','rejected','expired'].includes(value.status))process.exitCode=7;}
      }
    }
  }
} catch(error) {fail(error.name==='AbortError'||error.name==='TimeoutError'?'operation_unknown':error.message,error.name==='TimeoutError'?6:2);}
