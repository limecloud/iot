// 小度技能实验的外部文字模型适配器；不执行模型返回的工具或设备动作。
export function chatEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_provider_url');
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  return url;
}

async function readJson(response, maximumBytes = 128 * 1024) {
  if (!response.body) throw new Error('provider_empty_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) throw new Error('provider_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createChatProvider({ baseUrl, apiKey, model, timeoutMs = 10000, reasoningEffort }) {
  const endpoint = chatEndpoint(baseUrl);
  if (typeof apiKey !== 'string' || !apiKey || /\s/.test(apiKey)
      || typeof model !== 'string' || !model || model.length > 200 || /[\r\n]/.test(model)
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20000
      || (reasoningEffort !== undefined && !['none', 'low', 'medium', 'high'].includes(reasoningEffort))) {
    throw new Error('invalid_provider_configuration');
  }
  return async (messages, { signal } = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: combined,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        max_completion_tokens: 512,
        ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
        messages: [{
          role: 'system',
          content: '你是LimeIoT的语音助手。用简洁自然的中文回答，尽量不超过100个汉字，不使用Markdown。本次实验未提供设备执行工具，不得声称已经操作了任何真实设备。',
        }, ...messages],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error(response.status === 401 || response.status === 403
        ? 'provider_authentication_failed' : 'provider_rejected');
      error.status = response.status;
      throw error;
    }
    const data = await readJson(response);
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('provider_invalid_response');
    return text.trim();
  };
}
