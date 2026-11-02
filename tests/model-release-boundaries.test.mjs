import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReleaseVerificationJSON,verifyReleaseReport } from '../packages/protocol/model-release.mjs';

const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const f=JSON.parse(await readFile(path.join(root,'contracts/examples/model-release.json'),'utf8'));
async function run(artifact,trust,extra={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'limeiot-release-verify-'));
  try {
    const input=path.join(dir,'release.json'),pin=path.join(dir,'trust.json');
    await writeFile(input,typeof artifact==='string'?artifact:JSON.stringify(artifact));
    await writeFile(pin,typeof trust==='string'?trust:JSON.stringify(trust));
    let result;
    try {result=await exec(process.execPath,['packages/cli/src/main.mjs','model','verify','--input',input,...(extra.noTrust?[]:['--trust',pin])],{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator'),HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',...extra.env},timeout:8000})}catch(error){result=error}
    assert.deepEqual((await readdir(dir)).sort(),['release.json','trust.json']);
    return result;
  } finally {await rm(dir,{recursive:true,force:true})}
}

test('离线验签固定制品与升级，显式信任且零网络/零原操作文件',async()=>{
  assert.equal(f.test_only,true);
  for(const artifact of [f.artifact,f.upgrade]) {
    const result=await run(artifact,f.trust);assert.equal(result.code??0,0,result.stderr);assert.equal(result.stderr,'');
    const source=parseReleaseVerificationJSON(JSON.stringify({artifact,trust:f.trust}));
    const report=await verifyReleaseReport(JSON.parse(result.stdout),source);assert.equal(report.valid,true);assert.deepEqual(report.release,artifact);
  }
  const noTrust=await run({...f.artifact,public_key:f.trust.public_key},f.trust,{noTrust:true});
  assert.equal(noTrust.code,2);assert.equal(JSON.parse(noTrust.stderr).error.code,'trust_required');
  const missing=await run(f.artifact,f.trust,{env:{LIMEIOT_MODEL_VALIDATOR:path.join(root,'.dev/no-such-release-verifier')}});
  assert.equal(missing.code,5);assert.equal(JSON.parse(missing.stderr).error.code,'validator_unavailable');
});

test('篡改、错误范围、非法JSON与超限只返回无效制品',async()=>{
  const tampered=structuredClone(f.artifact);tampered.statement.model.model_version='1.0.1';
  const other=structuredClone(f.trust);other.issuer='https://other.example.test';
  for(const [artifact,trust,code] of [
    [tampered,f.trust,'invalid_release_signature'],[f.artifact,other,'untrusted_release'],
    [{...f.artifact,public_key:f.trust.public_key},f.trust,'invalid_release_document'],
    ['{"version":1,"version":1}',f.trust,'invalid_verification_document'],
    [f.artifact,'{"version":1,"public_key":"\\ud800"}','invalid_verification_document'],
    [' '.repeat(12289),f.trust,'invalid_verification_document'],
    [f.artifact,' '.repeat(2049),'invalid_verification_document'],
  ]) {
    const result=await run(artifact,trust);assert.equal(result.code,2,result.stderr);assert.equal(result.stderr,'');
    const report=JSON.parse(result.stdout);assert.equal(report.valid,false);assert.equal(report.release,null);assert.equal(report.issues[0].code,code);
  }
});

test('消费者拒绝错绑信任、替换制品和混合成功错误报告',async()=>{
  const result=await run(f.artifact,f.trust),good=JSON.parse(result.stdout),source={artifact:f.artifact,trust:f.trust};
  await verifyReleaseReport(good,source);
  for(const mutate of [v=>{v.artifact_digest='sha256:wrong'},v=>{v.trust_digest='sha256:wrong'},v=>{v.valid=false},v=>{v.release=null},v=>{v.extra=true},v=>{v.issues=[{path:'/',code:'invalid'}]},v=>{v.release.statement.model_revision='sha256:wrong'}]) {
    const value=structuredClone(good);mutate(value);await assert.rejects(verifyReleaseReport(value,source));
  }
  await assert.rejects(verifyReleaseReport(good,{artifact:f.upgrade,trust:f.trust}));
  await assert.rejects(verifyReleaseReport(good,{artifact:f.artifact,trust:{...f.trust,issuer:'https://other.example.test'}}));
});
