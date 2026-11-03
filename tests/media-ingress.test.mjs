import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import http from 'node:http';
import { root,freePort,until,stop } from '../tools/dev-stack.mjs';
import { mediaStack } from './helpers/media.mjs';
const exec=promisify(execFile),base='/api/v1/spaces/space-demo';

test('两种NAS入口使用实际Nginx接收大于512KiB音频，超限拒绝且不改变其他路由上限',{timeout:60000},async t=>{
  const {directory,bytes,stack}=await mediaStack(t,'media-ingress-');
  const large=Buffer.alloc(640044);bytes.copy(large,0,0,44);large.writeUInt32LE(large.length-8,4);large.writeUInt32LE(large.length-44,40);
  const input={type:'media.upload',content_base64:large.toString('base64'),retain_seconds:600};assert.ok(JSON.stringify(input).length>512*1024);
  const gateway=new URL(stack.env.LIMEIOT_ENDPOINT);let requests=0;
  for(const template of ['nginx.conf','nginx.platform.conf']) {
    const prefix=await mkdtemp(path.join(directory,'nginx-')),port=await freePort(),file=path.join(prefix,'nginx.conf');
    for(const name of ['client_body','proxy','fastcgi','uwsgi','scgi'])await mkdir(path.join(prefix,name));
    // 只替换部署环境的地址、端口、路径与TLS材料；完整生产location及其上限原样执行。
    let source=await readFile(path.join(root,'deploy/nas',template),'utf8');
    source=source.replace(/stream \{[\s\S]*?\n\}\nhttp \{/,'http {').replace('pid /tmp/nginx.pid;',`pid ${prefix}/nginx.pid;`).replaceAll('resolver 127.0.0.11','resolver 127.0.0.1').replaceAll('server gateway:17880 resolve;',`server 127.0.0.1:${gateway.port};`).replaceAll('server control:8080 resolve;',`server 127.0.0.1:${gateway.port};`).replace('listen 8443 ssl;',`listen 127.0.0.1:${port};`).replace(/^\s*ssl_(?:certificate|certificate_key|protocols).*;$/gm,'').replaceAll('/tmp/client_body',prefix+'/client_body').replaceAll('/tmp/proxy',prefix+'/proxy').replaceAll('/tmp/fastcgi',prefix+'/fastcgi').replaceAll('/tmp/uwsgi',prefix+'/uwsgi').replaceAll('/tmp/scgi',prefix+'/scgi');
    // macOS ARM使用16KiB页；隔离夹具扩大共享区以满足同版Nginx的平台分配下界。
    if(process.platform==='darwin')source=source.replaceAll(' 64k;',' 256k;');
    await writeFile(file,source);await exec(process.env.LIMEIOT_NGINX??'nginx',['-e','stderr','-p',prefix+'/', '-c',file,'-t'],{timeout:10000});
    const nginx=stack.launch('nginx-'+template,process.env.LIMEIOT_NGINX??'nginx',['-e','stderr','-p',prefix+'/', '-c',file,'-g','daemon off;']);
    const origin=`http://127.0.0.1:${port}`;
    // Node fetch会覆盖Host；使用HTTP客户端明确保留已配置的公开authority。
    const call=(resource,body,key)=>new Promise((resolve,reject)=>{
      const request=http.request(origin+resource,{method:body===undefined?'GET':'POST',headers:{Host:gateway.host,Authorization:'Bearer '+stack.env.LIMEIOT_TOKEN,...(body===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Idempotency-Key':key})}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,text:Buffer.concat(chunks).toString()}));});request.setTimeout(8000,()=>request.destroy(new Error('proxy_timeout')));request.on('error',reject);request.end(body);
    });
    await until(async()=>(await call('/healthz')).status===200);
    const send=(resource,body,key)=>call(resource,body,key);
    const accepted=await send(base+'/media-operations',JSON.stringify(input),'ingress-'+template.replaceAll('.','-'));assert.equal(accepted.status,200,accepted.text);const result=JSON.parse(accepted.text);assert.equal(result.result.media.byte_length,large.length);requests++;
    const tooLarge=await send(base+'/media-operations','x'.repeat(5596505),'too-large-'+requests);assert.equal(tooLarge.status,413);
    const control=await send(base+'/commands',JSON.stringify({padding:'x'.repeat(17000)}),'other-'+requests);assert.equal(control.status,413);
    const page=(await stack.request(base+'/media')).value;assert.equal(page.items.length,requests);await stop(nginx);
  }
  const report={passed:true,production_nginx_locations:true,transport:'host HTTP; container TLS and DNS substituted',templates:2,uploaded_bytes:large.length,body_above_512k:true,media_limit_5596504:true,other_routes_still_limited:true,real_nginx:true,real_gateway:true,container_runtime:false,hardware:false,hardware_status:'用户要求跳过',published:false,full_goal_completed:false};await writeFile(path.join(directory,'media-ingress-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(directory,'media-ingress-result.json')}));
});
