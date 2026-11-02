import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentDigest } from '../packages/protocol/model-validation.mjs';
import { parsePublishInput, verifyPublisher, verifyPublication, verifyPublishOperation } from '../packages/protocol/model-publication.mjs';
import { MODEL_CHECKER, MODEL_VALIDATOR, LEGACY_CHECKER, LEGACY_VALIDATOR } from '../packages/protocol/model-contracts.mjs';

const f=JSON.parse(await readFile(new URL('../contracts/examples/model-release.json',import.meta.url),'utf8'));
const publication={artifact:f.artifact,trust:f.trust};
const publisher={issuer:f.trust.issuer,publisher_id:f.trust.publisher_id,namespace:f.trust.namespace,trust:f.trust};
const input={request_key:'publication-boundary',expected_revision:f.artifact.statement.source_revision,expected_release_id:null,visibility:'public'};
async function operation() {
  return {operation_id:'relop-'+'1'.repeat(64),principal_id:f.principal_id,product_id:f.artifact.statement.product_id,
    request_digest:(await documentDigest({kind:'releases.create',product_id:f.artifact.statement.product_id,request:input})).slice(7),
    request:input,status:'published',reason:null,source_revision:input.expected_revision,source_document_digest:f.artifact.statement.source_document_digest,
    head_release_id:null,validation:{version:1,validator:'limeiot.model/1.0.0',valid:true,document_digest:f.artifact.statement.source_document_digest,
      model_revision:f.artifact.statement.model_revision,normalized_model:f.artifact.statement.model,issues:[]},compatibility:null,release:publication,created_at:f.artifact.statement.published_at};
}
test('发布输入必须明确固定草稿、基线与公开范围，重复键不被JSON解析掩盖',()=>{
  assert.deepEqual(parsePublishInput(JSON.stringify(input)),input);
  for(const mutate of [v=>{delete v.expected_release_id},v=>{v.expected_release_id=''},v=>{v.expected_release_id=false},v=>{v.visibility='private'},v=>{v.model={}},v=>{v.expected_revision=null}]) {
    const bad=structuredClone(input);mutate(bad);assert.throws(()=>parsePublishInput(JSON.stringify(bad)));
  }
  assert.throws(()=>parsePublishInput('{"request_key":"a","request_key":"b","expected_revision":"x","expected_release_id":null,"visibility":"public"}'));
});
test('发布身份和API结果绑定当前主体、产品、原输入及规范模型',async()=>{
  assert.deepEqual(await verifyPublisher(publisher,f.principal_id),publisher);
  await assert.rejects(verifyPublisher(publisher,'p-'+'0'.repeat(64)));
  await verifyPublication(publication,{product_id:f.artifact.statement.product_id,publisher,principal:f.principal_id});
  const good=await operation();await verifyPublishOperation(good,f.principal_id,{product_id:good.product_id,request:input});
  for(const mutate of [v=>{v.principal_id='p-'+'0'.repeat(64)},v=>{v.request_digest='0'.repeat(64)},v=>{v.product_id='product-'+'0'.repeat(64)},
    v=>{v.request.expected_release_id='release-'+'0'.repeat(64)},v=>{v.source_revision='prodrev-'+'0'.repeat(64)},v=>{v.validation.document_digest='sha256:'+'0'.repeat(64)},
    v=>{v.validation.normalized_model.model_version='9.0.0'},v=>{v.release.artifact.statement.model_revision='sha256:'+'0'.repeat(64)},
    v=>{v.release.trust.namespace='limeiot'},v=>{v.reason='invalid_release_model'},v=>{delete v.compatibility},v=>{v.status='rejected'}]) {
    const bad=structuredClone(good);mutate(bad);await assert.rejects(verifyPublishOperation(bad,f.principal_id));
  }
  await assert.rejects(verifyPublishOperation(good,f.principal_id,{product_id:good.product_id,request:{...input,request_key:'different'}}));
});
test('冲突和拒绝不能携带成功制品，历史冲突必须对应原请求中的修订变化',async()=>{
  const good=await operation(),conflict={...good,status:'conflict',reason:'draft_revision_conflict',release:null,validation:null,source_revision:'prodrev-'+'2'.repeat(64)};
  await verifyPublishOperation(conflict,f.principal_id);
  await assert.rejects(verifyPublishOperation({...conflict,source_revision:input.expected_revision},f.principal_id));
  await assert.rejects(verifyPublishOperation({...conflict,release:publication},f.principal_id));
  const rejected={...good,status:'rejected',reason:'release_model_namespace_mismatch',release:null};
  await verifyPublishOperation(rejected,f.principal_id);
  await assert.rejects(verifyPublishOperation({...rejected,reason:'invalid_release_model'},f.principal_id));
});
test('发布升级接受当前兼容性合同，旧版报告保持版本约束并拒绝未知版本',async()=>{
  for(const [checker,validator] of [[MODEL_CHECKER,MODEL_VALIDATOR],[LEGACY_CHECKER,LEGACY_VALIDATOR]]) {
    const value=structuredClone(await operation());
    value.request.expected_release_id='release-'+'2'.repeat(64);
    value.head_release_id=value.request.expected_release_id;
    value.request_digest=(await documentDigest({kind:'releases.create',product_id:value.product_id,request:value.request})).slice(7);
    value.validation.validator=validator;
    const baseline=structuredClone(value.validation);
    baseline.document_digest=baseline.model_revision;
    value.compatibility={version:1,checker,valid:true,compatible:false,
      comparison_digest:await documentDigest({baseline:baseline.normalized_model,candidate:value.validation.normalized_model}),
      baseline,candidate:value.validation,issues:[{code:'model_version_not_increased',path:'/model_version'}]};
    value.status='rejected';value.reason='incompatible_release_model';value.release=null;
    await verifyPublishOperation(value,f.principal_id);
    const unknown=structuredClone(value);unknown.compatibility.checker='limeiot.model-compatibility/99.0.0';
    await assert.rejects(verifyPublishOperation(unknown,f.principal_id));
    if(checker===MODEL_CHECKER) {
      const mixed=structuredClone(value);mixed.compatibility.checker=LEGACY_CHECKER;
      await assert.rejects(verifyPublishOperation(mixed,f.principal_id));
    }
  }
});
