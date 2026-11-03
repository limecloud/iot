export interface Session { authenticated: true; csrf_token: string; expires_at: string }
export interface Observation { value: unknown; observed_at: string; quality: string; source: string }
export interface Device { device_id: string; model_revision: string; ready: boolean; last_seen: string | null; reported: Record<string, Observation>; action_availability?: Record<string, boolean> }
import type { Condition } from '../../../packages/protocol/condition-form.mjs';
import type { ConditionEvaluation } from '../../../packages/protocol/rule-simulation.mjs';
export interface Property { id: string; semantic_id: string; schema: Schema; access: string[]; unit?: string }
export interface Schema { type: string; minimum?: number; maximum?: number; enum?: unknown[]; minLength?: number; maxLength?: number; properties?: Record<string, Schema>; required?: string[] }
export interface Action { id: string; semantic_id: string; input: Schema; output: Schema; idempotent: boolean; risk: 'low' | 'medium' | 'high'; completion: 'submitted' | 'observed' }
export interface Model { model_id: string; services: { id: string; semantic_id: string; properties: Property[]; actions?: Action[]; events: { id: string; schema: Schema }[] }[] }
export type RuleAction = { device: string; set: { path: string; value: unknown }; invoke?: never } | { device: string; invoke: { path: string; input: unknown }; set?: never };
export interface PropertyTrigger { path: string; unit: string; edge: 'rising' | 'falling'; threshold: number; hysteresis: number }
export interface ScheduleTrigger { time: string; time_zone: string; weekdays: number[] }
export type RuleTrigger = { device: string; event: string; property?: never; schedule?: never } | { device: string; property: PropertyTrigger; event?: never; schedule?: never } | { schedule: ScheduleTrigger; device?: never; event?: never; property?: never };
export interface Rule { version: number; id: string; trigger: RuleTrigger; conditions: Condition[]; actions: RuleAction[]; cooldown_ms: number }
export function ruleTriggerText(trigger: RuleTrigger): string {
  if (trigger.schedule) return `${trigger.schedule.time}，${trigger.schedule.time_zone}，周${trigger.schedule.weekdays.join('、')}`;
  if (!trigger.property) return trigger.event === 'button.pressed' ? '按下时' : `发生 ${trigger.event}`;
  const item = trigger.property;
  const name = item.path === 'environment.temperature' ? '温度' : item.path === 'environment.humidity' ? '相对湿度' : item.path;
  const value = (number: number) => item.unit === 'celsius_x100' ? `${(number / 100).toFixed(2)} ℃` : item.unit === 'percent_x100' ? `${(number / 100).toFixed(2)} %RH` : `${number} ${item.unit}`;
  return `${name}${item.edge === 'rising' ? '上升越过' : '下降越过'} ${value(item.threshold)}，滞回 ${value(item.hysteresis)}`;
}
export function ruleActionText(action: RuleAction): string {
  if (action.invoke) return `调用 ${action.invoke.path}，参数 ${JSON.stringify(action.invoke.input)}`;
  const { path, value } = action.set;
  return path === 'light.power' ? (value ? '开启' : '关闭') : `${path === 'light.brightness' ? '亮度' : path}设为 ${JSON.stringify(value)}`;
}
export interface Inference { configured: boolean; provider: string; model: string | null }
export interface RuleDraft { draft_id: string; status: 'running' | 'completed' | 'rejected' | 'unknown' | 'expired'; request: { prompt: string; expires_at: string }; rule: Rule | null; rule_revision: string | null; error: string | null }
export interface Command { command_id: string; status: string; request: { device_id: string; operation: { type?: string; path: string; value: unknown }; expires_at: string }; error: string | null; run_id: string | null; evidence: { type?: string; completion?: string } | null }
export interface Deployment { revision: string; rule: Rule; last_run: string | null }
export interface Run { run_id: string; rule_revision: string; event_id: string; command_ids: string[]; error: string | null; condition_evaluation?: ConditionEvaluation }
export interface List<T> { items: T[]; next_cursor: string | null }
export function sampleEvent(schema: Schema): unknown {
  if (schema.enum?.length) return schema.enum[0];
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
  media_not_configured: '网关尚未启用音频服务', media_storage_unavailable: '网关暂时无法保存或读取音频',
  media_not_found: '音频或播放授权不存在、已过期或已撤销', media_operation_not_found: '暂未查到原音频操作，请保留原记录后再次查询',
  media_target_unavailable: '所选音箱尚未绑定平台音频，请重新读取接入信息', media_capacity: '音频服务容量已满', media_operation_capacity: '音频操作记录容量已满',
  invalid_media_audio: '音频须为 16 位 PCM WAV，最长 60 秒、最大 4 MiB', invalid_media_change: '音频操作参数不正确',
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
  device_queue_full: '设备还有操作正在处理，请稍后重试',
  invalid_rule: '规则格式不正确', invalid_value: '数值不符合设备要求', invalid_condition: '条件的属性、单位或比较值不符合设备要求', invalid_simulation: '预演结果未通过校验，请重新预演',
  invalid_threshold: '阈值、单位或滞回不符合设备要求', rule_cycle: '联动形成循环，请调整触发条件或执行设备',
  invalid_schedule: '请检查定时时间、时区和星期', invalid_schedule_time: '当前时间无法计算定时，请检查网关时钟',
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
export const remoteKeyLabels: Record<string, string> = { up: '上', down: '下', left: '左', right: '右', select: '确认', back: '返回', home: '主页', menu: '菜单', play_pause: '播放 / 暂停' };
export function commandStatus(command: Command) {
  if (command.status === 'confirmed' && command.evidence?.type === 'action_result') return command.evidence.completion === 'submitted' ? '输入已提交' : command.evidence.completion === 'observed' ? '效果已观测' : '完成范围未知';
  return statusText[command.status] ?? command.status;
}
export function commandSummary(command: Command) {
  const { type, path, value } = command.request.operation;
  const input = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (type === 'action.invoke' && path === 'remote.press' && typeof input.key === 'string') return `遥控：${remoteKeyLabels[input.key] ?? input.key}`;
  if (type === 'action.invoke' && path === 'apps.launch' && typeof input.application_id === 'string') return `启动应用：${input.application_id}`;
  if (type === 'action.invoke' && path === 'playback.play') return `播放音频：${String(input.media_id ?? '')}`;
  if (type === 'action.invoke' && path === 'playback.stop') return '停止播放';
  if (type === 'action.invoke' && path === 'playback.set_volume') return `设置音量：${String(input.volume ?? '')}`;
  if (path === 'light.power') return value ? '打开' : '关闭';
  const label = ({ 'light.brightness': '亮度', 'audio.volume': '音量', 'audio.muted': '静音' } as Record<string, string>)[path] ?? path;
  return `${label} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
}
export function deviceName(device: Device, models: Record<string, Model>) {
  const model = models[device.model_revision];
  if (model?.services.some(service => service.id === 'light')) return '环境灯';
  if (model?.services.some(service => service.id === 'button')) return '无线按钮';
  if (model?.services.some(service => service.semantic_id === 'urn:limeiot:service:environment:1')) return '环境传感器';
  if (model?.services.some(service => service.semantic_id === 'urn:limeiot:service:audio-playback:1')) return '音箱';
  if (model?.services.some(service => service.actions?.some(action => action.semantic_id === 'urn:limeiot:action:remote-press:1'))) return '电视';
  return device.device_id;
}
export function when(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录'; }
