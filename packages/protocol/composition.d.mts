import type { RuleSimulation } from './rule-simulation.mjs';
export interface CompositionRule { version: 1; id: string; trigger: {device: string; event: string}; conditions: []; actions: {device: string; set: {path: string; value: unknown}}[]; cooldown_ms: number }
export interface CompositionPackage { schema_version: 1; package_id: string; version: string; name: string; modules: Record<string, {model_revision: string}>; rule: CompositionRule; sample_event_data: Record<string, unknown> }
export interface CompiledComposition { schema_version: 1; package_id: string; package_version: string; package_digest: string; bindings_digest: string; rule_revision: string; expected_models: {role: string; device_id: string; model_revision: string}[]; required_permissions: {kind: string; device_id: string; path: string}[]; rule: CompositionRule; simulation_input: {rule: CompositionRule; event: {device_id: string; path: string; historical: false; data: Record<string, unknown>}}; gateway_checked: boolean; deployed: false }
export interface CompositionPlan extends CompiledComposition { gateway_checked: true; checked_at: string; gateway_origin: string; space_id: string; validation: {valid: boolean; revision: string}; simulation: RuleSimulation }
export interface CompositionAttempt { version: 1; origin: string; space_id: string; package: CompositionPackage; bindings: Record<string, string>; instance_id: string; rule_revision: string; state: 'attempted' | 'acknowledged' | 'rejected'; checksum: string }
export type CompositionRequest = (resource: string, input?: unknown) => Promise<any>;
export function parseComposition(raw: string): CompositionPackage;
export function compileComposition(packageText: string, bindingsText: string, instanceID: string): Promise<CompiledComposition>;
export function checkCompositionModels(compiled: CompiledComposition, request: CompositionRequest, space: string): Promise<void>;
export function planComposition(compiled: CompiledComposition, options: {request: CompositionRequest; origin: string; space: string; active?: () => boolean}): Promise<CompositionPlan>;
export function parseCompositionAttempt(raw: string, origin: string, space: string): Promise<{record: CompositionAttempt; compiled: CompiledComposition}>;
