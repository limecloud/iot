export interface NumericSchema { type: string; minimum?: number; maximum?: number }
export interface ThresholdProperty { path: string; unit: string; edge: 'rising' | 'falling'; threshold: number; hysteresis: number }
export interface ThresholdSample { value: number; observed_at: string; quality: 'confirmed'; source: string }
export function unitScale(unit: string): number;
export function unitLabel(unit: string): string;
export function displayNumber(value: number, unit: string): string;
export function parseNumber(text: string, schema: NumericSchema, unit?: string): number | null;
export function thresholdTrigger(path: string, unit: string, schema: NumericSchema, edge: ThresholdProperty['edge'], threshold: string, hysteresis: string): ThresholdProperty | null;
export function thresholdSamples(property: ThresholdProperty, schema: NumericSchema, options?: { now?: number; source?: string }): { previous: ThresholdSample; current: ThresholdSample } | null;
