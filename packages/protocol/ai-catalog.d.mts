export type AiCapabilityId = 'automation.rule_draft' | 'text.generate' | 'vision.understand' | 'audio.transcribe' | 'audio.synthesize';
export interface AiDefinition {
  capability_id: AiCapabilityId;
  input_modalities: string[];
  output_modalities: string[];
  input_schema: string;
  task_schema: string | null;
  create_operation: string;
  resolve_operation: string;
  streaming: false;
  tool_calling: false;
  structured_output: boolean;
  device_execution: false;
}
export interface AiDeployment {
  capability_id: AiCapabilityId;
  identity: { adapter: string; revision: string | null; model: string; data_location: 'local' };
  configuration: Record<string, string | number | boolean | string[]>;
  license: null;
  cost_policy: null;
  resource_requirements: null;
  quality: null;
}
export interface AiCatalog {
  schema_version: 1;
  space_id: string;
  definitions: AiDefinition[];
  deployments: AiDeployment[];
  health: { capability_id: AiCapabilityId; status: 'unknown' | 'not_configured'; checked_at: null }[];
  routing: { selection: 'fixed_configuration'; automatic_fallback: false };
}
export function verifyAiCatalog(value: unknown, space: string): AiCatalog;
export function parseAiCatalog(raw: string, space: string): AiCatalog;
