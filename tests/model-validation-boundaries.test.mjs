import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyModelReport, documentDigest } from '../packages/protocol/model-validation.mjs';

const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
test('离线CLI复用共享正反例，模型错误为2且不发送网络请求',{timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'limeiot-model-check-'));
  try{
    const vectors=JSON.parse(await readFile(path.join(root,'contracts/model-validation-vectors.json'),'utf8'));
    for(const item of vectors.cases){
      const file=path.join(dir,'input.json');await writeFile(file,item.raw);
      let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',file],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator'),HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'},timeout:8000})}catch(error){result=error}
      assert.equal(result.code??0,item.valid?0:2,item.name+': '+result.stderr);
      assert.equal(result.stderr,'',item.name);const report=JSON.parse(result.stdout);assert.equal(report.valid,item.valid,item.name);
    }
    const missing=await exec(process.execPath,['packages/cli/src/main.mjs','model','validate','--input',path.join(dir,'input.json')],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(dir,'missing')}}).catch(error=>error);
    assert.equal(missing.code,5);assert.equal(JSON.parse(missing.stderr).error.code,'validator_unavailable');
  }finally{await rm(dir,{recursive:true,force:true})}
});
test('消费者拒绝错绑正文、伪造候选修订和混合有效/错误报告',async()=>{
  const model={a:1},digest=await documentDigest(model);
  const good={version:1,validator:'limeiot.model/1.1.0',valid:true,document_digest:digest,model_revision:digest,normalized_model:model,issues:[]};
  assert.equal(await verifyModelReport(good,model),good);
  for(const bad of [{...good,document_digest:'sha256:wrong'},{...good,model_revision:'sha256:wrong'},{...good,issues:[{path:'/a',code:'invalid_value'}]},{...good,valid:false},{...good,extra:true},{...good,issues:[{path:'not-a-pointer',code:'private text'}]}])await assert.rejects(verifyModelReport(bad,model));
  assert.equal(await documentDigest({'2':true,'10':false}),await documentDigest({'10':false,'2':true}));
});
