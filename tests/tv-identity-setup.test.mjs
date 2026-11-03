import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, stat, symlink, mkdir} from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);
const tool = path.join(root, 'tools/tv-agent-enrollment.py');

test('TV公开配置只读取CA且不覆盖已有请求，机器格式区分PEM材料与本机引用', {timeout:30000}, async () => {
  const directory = await mkdtemp(path.join(root, '.dev/tv-identity-setup-'));
  const ca = path.join(directory, 'ca.crt');
  await exec('openssl', ['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=Isolated CA','-keyout',path.join(directory,'ca.key'),'-out',ca,'-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign'], {timeout:10000});
  await mkdir(path.join(directory, 'private.key'));
  await writeFile(path.join(directory, 'identity.json'), 'must not read legacy identity');
  const output = path.join(directory,'setup.json');
  const args = [tool,'--ca-file',ca,'--space-id','space-demo','--device-id','device-tv','--request-id','request-one','--broker','ssl://localhost:8883','--output',output];
  const report = JSON.parse((await exec('python3',args,{timeout:10000})).stdout);
  assert.equal(report.status,'ok');
  assert.match(report.ca_fingerprint,/^sha256:[0-9a-f]{64}$/);
  assert.equal((await stat(output)).mode & 0o777,0o600);
  const bytes = await readFile(output);
  const setup = JSON.parse(bytes);
  assert.equal(setup.request_id,'request-one');
  assert.equal(setup.ca_pem,await readFile(ca,'utf8'));
  assert.ok(!bytes.includes('PRIVATE KEY'));
  assert.ok(!Object.keys(setup).includes('key_reference'));
  await assert.rejects(exec('python3',args,{timeout:10000}));
  assert.deepEqual(await readFile(output),bytes);
  const ajv = new Ajv({strict:true,allErrors:true});
  const validateSetup = ajv.compile(JSON.parse(await readFile(path.join(root,'contracts/tv-agent-identity.schema.json'),'utf8')));
  const validateEnrollment = ajv.compile(JSON.parse(await readFile(path.join(root,'contracts/tv-agent-enrollment.schema.json'),'utf8')));
  assert.equal(validateSetup(setup),true,JSON.stringify(validateSetup.errors));
  for (const profile of ['android-tv-audio-agent','android-tv-audio-remote']) {
    const audioOutput = path.join(directory, profile + '.json');
    const audioArgs = [...args]; audioArgs[audioArgs.indexOf(output)] = audioOutput;
    await exec('python3', [...audioArgs, '--model-profile', profile], {timeout:10000});
    const audioSetup = JSON.parse(await readFile(audioOutput, 'utf8'));
    assert.equal(audioSetup.model_profile, profile);
    assert.equal(validateSetup(audioSetup), true, JSON.stringify(validateSetup.errors));
    assert.equal((await stat(audioOutput)).mode & 0o777, 0o600);
  }
  for (const changed of [{...setup,private_key_pem:'forbidden'},{...setup,key_reference:'foreign'},{...setup,request_id:''},{...setup,schema_version:2}]) assert.equal(validateSetup(changed),false);
  const base = {space_id:setup.space_id,device_id:setup.device_id,broker:setup.broker,ca_pem:setup.ca_pem,certificate_pem:'PUBLIC CERTIFICATE'};
  const one = {...base,schema_version:1,private_key_pem:'PRIVATE KEY'};
  const two = {...one,schema_version:2,model_profile:'android-tv-agent'};
  const three = {...base,schema_version:3,model_profile:'android-tv-agent',request_id:'request-one',key_reference:'limeiot-tv-identity-'+'a'.repeat(32),public_key_fingerprint:'sha256:'+'b'.repeat(64)};
  for (const valid of [one,two,three]) assert.equal(validateEnrollment(valid),true,JSON.stringify(validateEnrollment.errors));
  for (const invalid of [{...one,model_profile:'android-tv-agent'},{...two,key_reference:three.key_reference},{...three,private_key_pem:'forbidden'},{...three,key_reference:'unscoped-alias'},{...three,public_key_fingerprint:'sha256:bad'},{...three,request_id:''},{...three,schema_version:4}]) assert.equal(validateEnrollment(invalid),false);
  const link = path.join(directory,'linked-ca.crt');await symlink(ca,link);
  const linkedArgs = [...args];linkedArgs[linkedArgs.indexOf(ca)] = link;linkedArgs[linkedArgs.indexOf(output)] = path.join(directory,'rejected.json');
  await assert.rejects(exec('python3',linkedArgs,{timeout:10000}));
  await assert.rejects(stat(path.join(directory,'rejected.json')));
  await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,public_configuration:true,strict_schemas:true,no_private_key_transfer:true,hardware:false},null,2)+'\n');
});
