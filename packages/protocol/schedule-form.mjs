// 仅校验表单；实际发生时刻和夏令时规则统一由网关计算。
export function scheduleTrigger(time, timeZone, weekdays) {
  if (typeof time !== 'string' || time.length !== 5 || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) || typeof timeZone !== 'string' || !timeZone || timeZone.length > 128 || !Array.isArray(weekdays) || !weekdays.length || weekdays.length > 7 || new Set(weekdays).size !== weekdays.length || !weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return null; }
  return { time, time_zone: timeZone, weekdays: [...weekdays] };
}
