export function unitScale(unit) { return ['celsius_x100', 'percent_x100'].includes(unit) ? 100 : 1; }
export function unitLabel(unit) { return unit === 'celsius_x100' ? '℃' : unit === 'percent_x100' ? '%RH' : unit; }
export function displayNumber(value, unit) { return String(value / unitScale(unit)); }

// 十进制文本按位换算，避免0.29×100的浮点误差或静默截断更高精度输入。
export function parseNumber(text, schema, unit = '') {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())) return null;
  let value = Number(text);
  if (unitScale(unit) === 100) {
    const negative = text.trim().startsWith('-');
    const [whole, fraction = ''] = text.trim().replace(/^-/, '').split('.');
    if (fraction.length > 2) return null;
    value = (Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1);
  }
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
    (schema.type !== 'integer' || Number.isInteger(value)) &&
    (schema.minimum === undefined || value >= schema.minimum) &&
    (schema.maximum === undefined || value <= schema.maximum) ? value : null;
}

export function thresholdTrigger(path, unit, schema, edge, thresholdText, hysteresisText) {
  const threshold = parseNumber(thresholdText, schema, unit);
  const hysteresis = parseNumber(hysteresisText, { type: schema.type, minimum: 0 }, unit);
  if (threshold === null || hysteresis === null || !['rising', 'falling'].includes(edge)) return null;
  const boundary = edge === 'rising' ? threshold - hysteresis : threshold + hysteresis;
  if (!Number.isFinite(boundary) || (schema.minimum !== undefined && boundary < schema.minimum) || (schema.maximum !== undefined && boundary > schema.maximum)) return null;
  return { path, unit, edge, threshold, hysteresis };
}

export function thresholdSamples(property, schema, { now = Date.now(), source = 'simulation.ui' } = {}) {
  const { threshold, hysteresis, edge } = property;
  const rising = edge === 'rising';
  const bound = rising ? schema.maximum : schema.minimum;
  const step = schema.type === 'integer' ? 1 : bound === undefined ? Math.max(1, Math.abs(threshold) * 0.01) : Math.abs(bound - threshold) / 2;
  const current = rising ? threshold + step : threshold - step;
  if (!Number.isFinite(current) || current === threshold || (schema.minimum !== undefined && current < schema.minimum) || (schema.maximum !== undefined && current > schema.maximum)) return null;
  const sample = (value, time) => ({ value, observed_at: new Date(time).toISOString(), quality: 'confirmed', source });
  return { previous: sample(rising ? threshold - hysteresis : threshold + hysteresis, now - 1), current: sample(current, now) };
}
