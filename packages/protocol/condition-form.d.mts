export interface ConditionSchema { type: string; minimum?: number; maximum?: number; enum?: unknown[]; minLength?: number; maxLength?: number }
export type ConditionOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export interface Comparison { device: string; property: string; operator: ConditionOperator; value: string | number | boolean; unit?: string }
export type Condition = Comparison | { all: Condition[] } | { any: Condition[] };
export interface ConditionSource { key: string; device: string; path: string; schema: ConditionSchema; unit?: string; name?: string }
export type ConditionForm = { kind: 'compare'; source: string; operator: ConditionOperator; value: string } | { kind: 'all' | 'any'; children: ConditionForm[] };
export const conditionOperators: Record<ConditionOperator, string>;
export function operatorsFor(schema: ConditionSchema): ConditionOperator[];
export function conditionSources(devices: {device_id: string; model_revision: string}[], models: Record<string, {services: {id: string; properties: {id: string; schema: ConditionSchema; access: string[]; unit?: string}[]}[]}>): ConditionSource[];
export function newCondition(source: ConditionSource): ConditionForm;
export function compileConditions(forms: ConditionForm[], sources: ConditionSource[]): Condition[] | null;
export function restoreConditions(conditions: unknown[], sources: ConditionSource[]): ConditionForm[] | null;
