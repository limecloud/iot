import type { ModelReport } from './model-validation.mjs';
export interface ModelComparison {
  version: number;
  checker: string;
  valid: boolean;
  compatible: boolean | null;
  comparison_digest: string | null;
  baseline: ModelReport | null;
  candidate: ModelReport | null;
  issues: Array<{path:string;code:string}>;
}
export function parseComparisonJSON(text:string): {baseline:unknown;candidate:unknown};
export function verifyComparisonReport(value:unknown, source?:{baseline:unknown;candidate:unknown}): Promise<ModelComparison>;
