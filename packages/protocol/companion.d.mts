import type { VoiceStage, VoiceTextContext, VoiceTurn, VoiceTurnView } from './voice-turns.mjs';

export interface CompanionPolicy {
  schema_version: 1; policy_id: string; version: string; name: string; instructions: string;
  language: 'auto' | 'zh' | 'en'; voice: string; max_turns: number; max_seconds: number;
}
export interface CompanionSession {
  version: 1; origin: string; space_id: string; session_id: string; previous_ids: string[];
  policy_digest: string; deployments: Record<VoiceStage, string>; created_at: string; expires_at: string;
  max_turns: number; stopped: boolean; history: { digest: string; message_count: number };
  turns: Array<{ turn_id: string; media_id: string; context_digest: string; completed: boolean; record: VoiceTurn | null }>;
  checksum: string;
}
export interface CompanionView {
  record: CompanionSession; phase: VoiceTurnView['phase'] | 'prepared' | 'paused';
  history_available: boolean; turns_remaining: number; can_reply: boolean; stop_settled: boolean;
  turn: VoiceTurnView | null;
}
export function parseCompanionPolicy(raw: string): CompanionPolicy;
export function parseCompanionSession(raw: string, origin: string, space: string): Promise<CompanionSession>;
export class CompanionClient {
  constructor(options: {
    origin: string; space: string;
    journal: { load(): Promise<string | null>; save(previous: CompanionSession | null, next: CompanionSession): Promise<void> };
    request: (resource: string, input?: unknown, key?: string) => Promise<unknown>;
    policy?: CompanionPolicy; history?: VoiceTextContext['history']; signal?: AbortSignal; active?: () => boolean; now?: () => number;
  });
  history: VoiceTextContext['history'] | undefined;
  load(): Promise<CompanionSession | null>;
  start(sessionID: string): Promise<CompanionView>;
  reply(mediaID: string): Promise<CompanionView>;
  resolve(): Promise<CompanionView>;
  continue(): Promise<CompanionView>;
  stop(): Promise<CompanionView>;
}
