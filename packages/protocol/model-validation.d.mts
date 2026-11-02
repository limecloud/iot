export interface ModelReport {
  version: number;
  validator: string;
  valid: boolean;
  document_digest: string | null;
  model_revision: string | null;
  normalized_model: Record<string, unknown> | null;
  issues: Array<{path:string;code:string}>;
}
export function canonicalJSON(value: unknown): string;
export function documentDigest(value: unknown): Promise<string>;
export function verifyModelReport(value: unknown, source?: unknown): Promise<ModelReport>;
export function verifyModelReportDigest(value: unknown, sourceDigest: string | null): Promise<ModelReport>;
