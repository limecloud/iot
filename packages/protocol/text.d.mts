export interface TextMessage { role: 'user' | 'assistant'; content: string }
export interface TextRequest { instructions: string; messages: TextMessage[]; retain_seconds: number; expires_at: string }
export interface TextInput { context_digest: string; context_bytes: number; message_count: number; retain_seconds: number; expires_at: string }
export interface TextOriginal { version: 1; origin: string; space_id: string; idempotency_key: string; input: TextInput; request_digest: string }
export interface TextDeployment { adapter: 'ollama-text-v1'; revision: string; model: string; data_location: 'local' }
export interface TextTask { text_id: string; space_id: string; idempotency_key: string; request_digest: string; input: TextInput; deployment: TextDeployment; created_at: string; updated_at: string; status: 'running' | 'succeeded' | 'failed' | 'unknown' | 'discarded'; output: { text: string | null; content_digest: string; expires_at: string; cleared_at: string | null } | null; usage: { input_tokens: number; output_tokens: number } | null; error_code: string | null }
export type TextCapabilities = { configured: false; capability: 'text.generate' } | { configured: true; capability: 'text.generate'; deployment: TextDeployment; max_messages: 15; max_context_bytes: 8192; max_instructions_characters: 1024; max_text_bytes: 8192; max_characters: 2048; max_output_tokens: 1024; max_deadline_seconds: 90; max_retain_seconds: 3600; concurrency: 1; streaming: false; provider_cancellation: false; input_storage: 'digest_only'; server_memory: false; device_execution: false };
export const textRequestBytes: number;
export function parseTextInput(raw: string): TextRequest;
export function createTextOriginal(origin: string, space: string, key: string, input: TextRequest): Promise<TextOriginal>;
export function validTextOriginal(value: unknown, origin: string, space: string, key: string): value is TextOriginal;
export function verifyTextTask(value: unknown, space: string, key: string, expected?: TextOriginal): Promise<TextTask>;
export function verifyTextCapabilities(value: unknown): TextCapabilities;
