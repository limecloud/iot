import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir,readFile,writeFile,stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { ControlTerminal } from '../packages/cli/src/control-tui.mjs';
import { executeControl } from '../packages/cli/src/control.mjs';
import { root } from '../tools/dev-stack.mjs';

const exec=promisify(execFile),hex=()=>randomBytes(32).toString('hex');
async function fixture(run) {
  const directory=path.join(root,'.dev','control-tui-'+randomBytes(8).toString('hex'));await mkdir(directory,{mode:0o700});
  const sessionFile=path.join(directory,'session.json'),principal='p-'+hex(),csrf=hex(),remote='remote-'+hex(),records=new Map();
  let token=hex(),posts=0,lost=false,denied=false,name='家庭';
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const reply=(value,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};
    if(req.headers.cookie!=='limeiot_console='+token||denied)return reply({error:{code:'authentication_required'}},401);
    if(req.url==='/api/console/v1/auth/session')return reply({audience:'console',principal:{principal_id:principal},csrf_token:csrf,expires_at:new Date(Date.now()+300000).toISOString()});
    if(req.method==='GET') {
      if(req.url==='/api/console/v1/spaces')return reply({items:[{space_id:'space',name}]});
      if(req.url.startsWith('/api/console/v1/spaces/space/remote-commands/by-key/')) {
        const key=decodeURIComponent(req.url.split('/').at(-1));return records.has(key)?reply(records.get(key)):reply({error:{code:'not_found'}},404);
      }
      return reply({items:[]});
    }
    assert.equal(req.headers['x-csrf-token'],csrf);assert.equal(req.headers.origin,origin);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));posts++;
    if(req.url.endsWith('/pairings'))return reply({pairing:{pairing_id:'pairing-test'},control_origin:origin,code:'private-pairing-code'});
    const result={remote_id:remote,status:'accepted',space_id:'space',principal_id:principal,request:input};records.set(input.request_key,result);
    if(lost){lost=false;res.destroy();return;}reply(result);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const save=()=>writeFile(sessionFile,JSON.stringify({version:1,audience:'console',origin,session:token,principal_id:principal,expires_at:new Date(Date.now()+300000).toISOString()}),{mode:0o600});await save();
  const command={op:'prepare',operation_id:'commands.create',space_id:'space',input:{request_key:'terminal-original',gateway_id:'gateway',binding_revision:'revision',device_id:'device-lamp',model_revision:'sha256:'+hex(),expires_at:new Date(Date.now()+25000).toISOString(),operation:{type:'property.set',path:'light.power',value:true}}};
  try {await run({directory,sessionFile,origin,principal,command,session:new ControlTerminal({sessionFile}),posts:()=>posts,token:()=>token,name:value=>{name=value;},lose:()=>{lost=true;},forget:()=>records.clear(),deny:()=>{denied=true;},replace:async()=>{token=hex();await save();}});}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const commit=prepared=>({op:'commit',task_id:prepared.value.review.task_id,review_digest:prepared.value.review_digest});

test('控制面终端离线目录覆盖正式工具且拒绝额外字段与未知入口',async()=>{
  const terminal=new ControlTerminal();const result=await terminal.handle({op:'catalog'});
  assert.equal(result.exit_code,0);assert.equal(result.value.tools.operations.length,25);assert.ok(result.value.request_schema.oneOf.length);
  const validate=new Ajv({strict:true}).compile(result.value.request_schema);
  for(const packet of [{op:'catalog'},{op:'state'},{op:'read',operation_id:'spaces.list'},{op:'prepare',operation_id:'spaces.create',input:{request_key:'schema-original',name:'家庭'}},{op:'commit',task_id:'ctask-00000000-0000-4000-8000-000000000000',review_digest:'sha256:'+'0'.repeat(64)},{op:'cancel',task_id:'ctask-00000000-0000-4000-8000-000000000000'}])assert.equal(validate(packet),true,JSON.stringify(validate.errors));
  for(const packet of [{op:'read'},{op:'commit',task_id:'old'},{op:'catalog',token:'do-not-use'},{op:'prepare',operation_id:'spaces.create',input:[]},{op:'read',operation_id:'spaces.list',after:1}])assert.equal(validate(packet),false);
  for(const packet of [{op:'constructor'},{op:'catalog',token:'do-not-use'},{op:'read',operation_id:'admin.status'}])assert.notEqual((await terminal.handle(packet)).exit_code,0);
  const raw=await exec(process.execPath,['packages/cli/src/main.mjs','control','tui','schema'],{cwd:root});assert.equal(JSON.parse(raw.stdout).tools.mode,'control_plane');assert.equal(raw.stderr,'');
});

test('核对、摘要、取消与过期零提交；一次提交复用原日志，同键重开只查询',async()=>fixture(async f=>{
  const prepared=await f.session.handle(f.command);assert.equal(prepared.exit_code,0);assert.equal(f.posts(),0);
  assert.equal(prepared.value.review.origin,f.origin);assert.equal(prepared.value.review.principal_id,f.principal);assert.deepEqual(prepared.value.review.input,f.command.input);
  assert.ok(!JSON.stringify(prepared).includes(f.token()));
  assert.equal((await f.session.handle({...commit(prepared),review_digest:'sha256:'+'0'.repeat(64)})).error.code,'review_mismatch');assert.equal(f.posts(),0);
  assert.equal((await f.session.handle(commit(prepared))).exit_code,0);assert.equal(f.posts(),1);
  assert.equal((await f.session.handle(commit(prepared))).error.code,'task_already_submitted');assert.equal(f.posts(),1);
  const fresh=await new ControlTerminal({sessionFile:f.sessionFile}).handle(f.command);const resumed=new ControlTerminal({sessionFile:f.sessionFile});
  assert.equal((await resumed.handle(commit(fresh))).error.code,'review_not_found');
  const review=await resumed.handle(f.command);const original=await resumed.handle(commit(review));assert.equal(original.exit_code,0);assert.equal(f.posts(),1);
  const conflicting=await resumed.handle({...f.command,input:{...f.command.input,operation:{...f.command.input.operation,value:false}}});assert.equal((await resumed.handle(commit(conflicting))).exit_code,4);assert.equal(f.posts(),1);
  const cancelled=await resumed.handle(f.command);await resumed.handle({op:'cancel',task_id:cancelled.value.review.task_id});assert.equal((await resumed.handle(commit(cancelled))).error.code,'review_not_found');
  let now=Date.now();const expiring=new ControlTerminal({sessionFile:f.sessionFile,now:()=>now});const old=await expiring.handle(f.command);now+=60001;
  assert.equal((await expiring.handle(commit(old))).error.code,'review_expired');assert.equal(f.posts(),1);
}));

test('丢回执保留原请求；新终端仅查询原键，404和异参均不补发',async()=>fixture(async f=>{
  f.lose();const prepared=await f.session.handle(f.command);const lost=await f.session.handle(commit(prepared));assert.equal(lost.exit_code,6);assert.equal(lost.error.code,'operation_unknown');assert.equal(f.posts(),1);
  assert.deepEqual(JSON.parse(await readFile(lost.original.record_file,'utf8')).input,f.command.input);assert.equal((await stat(lost.original.record_file)).mode&0o777,0o600);
  const next=new ControlTerminal({sessionFile:f.sessionFile});const preparedAgain=await next.handle(f.command);const recovered=await next.handle(commit(preparedAgain));assert.equal(recovered.exit_code,0);assert.equal(f.posts(),1);
  const resolved=await next.handle({op:'read',operation_id:'commands.resolve',space_id:'space',id:f.command.input.request_key});assert.equal(resolved.exit_code,0);assert.equal(f.posts(),1);
  f.forget();const unavailable=await next.handle(f.command);assert.equal((await next.handle(commit(unavailable))).exit_code,6);assert.equal(f.posts(),1);
}));

test('核对后换会话或撤权均拒绝；原记录不可写时零远程提交',async()=>fixture(async f=>{
  const prepared=await f.session.handle(f.command);await f.replace();assert.equal((await f.session.handle(commit(prepared))).error.code,'session_identity_changed');assert.equal(f.posts(),0);
  const fresh=await f.session.handle(f.command);await writeFile(path.join(f.directory,'operations'),'occupied');const rejected=await f.session.handle(commit(fresh));assert.equal(rejected.error.code,'original_record_unavailable');assert.equal(f.posts(),0);
  f.deny();assert.equal((await f.session.handle(f.command)).exit_code,3);assert.equal(f.posts(),0);
}));

test('配对材料只落私有文件；纯读取直接执行，写操作不能走read',async()=>fixture(async f=>{
  const read=await f.session.handle({op:'read',operation_id:'spaces.list'});assert.equal(read.exit_code,0);assert.equal(read.value.items[0].name,'家庭');assert.equal(f.posts(),0);
  assert.equal((await f.session.handle({...f.command,op:'read'})).error.code,'review_required');
  const output=path.join(f.directory,'pairing.json');const review=await f.session.handle({op:'prepare',operation_id:'pairings.create',space_id:'space',output_file:output,input:{request_key:'pairing-original',scopes:['devices.read']}});
  const result=await f.session.handle(commit(review));assert.equal(result.exit_code,0);assert.equal(f.posts(),1);assert.ok(!JSON.stringify(result).includes('private-pairing-code'));
  assert.equal(JSON.parse(await readFile(output,'utf8')).code,'private-pairing-code');assert.equal((await stat(output)).mode&0o777,0o600);
  const classic=await executeControl(['spaces','list','--session-file',f.sessionFile]);assert.deepEqual(classic.value,read.value);
}));

test('Agent逐行JSON、交互菜单、终端转义与未终结输入上限',async()=>fixture(async f=>{
  const child=spawn(process.execPath,['packages/cli/src/main.mjs','control','tui','--stdio','--session-file',f.sessionFile],{cwd:root,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const ended=new Promise(resolve=>child.once('exit',resolve));child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify({op:'read',operation_id:'spaces.list'})+'\n{invalid}\n{"op":"state","op":"catalog"}\n'),Buffer.from([0xff,0x0a])]));assert.equal(await ended,0);
  const lines=stdout.trim().split('\n').map(JSON.parse);assert.equal(lines[0].value.items[0].name,'家庭');assert.equal(lines.length,4);for(const line of lines.slice(1))assert.equal(line.error.code,'invalid_terminal_request');assert.equal(stderr,'');assert.ok(!stdout.includes(f.token()));
  f.name('家庭\x1b[2J\u202e');
  const menu=spawn(process.execPath,['packages/cli/src/main.mjs','control','tui','--session-file',f.sessionFile],{cwd:root,stdio:['pipe','pipe','pipe']});let screen='';menu.stdout.on('data',chunk=>screen+=chunk);const menuEnd=new Promise(resolve=>menu.once('exit',resolve));menu.stdin.end('1\n6\n0\n');assert.equal(await menuEnd,0);assert.ok(screen.includes('查看与校验'));assert.ok(screen.includes('\\u202e'));assert.ok(!screen.includes('\x1b')&&!screen.includes('\u202e'));assert.ok(!screen.includes(f.token()));assert.equal(f.posts(),0);
  const large=spawn(process.execPath,['packages/cli/src/main.mjs','control','tui','--stdio','--session-file',f.sessionFile],{cwd:root,stdio:['pipe','pipe','pipe']});let error='';large.stdout.on('data',chunk=>error+=chunk);const largeEnd=new Promise(resolve=>large.once('exit',resolve));large.stdin.on('error',()=>{});large.stdin.end('x'.repeat(32769));assert.equal(await largeEnd,2);assert.equal(JSON.parse(error).error.code,'terminal_line_too_large');assert.equal(f.posts(),0);
}));
