import { parseBoundedJSON, sameJSON } from './products.mjs';
import { canonicalJSON, documentDigest, verifyModelReportDigest } from './model-validation.mjs';
import { releaseContract, MODEL_CHECKER, LEGACY_CHECKER, LEGACY_VALIDATOR } from './model-contracts.mjs';

const hex=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'[a-f0-9]{64}$').test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,names)=>object(value)&&Object.keys(value).sort().join(',')===names.split(',').sort().join(',');
const fail=()=>{throw new Error('invalid_publication_response')};
export function validPublishInput(value) {
  return fields(value,'request_key,expected_revision,expected_release_id,visibility')&&
    typeof value.request_key==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.request_key)&&hex(value.expected_revision,'prodrev-')&&
    (value.expected_release_id===null||hex(value.expected_release_id,'release-'))&&value.visibility==='public';
}
export function parsePublishInput(text) {
  const value=parseBoundedJSON(text,{maxBytes:1024,maxDepth:1,maxNodes:5});
  if(!validPublishInput(value))throw new Error('invalid_publish_input');
  return value;
}
async function textHash(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function verifyPublisher(value,principal) {
  if(!fields(value,'issuer,publisher_id,namespace,trust')||!hex(principal,'p-'))fail();
  let url;try{url=new URL(value.issuer)}catch{fail()}
  if(value.issuer!==url.origin||url.username||url.password||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','[::1]'].includes(url.hostname))fail();
  const digest=await textHash('LimeIoT Publisher v1\n'+value.issuer+'\n'+principal);
  if(value.publisher_id!=='publisher-'+digest||value.namespace!=='p-'+digest.slice(0,30))fail();
  if(value.trust!==null)checkTrust(value.trust,value);
  return value;
}
function checkTrust(trust,publisher) {
  if(!fields(trust,'version,issuer,publisher_id,namespace,signing_key_id,public_key')||trust.version!==1||
    trust.issuer!==publisher.issuer||trust.publisher_id!==publisher.publisher_id||trust.namespace!==publisher.namespace||
    !hex(trust.signing_key_id,'sha256:')||typeof trust.public_key!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(trust.public_key))fail();
}

// 核对可信API返回的资源、摘要与范围；密码学及模型语义仍由Rust组件判断。
export async function verifyPublication(value,expected={}) {
  if(!fields(value,'artifact,trust'))fail();
  parseBoundedJSON(canonicalJSON(value.artifact),{maxBytes:12288,maxDepth:18,maxNodes:2304});
  parseBoundedJSON(canonicalJSON(value.trust),{maxBytes:2048,maxDepth:2,maxNodes:16});
  const artifact=value.artifact,s=artifact?.statement;
  if(!fields(artifact,'version,algorithm,signing_key_id,statement,signature')||artifact.version!==1||artifact.algorithm!=='Ed25519'||
    !fields(s,'issuer,publisher_id,namespace,product_id,release_id,source_revision,source_document_digest,visibility,validator,compatibility_checker,model_revision,model,baseline,published_at')||
    !hex(s.publisher_id,'publisher-')||s.namespace!=='p-'+s.publisher_id.slice(10,40)||
    !hex(s.product_id,'product-')||!hex(s.release_id,'release-')||!hex(s.source_revision,'prodrev-')||!hex(s.source_document_digest,'sha256:')||
    s.visibility!=='public'||!releaseContract(s)||
    typeof artifact.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(artifact.signature)||
    !object(s.model)||s.model_revision!==await documentDigest(s.model)||typeof s.model.model_id!=='string'||!s.model.model_id.startsWith('urn:'+s.namespace+':')||
    typeof s.published_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.published_at)||!Number.isFinite(Date.parse(s.published_at)))fail();
  checkTrust(value.trust,s);
  if(artifact.signing_key_id!==value.trust.signing_key_id)fail();
  if(s.baseline!==null&&(!fields(s.baseline,'release_id,model_revision,model_version')||!hex(s.baseline.release_id,'release-')||
    !hex(s.baseline.model_revision,'sha256:')||typeof s.baseline.model_version!=='string'))fail();
  if(expected.product_id&&s.product_id!==expected.product_id||expected.release_id&&s.release_id!==expected.release_id||
    expected.publisher&&['issuer','publisher_id','namespace'].some(key=>s[key]!==expected.publisher[key]))fail();
  if(expected.principal)await verifyPublisher({issuer:s.issuer,publisher_id:s.publisher_id,namespace:s.namespace,trust:value.trust},expected.principal);
  return value;
}
export async function verifyPublishOperation(value,principal,expected) {
  if(!fields(value,'operation_id,principal_id,product_id,request_digest,request,status,reason,source_revision,source_document_digest,head_release_id,validation,compatibility,release,created_at')||
    !hex(value.operation_id,'relop-')||value.principal_id!==principal||!hex(value.product_id,'product-')||!hex(value.request_digest,'')||
    !validPublishInput(value.request)||!['published','rejected','conflict'].includes(value.status)||!hex(value.source_revision,'prodrev-')||!hex(value.source_document_digest,'sha256:')||
    value.head_release_id!==null&&!hex(value.head_release_id,'release-')||!Number.isFinite(Date.parse(value.created_at))||
    expected&&(value.product_id!==expected.product_id||!sameJSON(value.request,expected.request)))fail();
  const digest=await documentDigest({kind:'releases.create',product_id:value.product_id,request:value.request});
  if(digest!=='sha256:'+value.request_digest)fail();
  if(value.status==='conflict') {
    if(value.release!==null||value.validation!==null||value.compatibility!==null||
      !['draft_revision_conflict','release_baseline_conflict'].includes(value.reason)||
      value.reason==='draft_revision_conflict'&&value.source_revision===value.request.expected_revision||
      value.reason==='release_baseline_conflict'&&(value.source_revision!==value.request.expected_revision||value.head_release_id===value.request.expected_release_id))fail();
  } else {
    if(value.source_revision!==value.request.expected_revision||value.head_release_id!==value.request.expected_release_id||value.validation===null)fail();
    await verifyModelReportDigest(value.validation,value.source_document_digest);
    if(value.compatibility!==null) {
      const c=value.compatibility;
      if(!fields(c,'version,checker,valid,compatible,comparison_digest,baseline,candidate,issues')||c.version!==1||![MODEL_CHECKER,LEGACY_CHECKER].includes(c.checker)||
        c.valid!==true||typeof c.compatible!=='boolean'||!hex(c.comparison_digest,'sha256:')||!Array.isArray(c.issues)||c.issues.length>32||c.compatible!==(c.issues.length===0)||
        !sameJSON(c.candidate,value.validation))fail();
      await verifyModelReportDigest(c.baseline,c.baseline?.document_digest);
      if(c.checker===LEGACY_CHECKER&&(c.baseline.validator!==LEGACY_VALIDATOR||c.candidate.validator!==LEGACY_VALIDATOR))fail();
      if(!c.baseline.valid||c.baseline.document_digest!==c.baseline.model_revision)fail();
    }
    if(value.status==='published') {
      if(value.reason!==null||!value.validation.valid||value.request.expected_release_id===null&&value.compatibility!==null||value.request.expected_release_id!==null&&(value.compatibility===null||!value.compatibility.compatible))fail();
      await verifyPublication(value.release,{product_id:value.product_id,principal});
      const s=value.release.artifact.statement;
      if(s.source_revision!==value.source_revision||s.source_document_digest!==value.source_document_digest||s.model_revision!==value.validation.model_revision||
        !sameJSON(s.model,value.validation.normalized_model)||(s.baseline?.release_id??null)!==value.request.expected_release_id||
        s.baseline!==null&&(s.baseline.model_revision!==value.compatibility.baseline.model_revision||s.baseline.model_version!==value.compatibility.baseline.normalized_model.model_version))fail();
    } else if(value.release!==null||!['invalid_release_model','release_model_namespace_mismatch','incompatible_release_model','model_id_already_published'].includes(value.reason)||
      value.reason==='invalid_release_model'&&value.validation.valid||value.reason==='incompatible_release_model'&&(value.compatibility===null||value.compatibility.compatible))fail();
  }
  return value;
}
