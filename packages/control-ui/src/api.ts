export type Audience = 'console' | 'admin';
export interface Session { audience: Audience; principal: { principal_id: string; name: string }; csrf_token: string; expires_at: string }
export class ApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
export async function request<T>(path: string, session?: Session, input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { 'X-CSRF-Token': session.csrf_token } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
  });
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.error?.code ?? 'invalid_response', response.status);
  return body as T;
}
const messages: Record<string,string> = {
  validator_unavailable:'模型校验服务暂时不可用，请稍后重试',
  release_signer_unavailable:'实例尚未配置可用的发布签名密钥',publication_store_unavailable:'模型发布存储暂不可用',release_capacity_reached:'发布操作记录已达上限',
  authentication_required:'请登录后继续', identity_rejected:'凭据无效或会话已失效', identity_unavailable:'账号服务暂时不可用，请稍后重试',
  forbidden:'当前账号没有此权限', csrf_rejected:'会话已变化，请刷新后重试', origin_rejected:'请求来源不符合实例配置',
  not_found:'未找到当前账号可访问的记录', gateway_offline:'网关未连接，暂时无法远程操作', storage_unavailable:'服务暂时无法保存或读取记录',
  remote_gateway_error:'网关暂时无法返回结果', remote_capacity_reached:'远程操作记录或并发已达上限', rate_limited:'请求过于频繁，请稍后重试',
  invalid_draft_document:'物模型 JSON 格式或大小不符合草稿要求', product_capacity_reached:'产品或草稿操作记录已达上限',
  idempotency_conflict:'原操作参数不一致，请查询原记录', gateway_already_bound:'网关或空间已有活动绑定', invalid_request:'请检查输入内容',
  remote_authorization_rejected:'网关授权已变化，请核对配对', remote_authorization_expired:'本次委托已过期', relay_result_too_large:'结果超出传输限制',
  native_authorization_expired:'手机登录请求已过期，请在手机重新发起',session_not_delegatable:'请使用本人网页登录批准手机请求',
};
export const errorText = (error: unknown) => error instanceof ApiError ? messages[error.code] ?? `请求未完成（${error.code}）` : '暂时无法连接服务，请检查网络';
export const when = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '暂无记录';
export const statusText:Record<string,string> = {unknown:'结果未知',accepted:'网关已受理',dispatched:'已发送至设备',confirmed:'设备已确认',failed:'执行失败',expired:'已过期',rejected:'已拒绝'};
export const terminal = (status?:string) => !!status && ['confirmed','failed','expired','rejected'].includes(status);
export type Call = <T>(path:string,input?:unknown,signal?:AbortSignal)=>Promise<T>;
