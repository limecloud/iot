import { createInterface } from 'node:readline';
import { readFile,open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { controlCatalog, controlContext, controlInput, executeControl } from './control.mjs';
import { documentDigest } from '../../protocol/model-validation.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { terminalText } from './tui.mjs';

const schema=JSON.parse(await readFile(new URL('../../../contracts/control-terminal-tasks.schema.json',import.meta.url),'utf8'));
const catalog=controlCatalog();
const fault=(code,exit=2)=>Object.assign(new Error(code),{safeCode:code,exit});
const readOnly=op=>op.method==='GET'||op.side_effect==='none';
const fields={catalog:['op'],state:['op'],read:['op','operation_id','space_id','id','after','input'],prepare:['op','operation_id','space_id','id','input','output_file'],commit:['op','task_id','review_digest'],cancel:['op','task_id']};
const labels={'publisher.get':'发布者信息','releases.list':'模型发布列表','releases.head':'当前模型发布','releases.get':'模型发布详情','releases.create':'公开发布模型','releases.resolve':'查询原发布请求','spaces.list':'空间列表','spaces.create':'创建空间','gateways.list':'网关列表','gateways.connection':'网关连接状态','gateways.revoke':'撤销网关授权','pairings.create':'创建配对材料','devices.list':'设备列表','models.get':'设备物模型','commands.create':'发送设备命令','commands.get':'命令详情','commands.resolve':'查询原命令','commands.reconcile':'核实原网关命令','products.list':'产品列表','products.create':'创建产品草稿','products.get':'产品详情','products.save':'保存产品草稿','products.resolve':'查询原草稿请求','models.compare':'比较物模型','models.validate':'校验物模型'};

async function inputFile(file) {
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    if(!(await handle.stat()).isFile())throw fault('invalid_input');
    const bytes=Buffer.alloc(16417);let size=0;
    while(size<bytes.length){const {bytesRead}=await handle.read(bytes,size,bytes.length-size,null);if(!bytesRead)break;size+=bytesRead;}
    if(size>16416)throw fault('invalid_input');
    return parseBoundedJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)),{maxBytes:16416,maxDepth:24,maxNodes:4096});
  } finally {await handle.close();}
}

export class ControlTerminal {
  constructor({sessionFile,endpoint,now=Date.now}={}) {
    this.sessionFile=sessionFile?path.resolve(sessionFile):undefined;
    this.endpoint=endpoint;this.now=now;this.tasks=new Map();
  }
  async context(){return controlContext({sessionFile:this.sessionFile,endpoint:this.endpoint});}
  arguments(packet) {
    const op=catalog.operations.find(item=>item.operation_id===packet.operation_id);
    if(!op)throw fault('unsupported_operation');
    if(op.space_required&&(typeof packet.space_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(packet.space_id)))throw fault('space_id_required');
    if(!op.space_required&&packet.space_id!==undefined)throw fault('unexpected_space');
    if(op.path.includes('{id}')&&(typeof packet.id!=='string'||!packet.id||packet.id.length>128))throw fault('resource_id_required');
    if(!op.path.includes('{id}')&&packet.id!==undefined)throw fault('unexpected_resource');
    if(packet.after!==undefined&&(!op.pagination||typeof packet.after!=='string'||packet.after.length>128))throw fault('unsupported_pagination');
    if(op.sensitive_output&&(typeof packet.output_file!=='string'||!path.isAbsolute(packet.output_file)))throw fault('private_output_required');
    if(!op.sensitive_output&&packet.output_file!==undefined)throw fault('unexpected_output');
    let document;
    if(packet.input!==undefined)document=JSON.stringify(packet.input);
    const input=controlInput(op.operation_id,document);
    const args=['invoke',op.operation_id,'--session-file',this.sessionFile??''];
    for(const [key,flag] of [['space_id','space-id'],['id','id'],['after','after'],['output_file','output']])if(packet[key]!==undefined)args.push('--'+flag,packet[key]);
    if(this.endpoint)args.push('--endpoint',this.endpoint);
    return {op,args,document,input};
  }
  async handle(packet) {
    try {
      if(!packet||Array.isArray(packet)||typeof packet!=='object'||!Object.hasOwn(fields,packet.op)||Object.keys(packet).some(key=>!fields[packet.op].includes(key)))throw fault('invalid_terminal_request');
      if(packet.op==='catalog')return {exit_code:0,value:{schema_version:1,request_schema:schema,tools:controlCatalog()}};
      if(packet.op==='state') {
        const context=await this.context();
        const tasks=[...this.tasks.values()].map(task=>({task_id:task.review.task_id,operation_id:task.review.operation_id,expires_at:task.review.expires_at,submitted:task.submitted}));
        return {exit_code:0,value:{origin:context.origin,principal_id:context.principal_id,tasks}};
      }
      if(packet.op==='read'||packet.op==='prepare') {
        const request=this.arguments(packet);
        if(readOnly(request.op)!==(packet.op==='read'))throw fault(readOnly(request.op)?'read_operation_required':'review_required');
        const context=await this.context();
        if(packet.op==='read')return executeControl(request.args,{document:request.document,context});
        for(const [id,task]of this.tasks)if(task.deadline<=this.now())this.tasks.delete(id);
        if(this.tasks.size>=32)throw fault('review_capacity_reached',4);
        const deadline=this.now()+60000;
        const review={task_id:'ctask-'+randomUUID(),operation_id:request.op.operation_id,origin:context.origin,principal_id:context.principal_id,expires_at:new Date(deadline).toISOString(),...(packet.space_id?{space_id:packet.space_id}:{}),...(packet.id?{id:packet.id}:{}),...(request.input!==undefined?{input:request.input}:{}),...(packet.output_file?{output_file:packet.output_file}:{}),...(request.op.recovery_operation?{recovery_operation:request.op.recovery_operation}:{})};
        const review_digest=await documentDigest(review);
        this.tasks.set(review.task_id,{review,review_digest,deadline,context,args:request.args,document:request.document,submitted:false});
        return {exit_code:0,value:{review,review_digest}};
      }
      const task=this.tasks.get(packet.task_id);
      if(!task)throw fault('review_not_found',4);
      if(task.submitted)throw fault('task_already_submitted',4);
      if(packet.op==='cancel'){this.tasks.delete(packet.task_id);return {exit_code:0,value:{cancelled:true,task_id:packet.task_id}};}
      if(task.deadline<=this.now())throw fault('review_expired',4);
      if(packet.review_digest!==task.review_digest)throw fault('review_mismatch',4);
      // 先消耗本次核对，任何网络或本机故障都不自动重发；原请求由CLI日志恢复。
      task.submitted=true;
      return executeControl(task.args,{document:task.document,context:task.context});
    } catch(error) {return {exit_code:error.exit??5,error:{code:error.safeCode??'local_file_unavailable'}};}
  }
}

async function textMenu(session,input,output) {
  const rl=createInterface({input,output,terminal:!!input.isTTY});const lines=rl[Symbol.asyncIterator]();
  const say=value=>output.write(terminalText(typeof value==='string'?value:JSON.stringify(value))+'\n');
  const ask=async label=>{output.write(terminalText(label)+'> ');const line=await lines.next();return line.done?null:line.value.trim();};
  try {
    for(;;) {
      const mode=await ask('1 查看与校验  2 执行操作  3 当前会话  0 退出');
      if(mode===null||mode==='0')return;
      if(mode==='3'){say(await session.handle({op:'state'}));continue;}
      if(!['1','2'].includes(mode))continue;
      const operations=catalog.operations.filter(op=>readOnly(op)===(mode==='1'));
      operations.forEach((op,index)=>say(`${index+1}. ${labels[op.operation_id]??op.operation_id} (${op.operation_id})`));
      const choice=await ask('选择操作，0 返回');if(choice===null)return;
      const op=operations[Number(choice)-1];if(!op)continue;
      const packet={op:mode==='1'?'read':'prepare',operation_id:op.operation_id};
      let cancelled=false;
      for(const [condition,key,prompt]of [[op.space_required,'space_id','空间 ID'],[op.path.includes('{id}'),'id','资源 ID'],[op.pagination,'after','分页游标，回车读取首页'],[op.sensitive_output,'output_file','保存配对材料的绝对路径']]) {
        if(!condition)continue;const answer=await ask(prompt+'，/cancel 返回');
        if(answer===null)return;if(answer==='/cancel'){cancelled=true;break;}if(answer)packet[key]=answer;
      }
      if(cancelled)continue;
      if(op.input_schema) {
        say(catalog.schemas[op.input_schema]);
        const file=await ask('输入 JSON 文件路径，/cancel 返回');if(file===null)return;if(file==='/cancel')continue;
        try {packet.input=await inputFile(file);}
        catch {say('输入文件不符合要求');continue;}
      }
      const prepared=await session.handle(packet);say(prepared);
      if(packet.op==='prepare'&&prepared.exit_code===0) {
        const approved=await ask('输入确认提交，其他输入取消');
        if(approved==='确认')say(await session.handle({op:'commit',task_id:prepared.value.review.task_id,review_digest:prepared.value.review_digest}));
        else await session.handle({op:'cancel',task_id:prepared.value.review.task_id});
        if(approved===null)return;
      }
    }
  } finally {rl.close();}
}

export async function runControlTui(args,{input=process.stdin,output=process.stdout}={}) {
  try {
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{'session-file':{type:'string'},endpoint:{type:'string'},stdio:{type:'boolean'},snapshot:{type:'boolean'}}});
    if(positionals.length>1||positionals.length&&positionals[0]!=='schema')throw fault('invalid_terminal_arguments');
    if(positionals[0]==='schema'){output.write(JSON.stringify((await new ControlTerminal().handle({op:'catalog'})).value)+'\n');return;}
    const session=new ControlTerminal({sessionFile:values['session-file']??process.env.LIMEIOT_CONTROL_SESSION_FILE,endpoint:values.endpoint});
    if(!session.sessionFile)throw fault('session_file_required');
    if(values.snapshot){const result=await session.handle({op:'state'});output.write(JSON.stringify(result)+'\n');process.exitCode=result.exit_code;return;}
    if(!values.stdio){await textMenu(session,input,output);return;}
    // 按块分帧，限制未终结的一行，避免Agent或管道无限积累输入。
    let pending=Buffer.alloc(0);
    const respond=async bytes=>{
      let result;
      try {result=await session.handle(parseBoundedJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{maxBytes:32768,maxDepth:32,maxNodes:8192}));}
      catch {result={exit_code:2,error:{code:'invalid_terminal_request'}};}
      output.write(JSON.stringify(result)+'\n');
    };
    for await(const chunk of input){
      pending=Buffer.concat([pending,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
      let newline;while((newline=pending.indexOf(10))!==-1){if(newline>32768)throw fault('terminal_line_too_large');await respond(pending.subarray(0,newline));pending=pending.subarray(newline+1);}
      if(pending.length>32768)throw fault('terminal_line_too_large');
    }
    if(pending.length)await respond(pending);
  } catch(error) {output.write(JSON.stringify({exit_code:error.exit??2,error:{code:error.safeCode??'terminal_unavailable'}})+'\n');process.exitCode=error.exit??2;}
}
