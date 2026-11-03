export interface ValueSchema {
  type: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  enum?: unknown[]; properties?: Record<string, ValueSchema>; required?: string[]; additionalProperties?: boolean;
}
export function sampleValue(schema: ValueSchema): unknown;
export function checkFormValue(value: unknown, schema: ValueSchema): boolean;
