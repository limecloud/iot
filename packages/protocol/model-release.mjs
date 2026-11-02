import { parseBoundedJSON } from './products.mjs';
import { canonicalJSON, documentDigest } from './model-validation.mjs';

export function parseReleaseVerificationJSON(text) {
  const value=parseBoundedJSON(text,{maxBytes:16384,maxDepth:19,maxNodes:4096});
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='artifact,trust' ||
      [value.artifact,value.trust].some(item=>!item||typeof item!=='object'||Array.isArray(item)) ||
      new TextEncoder().encode(canonicalJSON(value)).length>16384) throw new Error('invalid_verification_document');
  return value;
}

// CLI只核对固定报告及两个输入的绑定。密码学和制品语义均由共享Rust组件执行。
export async function verifyReleaseReport(value,source) {
  const invalid=()=>{throw new Error('invalid_release_report')};
  if (!value || Object.keys(value).sort().join(',')!=='artifact_digest,issues,release,trust_digest,valid,verifier,version' ||
      value.version!==1 || value.verifier!=='limeiot.model-release/1.0.0' || typeof value.valid!=='boolean' ||
      !Array.isArray(value.issues) || value.issues.length>32 ||
      value.issues.some(issue=>!issue||Object.keys(issue).sort().join(',')!=='code,path'||typeof issue.path!=='string'||issue.path.length>1024||!/^(?:\/(?:[^~/]|~[01])*)*$/.test(issue.path)||!/^[a-z][a-z0-9_]{0,63}$/.test(issue.code??''))) invalid();
  if (value.artifact_digest !== (source===undefined?null:await documentDigest(source.artifact)) ||
      value.trust_digest !== (source===undefined?null:await documentDigest(source.trust))) invalid();
  if (value.valid) {
    if (source===undefined||!value.release||typeof value.release!=='object'||Array.isArray(value.release)||value.issues.length ||
        value.artifact_digest!==await documentDigest(value.release)) invalid();
  } else if(value.release!==null||!value.issues.length) invalid();
  return value;
}
