import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cloudClient,origin } from './helpers/control.mjs';
import { verifyComparisonReport } from '../packages/protocol/model-compatibility.mjs';

test('真实控制面兼容性API与CLI：方向一致、绑定两份输入且零产品写入',{skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,timeout:60000},async()=>{
  const core=path.resolve(import.meta.dirname,'..'),cloud=await cloudClient(),endpoint='/api/console/v1/models/compare';
  const vectors=JSON.parse(await readFile(path.join(core,'contracts/model-compatibility-vectors.json'),'utf8'));
  const cases=['same_definition_newer_version','equal_version','write_wider','read_wider','event_output_expands','invalid_candidate'];
  const before=await cloud.call('/api/console/v1/products');
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'limeiot-compare-http-')),exec=promisify(execFile);
  try {
    const session=path.join(dir,'session.json'),input=path.join(dir,'input.json');
    const args=['packages/cli/src/main.mjs','control','--session-file',session];
    await exec(process.execPath,[...args,'auth','login','--endpoint',origin,'--token-file',process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE],{cwd:core});
    const examples=cases.map(name=>{const item=vectors.cases.find(item=>item.name===name);assert.ok(item,name);return item});
    const longField=JSON.parse(vectors.cases[0].raw);longField.candidate.services[0].properties[0].schema={type:'object',properties:{['界/~'.repeat(400)]:{type:'boolean'}}};
    examples.push({name:'long_field',raw:JSON.stringify(longField),valid:false,compatible:null});
    for(const item of examples) {
      const {name}=item;
      const source=JSON.parse(item.raw),report=await verifyComparisonReport(await cloud.call(endpoint,source),source);
      assert.equal(report.valid,item.valid,name);assert.equal(report.compatible,item.compatible,name);
      await writeFile(input,item.raw);
      let result;try{result=await exec(process.execPath,[...args,'models','compare','--input',input],{cwd:core})}catch(error){result=error}
      assert.equal(result.code??0,item.compatible===true?0:2,name+': '+result.stderr);assert.equal(result.stderr,'');
      assert.deepEqual(JSON.parse(result.stdout),report,name);
    }
    await assert.rejects(stat(path.join(dir,'operations')),error=>error.code==='ENOENT');
    await cloud.call(endpoint,{baseline:{},candidate:{},extra:true},400);
    await cloud.call(endpoint,{baseline:{},candidate:null},400);
    await cloud.call(endpoint,{baseline:{}},400);
    const anon=await fetch(origin+endpoint,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"baseline":{},"candidate":{}}'});assert.equal(anon.status,401);await anon.body.cancel();
    assert.deepEqual(await cloud.call('/api/console/v1/products'),before);
  } finally {await rm(dir,{recursive:true,force:true})}
});
