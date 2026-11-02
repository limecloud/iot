export interface FirmwareManifest {
  schema: 'limeiot.ota-manifest'; version: 1; algorithm: 'Ed25519'; signing_key_id: string; signature: string;
  statement: {
    artifact_id: string; kind: 'device-firmware'; version: string; security_epoch: number; size_bytes: number; sha256: string;
    target: { product_id: string; architecture: string; chip: string; board: string; hardware_revisions: string[] };
    download: { url: string; redirects: false }; compatibility: Record<string, unknown>; issued_at: string; expires_at: string;
  };
}
export interface FirmwareTrustMaterial {
  schema: 'limeiot.ota-trust'; version: 1; purpose: 'device-firmware'; signing_key_id: string; public_key: string;
  product_ids: string[]; download_origins: string[]; minimum_security_epoch: number; minimum_battery_percent: number;
  revoked_artifact_ids: string[]; not_before: string; expires_at: string;
}
export type OtaChange =
  | { type: 'trust.add'; trust: FirmwareTrustMaterial; expected_signing_key_id: string }
  | { type: 'trust.revoke'; trust_id: string; expected_revision: string }
  | { type: 'tasks.plan'; device_id: string; trust_id: string; manifest: FirmwareManifest; expires_at: string }
  | { type: 'tasks.approve' | 'tasks.execute' | 'tasks.reconcile' | 'tasks.cancel'; task_id: string; expected_revision: string };
export interface OtaRequest { space_id: string; idempotency_key: string; change: OtaChange }
export interface FirmwareTrust { trust_id: string; revision: string; trust: FirmwareTrustMaterial; active: boolean; created_at: string; revoked_at: string | null }
export interface FirmwareDeviceInfo {
  device_id: string; product_id: string; architecture: string; chip: string; board: string; hardware_revision: string;
  firmware_version: string; bootloader_version: string; protocol_version: number; model_revision: string; security_epoch: number;
  ota_capacity_bytes: number; external_power: boolean; battery_percent: number | null; safe_to_update: boolean; pending_update: boolean;
}
export interface FirmwareDeviceReport { device: FirmwareDeviceInfo; boot_id: string; session_id: string; seq: number; received_at: string }
export interface OtaTask {
  task_id: string; revision: string; device_id: string; trust_id: string; trust_revision: string; manifest: FirmwareManifest;
  manifest_digest: string; baseline: FirmwareDeviceReport; created_at: string; expires_at: string;
  status: 'planned' | 'approved' | 'executing' | 'unknown' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'invalidated';
  approval: { approved_at: string; device_info: FirmwareDeviceReport } | null;
  execution: (Record<string, unknown> & { request_digest: string; query_count: number }) | null; reason: string | null;
}
export interface OtaOperation {
  operation_id: string; request: OtaRequest; request_digest: string; status: 'applied' | 'rejected' | 'conflict'; reason: string | null;
  resource: { kind: 'firmware_trust' | 'ota_task'; id: string; revision: string } | null; created_at: string;
}
export function validOtaChange(value: unknown): value is OtaChange;
export function parseOtaChange(text: string): OtaChange;
export function parseOtaResponse(text: string): unknown;
export function verifyFirmwareTrust(value: unknown): Promise<FirmwareTrust>;
export function verifyOtaTask(value: unknown): Promise<OtaTask>;
export function verifyOtaOperation(value: unknown, expected?: OtaRequest): Promise<OtaOperation>;
