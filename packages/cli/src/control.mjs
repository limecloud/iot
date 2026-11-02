import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createPrivate, readPrivate, clearSession, privateDirectory, writePrivate, readPrivateToken } from './control-files.mjs';

import { parseDraftJSON, validProduct, validProductOperation } from '../../protocol/products.mjs';
import { verifyModelReport } from '../../protocol/model-validation.mjs';
import { parseComparisonJSON, verifyComparisonReport } from '../../protocol/model-compatibility.mjs';
import { parsePublishInput, verifyPublisher, verifyPublication, verifyPublishOperation } from '../../protocol/model-publication.mjs';
import { verifyConfirmedReceipt } from '../../protocol/command-receipts.mjs';

const catalog=JSON.parse(await readFile(new URL('../../../contracts/tools/control.json',import.meta.url),'utf8'));
const known=new Set(['authentication_required','identity_rejected','identity_unavailable','forbidden','csrf_rejected','origin_rejected','host_rejected','not_found','invalid_request','invalid_expiry','gateway_offline','remote_capacity_reached','idempotency_conflict','rate_limited','storage_unavailable','gateway_already_bound','remote_gateway_error','remote_authorization_rejected','remote_authorization_expired','cli_session_not_delegatable','invalid_draft_document','invalid_comparison_document','product_capacity_reached','validator_unavailable','release_signer_unavailable','publication_store_unavailable','release_capacity_reached']);
const terminal=new Set(['confirmed','failed','rejected','expired']);
const error=(code,exit=2)=>Object.assign(new Error(code),{safeCode:code,exit});
const hash=value=>createHash('sha256').update(value).digest('hex');
function origin(value){let url;try{url=new URL(value)}catch{throw error('secure_endpoint_required')}
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.pathname!=='/'||url.search||url.hash||value!==url.origin)throw error('secure_endpoint_required');return url.origin;
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value}
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function check(value,schema){
  if(schema.oneOf){let matches=0;for(const option of schema.oneOf){try{check(value,option);matches++}catch{}}if(matches!==1)throw error('invalid_input');return}
  if(schema.type==='null'&&value!==null)throw error('invalid_input');
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw error('invalid_input');
    for(const name of schema.required??[])if(!Object.hasOwn(value,name))throw error('invalid_input');
    for(const [key,item]of Object.entries(value)){const child=Object.hasOwn(schema.properties??{},key)?schema.properties[key]:undefined;if(!child&&schema.additionalProperties===false)throw error('invalid_input');if(child)check(item,child)}
  }
  if(schema.type==='string'&&(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern).test(value)))throw error('invalid_input');
  if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity)||schema.uniqueItems&&new Set(value).size!==value.length)throw error('invalid_input');
    for(const item of value)if(schema.items)check(item,schema.items);
  }
  if('const'in schema&&!same(value,schema.const)||schema.enum&&!schema.enum.some(item=>same(item,value)))throw error('invalid_input');
  if(schema.format==='date-time'&&(typeof value!=='string'||!Number.isFinite(Date.parse(value))))throw error('invalid_input');
}
function material(value){
  if(value?.version!==1||value.audience!=='console'||!/^[a-f0-9]{64}$/.test(value.session??'')||!/^p-[a-f0-9]{64}$/.test(value.principal_id??'')||!Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=Date.now())throw error('session_invalid_or_expired',3);
  origin(value.origin);return value;
}
async function validRemote(value,input){
  if(!input||!value?.request||!/^remote-[a-f0-9]{64}$/.test(value.remote_id??'')||!['unknown','accepted','dispatched',...terminal].includes(value.status)||!same({...value.request,expires_at:Date.parse(value.request.expires_at)},{...input,expires_at:Date.parse(input.expires_at)}))return false;
  if(value.status==='confirmed')try{await verifyConfirmedReceipt(value.local_result,{space_id:value.local_space_id,idempotency_key:value.remote_id,device_id:input.device_id,model_revision:input.model_revision,expires_at:input.expires_at,operation:input.operation})}catch{return false}
  return true;
}
async function request(endpoint,resource,{session,csrf,input}={}){
  const headers={};if(session)headers.Cookie=`${endpoint.startsWith('https:')?'__Host-':''}limeiot_console=${session}`;
  if(input!==undefined){headers.Origin=endpoint;headers['Content-Type']='application/json';if(csrf)headers['X-CSRF-Token']=csrf}
  let response;try{response=await fetch(endpoint+resource,{method:input===undefined?'GET':'POST',headers,body:input===undefined?undefined:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(12000)})}catch{throw error('network_unavailable',5)}
  let body;try{const raw=await response.text();if(raw.length>1048576)throw new Error();body=JSON.parse(raw)}catch{throw error('invalid_response',5)}
  if(!response.ok){const code=known.has(body.error?.code)?body.error.code:'request_failed';throw error(code,response.status===401||response.status===403?3:response.status===409?4:response.status>=500?5:2)}
  return {body,cookies:response.headers.getSetCookie()};
}
async function current(value){const {body}=await request(value.origin,'/api/console/v1/auth/session',{session:value.session});if(body.audience!=='console'||body.principal?.principal_id!==value.principal_id||!/^[a-f0-9]{64}$/.test(body.csrf_token??''))throw error('session_identity_changed',3);return body}

export async function runControl(args){
  let original;
  try{
    const {values:flags,positionals:p}=parseArgs({args,allowPositionals:true,options:{endpoint:{type:'string'},'session-file':{type:'string'},'token-file':{type:'string'},input:{type:'string'},output:{type:'string'},'space-id':{type:'string'},id:{type:'string'},after:{type:'string'},json:{type:'boolean'}}});
    const id=p[0]==='invoke'?p[1]:`${p[0]}.${p[1]}`;
    if(p[0]==='schema'){
      const op=p[1]&&catalog.operations.find(v=>v.operation_id===p[1]);if(p[1]&&!op)throw error('unsupported_operation');console.log(JSON.stringify(op?{...op,schemas:catalog.schemas}:catalog));return;
    }
    const sessionFile=path.resolve(flags['session-file']??process.env.LIMEIOT_CONTROL_SESSION_FILE??'');if(!flags['session-file']&&!process.env.LIMEIOT_CONTROL_SESSION_FILE)throw error('session_file_required');
    if(id==='auth.login'||id==='auth.import'){
      await privateDirectory(path.dirname(sessionFile),true);
      // 独占占位必须先成功，避免会话产生后发现目标不可写；失败也不覆盖旧凭据。
      await createPrivate(sessionFile,{login_pending:true});let value;
      if(id==='auth.import'){
        if(!flags.input||!flags.endpoint)throw error('input_and_endpoint_required');value=material(await readPrivate(path.resolve(flags.input)));if(value.origin!==origin(flags.endpoint))throw error('session_origin_mismatch');await current(value);
      }else{
        if(!flags['token-file']||!flags.endpoint)throw error('token_file_and_endpoint_required');const endpoint=origin(flags.endpoint);
        const token=await readPrivateToken(path.resolve(flags['token-file']));
        const {cookies}=await request(endpoint,'/api/console/v1/auth/local',{input:{token}});
        const name=`${endpoint.startsWith('https:')?'__Host-':''}limeiot_console=`;
        const raw=cookies.find(v=>v.startsWith(name))?.slice(name.length).split(';')[0];if(!/^[a-f0-9]{64}$/.test(raw??''))throw error('invalid_session_response',5);
        const {body}=await request(endpoint,'/api/console/v1/auth/session',{session:raw});
        value=material({version:1,origin:endpoint,audience:'console',session:raw,principal_id:body.principal?.principal_id,expires_at:body.expires_at});
      }
      await writePrivate(sessionFile,value);console.log(JSON.stringify({authenticated:true,origin:value.origin,audience:'console',principal_id:value.principal_id,expires_at:value.expires_at}));return;
    }
    const value=material(await readPrivate(sessionFile));if(flags.endpoint&&origin(flags.endpoint)!==value.origin)throw error('session_origin_mismatch');
    const auth=await current(value),call=(resource,input)=>request(value.origin,resource,{session:value.session,csrf:auth.csrf_token,input}).then(v=>v.body);
    if(id==='auth.status'){console.log(JSON.stringify({principal:auth.principal,audience:auth.audience,expires_at:auth.expires_at}));return}
    if(id==='auth.logout'){await call('/api/console/v1/auth/logout',{});await clearSession(sessionFile);console.log(JSON.stringify({logged_out:true}));return}
    const op=catalog.operations.find(item=>item.operation_id===id);if(!op)throw error('unsupported_operation');
    const space=flags['space-id'],resource=flags.id??p[2];if(op.space_required&&!/^[A-Za-z0-9_-]{1,128}$/.test(space??''))throw error('space_id_required');
    if(op.path.includes('{id}')&&(!resource||resource.length>128))throw error('resource_id_required');
    let input;if(op.input_schema){if(!flags.input)throw error('input_required');const raw=await readFile(flags.input,'utf8');if(raw.length>(id==='models.compare'?16416:16384))throw error('invalid_input');try{input=id==='releases.create'?parsePublishInput(raw):id==='models.compare'?parseComparisonJSON(raw):(id.startsWith('products.')||id==='models.validate')?parseDraftJSON(raw,true):JSON.parse(raw)}catch{throw error('invalid_input')}check(input,catalog.schemas[op.input_schema])}else if(op.method==='POST')input={};
    let url=op.path.replace('{space_id}',encodeURIComponent(space??'')).replace('{id}',encodeURIComponent(resource??''));if(flags.after!==undefined){if(!op.pagination)throw error('unsupported_pagination');url+='?after='+encodeURIComponent(flags.after)}
    if(op.sensitive_output&&!flags.output)throw error('private_output_required');
    let existing=false;
    if(op.original_request){
      const recordDir=path.join(path.dirname(sessionFile),'operations'),recordFile=path.join(recordDir,hash([value.origin,value.principal_id,space??'',id,input.request_key].join('\n'))+'.json');
      original={operation_id:id,request_key:input.request_key,space_id:space??null,record_file:recordFile,recovery_operation:op.recovery_operation};
      const record={version:1,origin:value.origin,principal_id:value.principal_id,operation_id:id,space_id:space??null,...(id.startsWith('products.')||id==='releases.create'?{product_id:resource??null}:{}),input};
      try{await createPrivate(recordFile,record)}catch(e){
        if(e.code!=='EEXIST')throw error('original_record_unavailable',5);
        let saved;try{saved=await readPrivate(recordFile)}catch{throw error('original_record_unavailable',5)}
        if(!same(saved,record))throw error('idempotency_conflict',4);existing=true;
      }
    }
    if(op.sensitive_output)await createPrivate(path.resolve(flags.output),{pending:true});
    let result;
    try{
      // 旧命令、草稿与发布请求只查询原键；即使404也不自动补发POST。
      result=existing&&id==='releases.create'?await call(`/api/console/v1/release-operations/by-key/${encodeURIComponent(input.request_key)}`):existing&&id.startsWith('products.')?await call(`/api/console/v1/product-operations/by-key/${encodeURIComponent(input.request_key)}`):existing&&id==='commands.create'?await call(`/api/console/v1/spaces/${encodeURIComponent(space)}/remote-commands/by-key/${encodeURIComponent(input.request_key)}`):await call(url,input);
    }catch(e){if(['products.resolve','releases.resolve'].includes(id)&&e.safeCode==='not_found')throw error('operation_unknown',6);if(op.original_request&&['network_unavailable','invalid_response','storage_unavailable','request_failed','validator_unavailable','release_signer_unavailable','publication_store_unavailable',...(!id.startsWith('products.')&&id!=='releases.create'?['idempotency_conflict']:[]),...(existing?['not_found']:[])].includes(e.safeCode))throw error('operation_unknown',6);throw e}
    if(id==='publisher.get'){try{await verifyPublisher(result,value.principal_id)}catch{throw error('invalid_response',5)}}
    if(id.startsWith('releases.')) {
      try {
        if(id==='releases.create'||id==='releases.resolve') {
          await verifyPublishOperation(result,value.principal_id,id==='releases.create'?{product_id:resource,request:input}:undefined);
          if(id==='releases.resolve'&&result.request.request_key!==resource)throw new Error();
        } else if(id==='releases.get')await verifyPublication(result,{release_id:resource});
        else if(id==='releases.head') {
          if(!result||Object.keys(result).join(',')!=='release')throw new Error();
          if(result.release!==null)await verifyPublication(result.release,{product_id:resource,principal:value.principal_id});
        } else if(id==='releases.list') {
          if(!result||!Array.isArray(result.items)||result.items.length>16||result.next!==null&&result.next!==result.items.at(-1)?.artifact.statement.release_id)throw new Error();
          for(let i=0;i<result.items.length;i++) {
            const item=await verifyPublication(result.items[i],{product_id:resource,principal:value.principal_id});
            if(item.artifact.statement.release_id<=(result.items[i-1]?.artifact.statement.release_id??flags.after??''))throw new Error();
          }
        }
      } catch {throw error('operation_unknown',6)}
    }
    if(id.startsWith('commands.')&&(!await validRemote(result,id==='commands.create'?input:result.request)||result.space_id!==space||result.principal_id!==value.principal_id||(id==='commands.resolve'&&result.request.request_key!==resource)||(['commands.get','commands.reconcile'].includes(id)&&result.remote_id!==resource)))throw error('operation_unknown',6);
    if(id==='products.get'&&(!validProduct(result,value.principal_id)||result.product_id!==resource))throw error('operation_unknown',6);
    if(id==='products.list'&&(!Array.isArray(result.items)||result.items.length>16||!result.items.every(item=>validProduct(item,value.principal_id))||result.next!==null&&!/^product-[a-f0-9]{64}$/.test(result.next??'')))throw error('operation_unknown',6);
    if(['products.create','products.save','products.resolve'].includes(id)&&(!validProductOperation(result,value.principal_id,id==='products.resolve'?undefined:{kind:id,product_id:resource??null,request:input})||id==='products.resolve'&&result.request.request_key!==resource))throw error('operation_unknown',6);
    if(op.sensitive_output){await writePrivate(path.resolve(flags.output),result);result={pairing:result.pairing,control_origin:result.control_origin,output_file:path.resolve(flags.output)}}
    if(id==='models.validate'){try{await verifyModelReport(result,input.model)}catch{throw error('invalid_response',5)}console.log(JSON.stringify(result));process.exitCode=result.valid?0:2;return}
    if(id==='models.compare'){try{await verifyComparisonReport(result,input)}catch{throw error('invalid_response',5)}console.log(JSON.stringify(result));process.exitCode=result.compatible===true?0:2;return}
    console.log(JSON.stringify({...result,...(original?{cli:original}:{})}));if(result.status==='conflict')process.exitCode=4;else if(result.status==='unknown')process.exitCode=6;else if(terminal.has(result.status)&&result.status!=='confirmed')process.exitCode=7;
  }catch(e){const code=e.safeCode??(e.code==='EEXIST'?'private_file_exists':['private_directory_required','private_file_required'].includes(e.code)?e.code:'local_file_unavailable');console.error(JSON.stringify({error:{code},...(original?{original}:{})}));process.exitCode=e.exit??5}
}
