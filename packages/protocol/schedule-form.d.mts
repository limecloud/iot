export interface Schedule { time: string; time_zone: string; weekdays: number[] }
export function scheduleTrigger(time: string, timeZone: string, weekdays: number[]): Schedule | null;
