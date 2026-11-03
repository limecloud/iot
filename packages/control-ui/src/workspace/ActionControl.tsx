import { useState } from "react";
import { checkFormValue, sampleValue, type ValueSchema } from "../../../protocol/action-form.mjs";
import type { Action } from "./contracts";
import { useWorkspace } from "./context";

function ActionField({ name, schema, value, change }: {
  name: string; schema: ValueSchema; value: unknown; change: (value: unknown) => void;
}) {
  const { t } = useWorkspace();
  if (schema.enum?.length) return <label>{name}<select aria-label={name} value={JSON.stringify(value)} onChange={event => change(JSON.parse(event.target.value))}>
    {schema.enum.map((item, index) => <option key={index} value={JSON.stringify(item)}>{typeof item === "string" ? item : JSON.stringify(item)}</option>)}
  </select></label>;
  if (schema.type === "object") {
    const current = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return <fieldset className="action-fields"><legend>{name}</legend>{Object.entries(schema.properties ?? {}).map(([key, member]) => {
      const required = schema.required?.includes(key), enabled = Object.hasOwn(current, key);
      return <div key={key}>
        {!required && <label className="checkbox"><input type="checkbox" checked={enabled} onChange={event => {
          const next = { ...current }; if (event.target.checked) next[key] = sampleValue(member); else delete next[key]; change(next);
        }}/>{t("includeActionField", { field: key })}</label>}
        {(required || enabled) && <ActionField name={`${name}.${key}`} schema={member} value={current[key]} change={next => change({ ...current, [key]: next })}/>}
      </div>;
    })}</fieldset>;
  }
  if (schema.type === "boolean") return <label className="checkbox"><input aria-label={name} type="checkbox" checked={value === true} onChange={event => change(event.target.checked)}/>{name}</label>;
  if (schema.type === "integer" || schema.type === "number") return <label>{name}<input aria-label={name} type="number" value={typeof value === "number" ? value : ""} min={schema.minimum} max={schema.maximum} step={schema.type === "integer" ? 1 : "any"} required onChange={event => change(event.target.value === "" ? undefined : Number(event.target.value))}/></label>;
  return <label>{name}<input aria-label={name} value={typeof value === "string" ? value : ""} minLength={schema.minLength} maxLength={schema.maxLength === undefined ? 4096 : schema.maxLength * 2} required={!!schema.minLength} onChange={event => change(event.target.value)}/></label>;
}

export function ActionControl({ path, action, disabled, invoke }: {
  path: string; action: Action; disabled: boolean; invoke: (value: unknown) => void;
}) {
  const { t } = useWorkspace();
  const [value, setValue] = useState(() => sampleValue(action.input));
  const [approved, setApproved] = useState(false);
  const valid = checkFormValue(value, action.input) && new TextEncoder().encode(JSON.stringify(value)).length <= 4096;
  const needsApproval = action.risk !== "low";
  return <form className="device-action" aria-label={path} onSubmit={event => {
    event.preventDefault();
    if (!disabled && valid && (!needsApproval || approved)) { invoke(value); setApproved(false); }
  }}>
    <fieldset disabled={disabled}>
      <legend>{path}</legend>
      <p className="footnote">{t(action.completion === "submitted" ? "actionSubmissionBoundary" : "actionObservationBoundary")}</p>
      <ActionField name={path} schema={action.input} value={value} change={next => { setValue(next); setApproved(false); }}/>
      {needsApproval && <label className="checkbox"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)}/>{t("approveAction", { action: path })}</label>}
      <button disabled={disabled || !valid || needsApproval && !approved}>{t("invokeAction")}</button>
    </fieldset>
  </form>;
}
