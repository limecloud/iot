import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseComparisonJSON, verifyComparisonReport } from '../packages/protocol/model-compatibility.mjs';

const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const vectors=JSON.parse(await readFile(path.join(root,'contracts/model-compatibility-vectors.json'),'utf8'));
test('离线兼容性CLI执行共享向量并区分定义错误与不兼容',{timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'limeiot-model-compare-'));
  try {
    const malformed=['{}','{"baseline":{},"candidate":{},"extra":true}','{"baseline":{},"candidate":{"x":1,"x":2}}','{"baseline":{},"candidate":{"x":"\\ud800"}}','{"baseline":{},"candidate":{"x":9007199254740992}}',' '.repeat(16417),JSON.stringify({baseline:{x:'x'.repeat(8192)},candidate:{}})];
    const longField=JSON.parse(vectors.cases[0].raw);longField.candidate.services[0].properties[0].schema={type:'object',properties:{['界/~'.repeat(400)]:{type:'boolean'}}};
    for(const item of [...vectors.cases,{name:'long_field',raw:JSON.stringify(longField),valid:false,compatible:null},...malformed.map((raw,index)=>({name:'unsafe_'+index,raw,valid:false,compatible:null}))]) {
      const file=path.join(dir,'input.json');await writeFile(file,item.raw);
      let result;try{result=await exec(process.execPath,['packages/cli/src/main.mjs','model','compare','--input',file],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator'),HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1'},timeout:8000})}catch(error){result=error}
      assert.equal(result.code??0,item.compatible===true?0:2,item.name+': '+result.stderr);
      assert.equal(result.stderr,'',item.name);const report=JSON.parse(result.stdout);assert.equal(report.valid,item.valid,item.name);assert.equal(report.compatible,item.compatible,item.name);
      let source;try{source=parseComparisonJSON(item.raw)}catch{}
      await verifyComparisonReport(report,source);
    }
    const missing=await exec(process.execPath,['packages/cli/src/main.mjs','model','compare','--input',path.join(dir,'input.json')],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(dir,'missing')}}).catch(error=>error);
    assert.equal(missing.code,5);assert.equal(JSON.parse(missing.stderr).error.code,'validator_unavailable');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('消费者核对两份输入和报告状态，拒绝错绑与伪造摘要',async()=>{
  const source=parseComparisonJSON(vectors.cases[0].raw);
  const dir=await mkdtemp(path.join(tmpdir(),'limeiot-model-report-'));
  try {
    const file=path.join(dir,'input.json');await writeFile(file,vectors.cases[0].raw);
    const {stdout}=await exec(process.execPath,['packages/cli/src/main.mjs','model','compare','--input',file],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')}});
    const good=JSON.parse(stdout);await verifyComparisonReport(good,source);
    for(const mutate of [
      v=>{v.comparison_digest='sha256:wrong'},v=>{v.valid=false},v=>{v.compatible=null},v=>{v.compatible=false},
      v=>{v.baseline.document_digest=v.candidate.document_digest},v=>{v.candidate.model_revision='sha256:wrong'},
      v=>{v.issues=[{code:'unsafe'}]},v=>{v.extra=true},v=>{delete v.candidate.model_revision},
    ]) {const value=structuredClone(good);mutate(value);await assert.rejects(verifyComparisonReport(value,source));}
    await assert.rejects(verifyComparisonReport(good,{baseline:source.candidate,candidate:source.baseline}));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
