import type { Condition } from './condition-form.mjs';
export interface ConditionResult { matched: boolean; reason?: string; model_revision?: string; observation?: { value: unknown; observed_at: string; quality: string; source: string }; children?: ConditionResult[] }
export interface ConditionEvaluation { evaluated_at: string; conditions: Condition[]; matched: boolean; results: ConditionResult[] }
export interface RuleSimulation { revision: string; executed: false; simulation: true; matched: boolean; proposed_actions: unknown[]; trigger_matched?: boolean; condition_evaluation?: ConditionEvaluation }
export function verifyRuleSimulation(rule: { conditions: Condition[]; actions: unknown[] }, proof: RuleSimulation, validation: {valid: boolean; revision: string}): Promise<RuleSimulation>;
