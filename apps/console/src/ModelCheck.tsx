import { useEffect, useRef, useState } from 'react';
import { errorText, type Call } from '@limeiot/control-ui/api.ts';
import { parseDraftJSON } from '../../../packages/protocol/products.mjs';
import { verifyModelReport, type ModelReport } from '../../../packages/protocol/model-validation.mjs';

export function ModelCheck({text,call,disabled}:{text:string;call:Call;disabled:boolean}) {
  const [result,setResult]=useState<{text:string;report?:ModelReport;error?:string}>(),[busy,setBusy]=useState(false);
  const alive=useRef(true),running=useRef(false);
  useEffect(()=>()=>{alive.current=false},[]);
  async function validate() {
    if(running.current)return;running.current=true;setBusy(true);setResult(undefined);
    try {
      let model;try{model=parseDraftJSON(text)}catch{throw new Error('invalid_draft_document')}
      const report=await verifyModelReport(await call('/api/console/v1/models/validate',{model}),model);
      if(alive.current)setResult({text,report});
    }catch(error){if(alive.current)setResult({text,error:error instanceof Error&&error.message==='invalid_draft_document'?'请检查物模型 JSON 格式与大小':errorText(error)})}
    finally{running.current=false;if(alive.current)setBusy(false)}
  }
  const current=result?.text===text?result:undefined;
  return <section className="section"><div className="heading"><h2>模型校验</h2><button type="button" disabled={disabled||busy} onClick={()=>void validate()}>{busy?'正在校验…':'校验当前输入'}</button></div>
    {current?.error&&<p className="notice error" role="alert">{current.error}</p>}
    {current?.report&&<><p className={current.report.valid?'notice':'notice error'} role="status">{current.report.valid?'当前输入校验通过，尚未发布':'当前输入未通过校验'}</p>
      {current.report.valid?<dl><dt>正文摘要</dt><dd className="small">{current.report.document_digest}</dd><dt>候选模型修订</dt><dd className="small">{current.report.model_revision}</dd></dl>:<div className="table-scroll"><table><thead><tr><th>位置</th><th>问题</th></tr></thead><tbody>{current.report.issues.map((issue,index)=><tr key={index}><td><code>{issue.path||'/'}</code></td><td>{issue.code}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
