export interface ModelReleaseVerification {
  version: number;
  verifier: string;
  valid: boolean;
  artifact_digest: string | null;
  trust_digest: string | null;
  release: Record<string,unknown> | null;
  issues: Array<{path:string;code:string}>;
}
export function parseReleaseVerificationJSON(text:string): {artifact:Record<string,unknown>;trust:Record<string,unknown>};
export function verifyReleaseReport(value:unknown,source?:{artifact:Record<string,unknown>;trust:Record<string,unknown>}): Promise<ModelReleaseVerification>;
