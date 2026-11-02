import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root } from '../tools/dev-stack.mjs';
const exec=promisify(execFile);

test('控制面CLI拒绝缺少原请求或设备证据的完成响应',{timeout:15000},async()=>{
  const principal='p-'+randomBytes(32).toString('hex'),remote='remote-'+randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');let response;
  let writes=0;
  const server=createServer((req,res)=>{if(req.method==='POST')writes++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/console/v1/auth/session'?{audience:'console',principal:{principal_id:principal},csrf_token:'0'.repeat(64)}:response))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const directory=path.join(root,'.dev',`cli-boundary-${randomBytes(8).toString('hex')}`);await mkdir(directory,{mode:0o700});const session=path.join(directory,'session.json');
    await writeFile(session,JSON.stringify({version:1,audience:'console',origin:`http://127.0.0.1:${server.address().port}`,session:token,principal_id:principal,expires_at:new Date(Date.now()+60000).toISOString()}),{mode:0o600});
    for(const malformed of [{remote_id:remote,status:'confirmed'},{remote_id:remote,status:'confirmed',request:{request_key:'original'},space_id:'space',principal_id:principal,local_result:{}}]){
      response=malformed;
      await assert.rejects(exec(process.execPath,['packages/cli/src/main.mjs','control','commands','resolve','original','--space-id','space','--session-file',session],{cwd:root}),e=>e.code===6&&JSON.parse(e.stderr).error.code==='operation_unknown'&&e.stdout===''&&!e.stderr.includes(token));
    }
    for(const key of ['constructor','__proto__']){
      const input=path.join(directory,`invalid-${key}.json`);await writeFile(input,JSON.stringify({request_key:'invalid',name:'家庭',[key]:{}}));
      await assert.rejects(exec(process.execPath,['packages/cli/src/main.mjs','control','spaces','create','--input',input,'--session-file',session],{cwd:root}),e=>e.code===2&&JSON.parse(e.stderr).error.code==='invalid_input');
    }
    assert.equal(writes,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
