import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { parseBoundedJSON, parseDraftJSON } from '../../protocol/products.mjs';
import { verifyModelReport } from '../../protocol/model-validation.mjs';
import { parseComparisonJSON, verifyComparisonReport } from '../../protocol/model-compatibility.mjs';
import { parseReleaseVerificationJSON, verifyReleaseReport } from '../../protocol/model-release.mjs';

async function inputFile(path, limit) {
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('input_required');
    const buffer=Buffer.alloc(limit+1);let size=0;
    while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead}
    return buffer.subarray(0,size);
  } finally {await file.close()}
}

export async function runModel(args) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals:true, options:{input:{type:'string'},trust:{type:'string'},json:{type:'boolean'}} });
    if (positionals.length !== 1 || !['validate','compare','verify'].includes(positionals[0]) || !values.input) throw new Error('input_required');
    const compare=positionals[0]==='compare';
    const verify=positionals[0]==='verify';
    if(verify&&!values.trust)throw new Error('trust_required');
    if(!verify&&values.trust)throw new Error('input_required');
    let raw=await inputFile(values.input,verify?12288:compare?16416:8192);
    if(verify)raw=Buffer.concat([Buffer.from('{"artifact":'),raw,Buffer.from(',"trust":'),await inputFile(values.trust,2048),Buffer.from('}')]);
    const configured=process.env.LIMEIOT_MODEL_VALIDATOR;
    if (configured && !isAbsolute(configured)) throw new Error('absolute_model_validator_path_required');
    const { output, code } = await new Promise((resolve,reject) => {
      const child=spawn(configured??'limeiot-model-validator',verify?['--verify-release']:compare?['--compare']:[],{env:{PATH:process.env.PATH??''},stdio:['pipe','pipe','ignore']});
      const chunks=[];let size=0;
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('validator_unavailable'));},3500);
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536){child.kill('SIGKILL');return}chunks.push(chunk)});
      child.stdin.on('error',()=>{});child.stdin.end(raw);
      child.once('error',()=>{clearTimeout(timer);reject(new Error('validator_unavailable'))});
      child.once('close',code=>{clearTimeout(timer);if(size>65536||![0,2].includes(code))reject(new Error('validator_unavailable'));else resolve({output:Buffer.concat(chunks),code})});
    });
    let source;try {source=(verify?parseReleaseVerificationJSON:compare?parseComparisonJSON:parseDraftJSON)(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw))}catch{}
    let report;try {report=await (verify?verifyReleaseReport:compare?verifyComparisonReport:verifyModelReport)(parseBoundedJSON(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(output),{maxBytes:65536,maxDepth:32,maxNodes:8192}),source)}catch{throw new Error('validator_unavailable')}
    const accepted=compare?report.compatible===true:report.valid;
    if(accepted !== (code===0))throw new Error('validator_unavailable');
    console.log(JSON.stringify(report));process.exitCode=accepted?0:2;
  } catch(error) {
    const code=['input_required','trust_required','absolute_model_validator_path_required'].includes(error.message)?error.message:'validator_unavailable';
    console.error(JSON.stringify({error:{code}}));process.exitCode=['input_required','trust_required'].includes(code)?2:5;
  }
}
