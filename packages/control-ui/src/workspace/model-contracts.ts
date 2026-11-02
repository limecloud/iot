import { z } from "zod";
import { APIError } from "./api";
import { parseDraft } from "./contracts";

export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const validatorSchema = z.enum(["limeiot.model/1.0.0", "limeiot.model/1.1.0"]);
export const checkerSchema = z.enum(["limeiot.model-compatibility/1.0.0", "limeiot.model-compatibility/1.1.0"]);
export function legacyModel(model: Record<string, unknown> | null) {
  return model?.schema_version === 1 && Array.isArray(model.services) &&
    model.services.every(service => service && Array.isArray(service.actions) && service.actions.length === 0);
}
export const issueSchema = z.object({
  path: z.string().max(1024).regex(/^(?:\/(?:[^~/]|~[01])*)*$/),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
}).strict();
export const reportSchema = z.object({
  version: z.literal(1), validator: validatorSchema, valid: z.boolean(),
  document_digest: digestSchema.nullable(), model_revision: digestSchema.nullable(),
  normalized_model: z.record(z.string(), z.unknown()).nullable(),
  issues: z.array(issueSchema).max(32),
}).strict();
export type Report = z.infer<typeof reportSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
export async function textHash(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const digest = async (value: unknown) => "sha256:" + await textHash(canonical(value));

// 只核对API报告与当前输入的绑定；模型语义仍由共享Rust校验器判断。
export async function verifyReport(report: Report, sourceDigest: string) {
  if (report.document_digest !== sourceDigest) throw new APIError("invalid_response");
  if (report.valid) {
    if (report.validator === "limeiot.model/1.0.0" && !legacyModel(report.normalized_model) ||
      report.issues.length || report.normalized_model === null || report.model_revision !== await digest(report.normalized_model)) throw new APIError("invalid_response");
    parseDraft(JSON.stringify(report.normalized_model));
  } else if (!report.issues.length || report.normalized_model !== null || report.model_revision !== null) throw new APIError("invalid_response");
  return report;
}
