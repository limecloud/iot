import { useEffect, useState } from 'react';
import { verifyAiCatalog, type AiCatalog, type AiCapabilityId } from '../../../packages/protocol/ai-catalog.mjs';
import { errorText, request, type Session } from './api';

const labels: Record<AiCapabilityId, { title: string; view: string; action: string }> = {
  'automation.rule_draft': { title: '联动草案', view: 'automation', action: '打开自动化' },
  'text.generate': { title: '文字对话', view: 'text', action: '打开对话' },
  'vision.understand': { title: '图片观察', view: 'vision', action: '打开视觉' },
  'audio.transcribe': { title: '语音识别', view: 'media', action: '打开音频' },
  'audio.synthesize': { title: '语音合成', view: 'media', action: '打开音频' },
};
const configurationLabels: Record<string, string> = {
  concurrency: '并发任务', max_output_tokens: '输出 Token 上限', max_messages: '消息数上限',
  max_context_bytes: '上下文字节上限', max_instructions_characters: '指令字数上限',
  max_text_bytes: '文字字节上限', max_characters: '文字字数上限', max_deadline_seconds: '期限上限（秒）',
  max_retain_seconds: '保留上限（秒）', streaming: '流式输出', provider_cancellation: '提供方取消',
  input_storage: '输入保存方式', server_memory: '服务端记忆', device_execution: '直接执行设备操作',
  content_types: '图片格式', max_image_bytes: '图片字节上限', max_edge: '图片边长上限（像素）',
  max_prompt_characters: '问题字数上限', languages: '识别语言', max_audio_bytes: '音频字节上限',
  max_audio_seconds: '音频时长上限（秒）', voices: '声音编号', max_output_bytes: '输出字节上限',
};
function display(value: string | number | boolean | string[]) {
  if (typeof value === 'boolean') return value ? '支持' : '不支持';
  if (Array.isArray(value)) return value.join('、');
  return value === 'digest_only' ? '仅摘要' : String(value);
}
function destination(view: string) {
  const url = new URL(location.href); url.searchParams.set('view', view);
  return url.pathname + url.search;
}

export function AiServices({ prefix, session, online, revision, onError }: { prefix: string; session: Session; online: boolean; revision: string | null; onError: (error: unknown) => void }) {
  const [catalog, setCatalog] = useState<AiCatalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!online) { setCatalog(null); return; }
    let active = true;
    const controller = new AbortController();
    const space = decodeURIComponent(prefix.split('/').at(-1)!);
    void request<unknown>(`${prefix}/ai-catalog`, session, undefined, { signal: controller.signal })
      .then(value => verifyAiCatalog(value, space))
      .then(value => { if (active) { setCatalog(value); setError(''); } })
      .catch(error => { if (active) { const invalid = error instanceof Error && error.message === 'invalid_ai_catalog'; setCatalog(null); setError(invalid ? 'AI 服务目录未通过校验，请刷新重试' : errorText(error)); if (!invalid) onError(error); } });
    return () => { active = false; controller.abort(); };
  }, [prefix, session, online, revision, onError]);

  return <section className="ai-services" aria-label="AI 服务目录">
    {!catalog && <p role="status">{!online ? '网关离线，重新连接后可查询服务' : error || '正在读取 AI 服务'}</p>}
    {catalog && catalog.definitions.map(definition => {
      const deployment = catalog.deployments.find(item => item.capability_id === definition.capability_id);
      const label = labels[definition.capability_id];
      return <article className="ai-service" key={definition.capability_id} aria-label={label.title}>
        <div className="ai-service-heading"><h2>{label.title}</h2><span className="muted">{deployment ? '已配置，健康未检测' : '未配置'}</span></div>
        {deployment && <p className="ai-service-model">{deployment.identity.model}</p>}
        {deployment && <a href={destination(label.view)}>{label.action}</a>}
        <details><summary>能力详情</summary><dl>
          <dt>能力编号</dt><dd><code>{definition.capability_id}</code></dd>
          <dt>创建操作</dt><dd><code>{definition.create_operation}</code></dd>
          <dt>恢复操作</dt><dd><code>{definition.resolve_operation}</code></dd>
          <dt>输入合同</dt><dd><code>{definition.input_schema}</code></dd>
          <dt>任务合同</dt><dd>{definition.task_schema ? <code>{definition.task_schema}</code> : '未提供机器 Schema'}</dd>
          <dt>设备执行</dt><dd>须独立审核与授权</dd>
          {deployment && <>
            <dt>适配器</dt><dd><code>{deployment.identity.adapter}</code></dd>
            <dt>部署修订</dt><dd><code>{deployment.identity.revision ?? '未记录'}</code></dd>
            <dt>数据位置</dt><dd>本地</dd>
            {Object.entries(deployment.configuration).map(([key, value]) => <div key={key}><dt>{configurationLabels[key] ?? key}</dt><dd>{display(value)}</dd></div>)}
            <dt>模型许可</dt><dd>未核验</dd><dt>费用政策</dt><dd>未登记</dd>
            <dt>资源需求</dt><dd>未登记</dd><dt>效果质量</dt><dd>未核验</dd>
          </>}
        </dl></details>
      </article>;
    })}
  </section>;
}
