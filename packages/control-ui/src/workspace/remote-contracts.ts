import { verifyConfirmedReceipt } from "../../../protocol/command-receipts.mjs";
import { documentDigest } from "../../../protocol/model-validation.mjs";
import { APIError, type Entry } from "./api";
import { remoteSchema, sameJSON, type Remote } from "./contracts";

// 复用共享回执校验器，原请求和历史记录均不依赖当前设备模型。
export async function verifyRemote(raw: unknown, entry: Entry, principal: string): Promise<Remote> {
  const result = remoteSchema.parse(raw);
  const normalize = (value: Record<string, unknown>) => ({ ...value, expires_at: Date.parse(String(value.expires_at)) });
  if (result.principal_id !== principal || result.space_id !== entry.scope ||
      !sameJSON(normalize(result.request), normalize(entry.input)) ||
      result.request_digest !== (await documentDigest(result.request)).slice(7)) throw new APIError("invalid_response");
  if (result.status === "confirmed") {
    try {
      await verifyConfirmedReceipt(result.local_result, {
        space_id: result.local_space_id, idempotency_key: result.remote_id,
        device_id: result.request.device_id, model_revision: result.request.model_revision,
        expires_at: result.request.expires_at, operation: result.request.operation,
      });
    } catch { throw new APIError("invalid_response"); }
  }
  return result;
}
