import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const problem = code => Object.assign(new Error(code), {code});
// 凭据和原请求只使用当前用户的普通文件；拒绝符号链接和宽松权限。
export async function privateDirectory(directory, create=false) {
  if(create) await mkdir(directory,{recursive:true,mode:0o700});
  const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||await realpath(directory)!==path.resolve(directory))throw problem('private_directory_required');
}
export async function readPrivate(file) {
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>65536)throw problem('private_file_required');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {await handle.close()}
}
export async function createPrivate(file,value) {
  await privateDirectory(path.dirname(file),true);
  const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync()}finally{await handle.close()}
  const directory=await open(path.dirname(file),constants.O_RDONLY);
  try{await directory.sync()}finally{await directory.close()}
}
export async function clearSession(file) {
  return writePrivate(file,{logged_out:true});
}
export async function writePrivate(file,value) {
  const handle=await open(file,constants.O_WRONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw problem('private_file_required');
    await handle.truncate(0);await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();
  } finally {await handle.close()}
}
export async function readPrivateToken(file) {
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>4096)throw problem('private_file_required');
    const token=(await handle.readFile('utf8')).trim();if(token.length<32||token.length>4096)throw problem('invalid_token_file');return token;
  }finally{await handle.close()}
}
