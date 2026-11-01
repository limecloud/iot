export interface Session { authenticated: true; csrf_token: string; expires_at: string }
export interface Observation { value: unknown; observed_at: string; quality: string; source: string }
export interface Device { device_id: string; model_revision: string; ready: boolean; last_seen: string | null; reported: Record<string, Observation> }
export interface Property { id: string; semantic_id: string; schema: { type: string; minimum?: number; maximum?: number }; access: string[] }
export interface Schema { type: string; minimum?: number; properties?: Record<string, Schema>; required?: string[] }
export interface Model { model_id: string; services: { id: string; properties: Property[]; events: { id: string; schema: Schema }[] }[] }
export interface Rule { version: number; id: string; trigger: { device: string; event: string }; conditions: unknown[]; actions: { device: string; set: { path: string; value: unknown } }[]; cooldown_ms: number }
export interface Inference { configured: boolean; provider: string; model: string | null }
export interface RuleDraft { draft_id: string; status: 'running' | 'completed' | 'rejected' | 'unknown' | 'expired'; request: { prompt: string; expires_at: string }; rule: Rule | null; rule_revision: string | null; error: string | null }
export interface Command { command_id: string; status: string; request: { device_id: string; operation: { path: string; value: unknown }; expires_at: string }; error: string | null; run_id: string | null; evidence: { type?: string } | null }
export interface Deployment { revision: string; rule: Rule; last_run: string | null }
export interface Run { run_id: string; rule_revision: string; event_id: string; command_ids: string[]; error: string | null }
export interface List<T> { items: T[]; next_cursor: string | null }
export function sampleEvent(schema: Schema): unknown {
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, sampleEvent(schema.properties?.[key] ?? { type: 'string' })]));
  if (schema.type === 'boolean') return true;
  if (['integer', 'number'].includes(schema.type)) return schema.minimum ?? 0;
  return '';
}
export class ApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
  get definitiveRejection() { return this.status >= 400 && this.status < 500 && this.status !== 408 && !['idempotency_conflict', 'request_failed'].includes(this.code); }
}
export async function request<T>(path: string, session?: Session, input?: unknown, options: { method?: string; signal?: AbortSignal; key?: string } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (input === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: {
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(session ? { 'X-CSRF-Token': session.csrf_token } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error?.code ?? 'request_failed', response.status);
  return value as T;
}
const messages: Record<string, string> = {
  control_not_configured: '网关尚未配置控制面连接', control_origin_not_allowed: '此控制面未在网关允许列表中',
  invalid_pairing_code: '配对信息不完整或格式不正确', control_link_not_found: '未找到原配对，请确认家庭网关',
  control_already_bound: '请先撤销已有的本地控制面连接', control_pairing_expired: '配对已过期或取消，请重新申请',
  control_review_required: '请先核对配对信息', control_link_revoked: '本地连接已撤销',
  control_unknown: '结果未知，请核实原配对', control_unavailable: '暂时无法连接控制面', control_busy: '已有配对正在处理',
  control_identity_rejected: '控制面未接受配对证明', control_conflict: '配对记录不一致，请核实原配对',
  control_invalid_response: '控制面响应未通过校验', control_invalid_scope: '配对权限超出当前支持范围',
  control_not_found: '控制面未找到原绑定，请核实原配对', control_secret_invalid: '无法读取配对材料，请恢复原网关密钥',
  unauthenticated: '登录凭据无效或会话已过期', forbidden: '当前请求未获授权，请重新登录',
  rate_limited: '尝试次数过多，请一分钟后重试', device_offline: '设备已离线',
  invalid_rule: '规则格式不正确', invalid_value: '数值不符合设备要求',
  device_not_found: '规则引用的设备不存在', invalid_prompt: '请填写 512 字以内的联动需求', capacity_exceeded: '网关记录容量已满',
  unsupported_capability: '当前版本不支持此能力', event_gap: '记录已更新，正在重新获取',
  idempotency_conflict: '操作内容不一致，请查询原操作', storage_unavailable: '网关暂时无法保存操作',
  model_mismatch: '设备能力已变化，请刷新后重试', command_expired: '操作已过期，请检查本机时间',
  inference_not_configured: '网关尚未配置本地模型', inference_busy: '已有草案正在生成，请稍后再试',
  inference_unavailable: '无法连接本地模型，设备控制仍可使用', inference_origin_not_local: '模型地址须位于本地网络',
  inference_unknown: '生成结果未知，请查询原草案', inference_timeout: '模型响应超时，未启用自动化',
  inference_rejected: '本地模型未接受请求，请检查模型配置', invalid_model_output: '模型结果未通过校验，请调整描述',
  inference_output_incomplete: '模型结果不完整，未采用草案', inference_context_changed: '设备能力已变化，请重新生成草案',
  unsupported_intent: '当前设备暂不支持这项联动', draft_expired: '生成请求已过期', draft_not_found: '未找到原草案，请确认网关地址',
  inference_response_too_large: '模型结果超出限制', inference_output_limit: '模型用量超出限制',
};
export function errorText(error: unknown) {
  if (error instanceof ApiError) return messages[error.code] ?? `请求未完成（${error.code}）`;
  return '无法连接家庭网关，请检查本地网络';
}
export const statusText: Record<string, string> = { accepted: '已受理', dispatched: '已发送', confirmed: '已确认', failed: '执行失败', unknown: '结果未知', expired: '已过期', rejected: '已拒绝' };
export function deviceName(device: Device, models: Record<string, Model>) {
  const model = models[device.model_revision];
  if (model?.services.some(service => service.id === 'light')) return '环境灯';
  if (model?.services.some(service => service.id === 'button')) return '无线按钮';
  return device.device_id;
}
export function when(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录'; }
