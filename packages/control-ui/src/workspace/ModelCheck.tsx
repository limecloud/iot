import { useEffect, useRef, useState } from "react";
import { APIError } from "./api";
import { parseDraft } from "./contracts";
import { useWorkspace } from "./context";
import { ErrorNotice } from "./ui";
import { digest, reportSchema, verifyReport, type Report } from "./model-contracts";

export function ModelCheck({text,disabled}:{text:string;disabled:boolean}) {
  const {call,t}=useWorkspace(),[busy,setBusy]=useState(false),[result,setResult]=useState<{text:string;report?:Report;error?:unknown}>();
  const alive=useRef(true),running=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  async function validate() {
    if(running.current)return;running.current=true;setBusy(true);setResult(undefined);
    try {
      let model:Record<string,unknown>;try{model=parseDraft(text)}catch{throw new APIError("invalid_draft_document")}
      const report=await call("/api/console/v1/models/validate",reportSchema,{model});
      await verifyReport(report,await digest(model));
      if(alive.current)setResult({text,report});
    }catch(error){if(alive.current)setResult({text,error})}
    finally{running.current=false;if(alive.current)setBusy(false)}
  }
  const current=result?.text===text?result:undefined;
  return <section className="panel"><div className="panel-heading"><h2>{t("modelValidation")}</h2><button type="button" disabled={disabled||busy} onClick={()=>void validate()}>{t(busy?"validating":"validateInput")}</button></div>
    {current&&<div className="panel-body">
    <ErrorNotice error={current?.error}/>
    {current?.report&&<><p className={current.report.valid?"notice":"notice notice-error"} role="status">{t(current.report.valid?"modelValid":"modelInvalid")}</p>
      {current.report.valid?<dl><dt>{t("digest")}</dt><dd><code>{current.report.document_digest}</code></dd><dt>{t("candidateRevision")}</dt><dd><code>{current.report.model_revision}</code></dd></dl>:<div className="table-scroll"><table><thead><tr><th>{t("issuePath")}</th><th>{t("issueCode")}</th></tr></thead><tbody>{current.report.issues.map((issue,index)=><tr key={index}><td><code>{issue.path||"/"}</code></td><td>{issue.code}</td></tr>)}</tbody></table></div>}
    </>}</div>}
  </section>;
}
