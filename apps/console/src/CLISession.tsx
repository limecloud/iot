import { useState } from 'react';
import { errorText, when, type Call } from '@limeiot/control-ui/api.ts';
interface Material {version:1; origin:string; audience:'console'; session:string; principal_id:string; expires_at:string}
export function CLISession({call}:{call:Call}) {
  const [material,setMaterial]=useState<Material>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function create(){if(busy)return;setBusy(true);setError('');try{setMaterial(await call<Material>('/api/console/v1/auth/cli',{}))}catch(e){setError(errorText(e))}finally{setBusy(false)}}
  return <details className="section"><summary>CLI 会话</summary><p>有效期最长一小时，退出当前网页登录后失效。会话材料仅供本人导入 CLI。</p>{!material&&<button disabled={busy} onClick={()=>void create()}>创建 CLI 会话</button>}{error&&<p role="alert" className="notice error">{error}</p>}{material&&<><p>有效期至 {when(material.expires_at)}</p><label htmlFor="cli-material">CLI 会话材料</label><textarea id="cli-material" readOnly value={JSON.stringify(material)} spellCheck={false}/><button onClick={()=>setMaterial(undefined)}>隐藏会话材料</button></>}</details>;
}
