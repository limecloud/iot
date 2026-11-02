import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, stat, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cloudClient, fixture, origin } from './helpers/control.mjs';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { publicationBrowser } from './helpers/publication.mjs';

test('发布进程闭环：丢响应只查原决定、进程重启、公开下载与离线验签',{skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,timeout:45000},async()=>{
  const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile);
  await fixture({restart_api:true});
  const cloud=await cloudClient(),publisher=await cloud.call('/api/console/v1/publisher');
  assert.ok(publisher.trust);assert.equal(publisher.trust.publisher_id,publisher.publisher_id);
  const model=JSON.parse(await readFile(path.join(root,'contracts/models/lamp.json'),'utf8'));
  model.model_id=`urn:${publisher.namespace}:model:publication-process:1`;
  const created=await cloud.call('/api/console/v1/products',{request_key:'publication-process-product',name:'进程发布测试',model});
  const product=created.product,resource=`/api/console/v1/products/${product.product_id}`,input={request_key:'publication-process-first',expected_revision:product.revision,expected_release_id:null,visibility:'public'};
  const before=await fixture({drop_release_responses:true});
  await assert.rejects(cloud.call(resource+'/releases',input));
  const after=await fixture();assert.equal(after.release_posts,before.release_posts+1);
  const operation=await cloud.call('/api/console/v1/release-operations/by-key/'+input.request_key);
  assert.equal(operation.status,'published');assert.equal(operation.release.artifact.statement.source_revision,product.revision);
  assert.deepEqual(operation.request,input);assert.equal(operation.release.artifact.statement.model_revision,await documentDigest(operation.release.artifact.statement.model));
  await fixture({restart_api:true});
  assert.deepEqual(await cloud.call('/api/console/v1/release-operations/by-key/'+input.request_key),operation);
  const afterRecovery=await fixture();assert.equal(afterRecovery.release_posts,after.release_posts);
  assert.deepEqual(await cloud.call(resource),product);
  const response=await fetch(origin+'/api/catalog/v1/model-releases/'+operation.release.artifact.statement.release_id);
  assert.equal(response.status,200);const publication=await response.json();assert.deepEqual(publication,operation.release);
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'limeiot-publication-process-'));
  try {
    const artifact=path.join(dir,'artifact.json'),trust=path.join(dir,'trust.json');
    await writeFile(artifact,JSON.stringify(publication.artifact));await writeFile(trust,JSON.stringify(publisher.trust));
    const args=['packages/cli/src/main.mjs','model','verify','--input',artifact,'--trust',trust];
    const checked=await exec(process.execPath,args,{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')}});
    assert.equal(JSON.parse(checked.stdout).valid,true);
    const tampered=structuredClone(publication.artifact);tampered.statement.model.model_version='9.0.0';await writeFile(artifact,JSON.stringify(tampered));
    const invalid=await exec(process.execPath,args,{cwd:root,env:{...process.env,LIMEIOT_MODEL_VALIDATOR:path.join(root,'target/debug/limeiot-model-validator')}}).catch(error=>error);
    assert.equal(invalid.code,2);assert.equal(JSON.parse(invalid.stdout).issues[0].code,'invalid_release_signature');
  } finally {await rm(dir,{recursive:true,force:true})}
});

test('发布浏览器闭环：存储失败、丢响应、重启、下载、拒绝及基线冲突', {skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,timeout:120000},()=>publicationBrowser());

test('发布CLI/Agent闭环：固定基线、私有原请求、丢响应只读恢复、升级与拒绝退出码', {skip:!process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE,timeout:90000}, async()=>{
  const root=path.resolve(import.meta.dirname,'..'),exec=promisify(execFile),cloud=await cloudClient();
  const dir=await mkdtemp(path.join(await realpath(tmpdir()),'limeiot-release-cli-'));
  const session=path.join(dir,'session.json'),file=path.join(dir,'input.json');
  async function cli(args,code=0){let out;try{out=await exec(process.execPath,['packages/cli/src/main.mjs','control','--session-file',session,...args],{cwd:root,env:process.env,timeout:18000})}catch(error){out=error}assert.equal(out.code??0,code,out.stderr);return out}
  async function call(args,code=0){return JSON.parse((await cli(args,code)).stdout)}
  async function input(value){await writeFile(file,JSON.stringify(value));return ['--input',file]}
  try {
    await call(['auth','login','--endpoint',origin,'--token-file',process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE]);
    const publisher=await call(['invoke','publisher.get']);
    const model=JSON.parse(await readFile(path.join(root,'contracts/models/lamp.json'),'utf8'));
    model.model_id=`urn:${publisher.namespace}:model:cli-publication:1`;
    const product=(await cloud.call('/api/console/v1/products',{request_key:'cli-release-product',name:'CLI发布环境灯',model})).product;
    const base='/api/console/v1/products/'+product.product_id;
    assert.deepEqual(await call(['releases','head',product.product_id]),{release:null});
    const request={request_key:'cli-release-original',expected_revision:product.revision,expected_release_id:null,visibility:'public'};
    const before=(await fixture()).release_posts;
    const incomplete={...request};delete incomplete.expected_release_id;await cli(['releases','create',product.product_id,...await input(incomplete)],2);
    await writeFile(file,JSON.stringify(request).replace('"visibility":"public"','"visibility":"public","visibility":"public"'));
    await cli(['releases','create',product.product_id,'--input',file],2);assert.equal((await fixture()).release_posts,before);
    const blocked=path.join(dir,'blocked');await mkdir(blocked,{mode:0o700});await writeFile(path.join(blocked,'session.json'),await readFile(session),{mode:0o600});await writeFile(path.join(blocked,'operations'),'occupied');
    await cli(['releases','create',product.product_id,...await input(request),'--session-file',path.join(blocked,'session.json')],5);assert.equal((await fixture()).release_posts,before);
    await fixture({drop_release_responses:true});const lost=await cli(['invoke','releases.create','--id',product.product_id,...await input(request)],6);
    const record=JSON.parse(lost.stderr).original.record_file;assert.deepEqual(JSON.parse(await readFile(record,'utf8')).input,request);assert.equal((await stat(record)).mode&0o777,0o600);
    assert.equal((await fixture()).release_posts,before+1);
    await fixture({restart_api:true});const first=await call(['releases','create',product.product_id,...await input(request)]);
    assert.equal(first.status,'published');assert.equal((await fixture()).release_posts,before+1);
    const releaseID=first.release.artifact.statement.release_id;
    assert.equal((await call(['releases','resolve',request.request_key])).operation_id,first.operation_id);
    assert.equal((await call(['releases','head',product.product_id])).release.artifact.statement.release_id,releaseID);
    assert.deepEqual(await call(['releases','get',releaseID]),first.release);
    assert.ok((await call(['releases','list',product.product_id])).items.some(item=>item.artifact.statement.release_id===releaseID));
    await cli(['releases','create','product-'+'0'.repeat(64),...await input(request)],4);
    await cli(['releases','create',product.product_id,...await input({...request,expected_release_id:releaseID})],4);
    await cli(['releases','resolve','cli-release-never-sent'],6);assert.equal((await fixture()).release_posts,before+1);
    model.model_version='1.0.1';const saved=await cloud.call(base+'/drafts',{request_key:'cli-release-upgrade-draft',expected_revision:product.revision,name:product.name,model});
    const upgrade={...request,request_key:'cli-release-upgrade',expected_revision:saved.product.revision,expected_release_id:releaseID};
    const next=await call(['releases','create',product.product_id,...await input(upgrade)]);assert.equal(next.status,'published');assert.equal(next.compatibility.compatible,true);
    const conflict=await call(['releases','create',product.product_id,...await input({...upgrade,request_key:'cli-release-conflict'})],4);assert.equal(conflict.status,'conflict');
    model.model_version='0.1.0';const invalid=await cloud.call(base+'/drafts',{request_key:'cli-release-invalid-draft',expected_revision:saved.product.revision,name:product.name,model});
    const rejectedInput={...upgrade,request_key:'cli-release-rejected',expected_revision:invalid.product.revision,expected_release_id:next.release.artifact.statement.release_id};
    const rejected=await call(['releases','create',product.product_id,...await input(rejectedInput)],7);assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'incompatible_release_model');
    const finalPosts=(await fixture()).release_posts;assert.equal((await call(['releases','create',product.product_id,...await input(rejectedInput)],7)).operation_id,rejected.operation_id);assert.equal((await fixture()).release_posts,finalPosts);
    assert.equal((await cloud.call(base)).validation,'unvalidated');await call(['auth','logout']);
  }finally{await fixture({});await rm(dir,{recursive:true,force:true})}
});
