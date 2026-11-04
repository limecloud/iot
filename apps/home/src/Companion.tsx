import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { CompanionClient, parseCompanionPolicy, parseCompanionSession, type CompanionPolicy, type CompanionSession, type CompanionView } from '../../../packages/protocol/companion.mjs';
import type { VoiceTextContext } from '../../../packages/protocol/voice-turns.mjs';
import type { MediaPage } from '../../../packages/protocol/media.mjs';
import { verifySpeechCapabilities } from '../../../packages/protocol/speech.mjs';
import { verifyTextCapabilities } from '../../../packages/protocol/text.mjs';
import { verifyTranscriptionCapabilities } from '../../../packages/protocol/transcription.mjs';
import { sameJSON } from '../../../packages/protocol/products.mjs';
import puppyPolicy from '../../../examples/companions/block-puppy/policy.json?raw';

type Context = { epoch: number; signal: AbortSignal };
const template = parseCompanionPolicy(puppyPolicy);
const phases: Record<CompanionView['phase'], string> = { ready: '会话已准备', running: '正在生成回复', succeeded: '本轮回复已生成', unknown: '结果待核实', failed: '本轮未完成', discarded: '已放弃输出', stopped: '会话已结束', expired: '会话已到期', prepared: '本轮尚未提交', paused: '本轮已暂停' };
const messages: Record<string, string> = {
  companion_busy: '另一个标签正在操作会话，请稍后查询',
  companion_record_unavailable: '会话记录不可用，已暂停新请求', companion_history_unavailable: '会话上下文已清除，请结束后重新开始',
  companion_policy_changed: '角色设置已变化，请结束后重新开始', companion_configuration_changed: '模型配置已变化，请结束后重新开始',
  companion_not_configured: '请先配置识别、文字和语音服务', companion_turn_pending: '本轮尚未核实，请先查询或结束会话',
  companion_turn_budget_exceeded: '本次会话轮数已用完', companion_expired: '会话已到期，请结束后重新开始',
  companion_preparation_incomplete: '本轮尚未提交，请结束后重新开始', companion_lock_unavailable: '当前浏览器不支持安全提交会话',
  voice_turn_context_unavailable: '会话上下文已清除，请结束后重新开始', invalid_voice_turn_context: '对话内容超出容量，请结束后重新开始',
  voice_turn_source_unavailable: '原录音已不可用', voice_turn_configuration_changed: '模型配置已变化，请结束后重新开始',
  voice_turn_answer_not_speakable: '回答超出语音合成限制，可查看文字回复', invalid_companion_policy: '请检查角色说明和会话设置',
};

export function Companion({ prefix, session, online, files, onError, onGenerated }: { prefix: string; session: Session; online: boolean; files: MediaPage['items']; onError: (error: unknown) => void; onGenerated: (id: string) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.companion:${prefix}`;
  const [record, setRecord] = useState<CompanionSession | null>(null), [view, setView] = useState<CompanionView | null>(null);
  const [role, setRole] = useState('puppy'), [instructions, setInstructions] = useState(''), [voice, setVoice] = useState(''), [voices, setVoices] = useState<string[]>([]), [mediaID, setMediaID] = useState('');
  const [conversation, setConversation] = useState<VoiceTextContext['history']>([]);
  const [configured, setConfigured] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), currentOnline = useRef(online), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), approved = useRef(false), seen = useRef(false), notified = useRef('');
  const history = useRef<VoiceTextContext['history'] | undefined>(undefined), policy = useRef<CompanionPolicy | undefined>(undefined), generated = useRef(onGenerated);
  generated.current = onGenerated; currentOnline.current = online;
  const valid = (context: Context) => active.current && epoch.current === context.epoch && currentOnline.current && !document.hidden && !context.signal.aborted;
  function client(context: Context) {
    return new CompanionClient({ origin: location.origin, space, policy: policy.current, history: history.current, signal: context.signal, active: () => valid(context), request: (resource, input, key) => request<unknown>(resource, session, input, { signal: context.signal, key }), journal: {
      async load() { const raw = localStorage.getItem(storage); if (seen.current && raw === null) throw new Error('companion_record_unavailable'); if (raw !== null) seen.current = true; return raw; },
      async save(previous, next) {
        const raw = localStorage.getItem(storage);
        if (raw === null ? previous !== null : previous === null || !sameJSON(await parseCompanionSession(raw, location.origin, space), previous)) throw new Error('companion_record_unavailable');
        if (!valid(context)) throw new Error('companion_paused');
        try { const encoded = JSON.stringify(next); localStorage.setItem(storage, encoded); if (localStorage.getItem(storage) !== encoded) throw new Error(); }
        catch { throw new Error('companion_record_unavailable'); }
        seen.current = true; if (valid(context)) setRecord(next);
      },
    } });
  }
  function accept(value: CompanionView, owner: CompanionClient, context: Context, reveal = true) {
    if (!valid(context)) return;
    history.current = owner.history;
    setRecord(value.record); setView(reveal ? value : { ...value, turn: value.turn ? { ...value.turn, transcript: null, answer: null, media_id: null } : null });
    setConversation(reveal && value.history_available && !['stopped', 'expired'].includes(value.phase) ? owner.history ?? [] : []);
    if (value.turn?.media_id && reveal && notified.current !== value.turn.record.turn_id) { notified.current = value.turn.record.turn_id; generated.current(value.turn.media_id); }
    if (!['ready', 'running'].includes(value.phase)) approved.current = false;
    if (['stopped', 'expired'].includes(value.phase)) { history.current = undefined; policy.current = undefined; }
  }
  async function locked(context: Context, work: (value: CompanionClient) => Promise<void>) {
    if (!navigator.locks) throw new Error('companion_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('companion_busy', 429); if (valid(context)) await work(client(context)); });
  }
  async function refresh(context: Context) {
    setReady(false);
    const raw = await request<{ transcription: unknown; text: unknown; speech: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const asr = verifyTranscriptionCapabilities(raw.transcription), text = verifyTextCapabilities(raw.text), speech = verifySpeechCapabilities(raw.speech);
    if (!valid(context)) return;
    setConfigured(asr.configured && text.configured && speech.configured); setVoices(speech.configured ? speech.voices : []);
    setVoice(current => speech.configured && speech.voices.includes(current) ? current : speech.configured ? speech.voices[0] : '');
    await locked(context, async value => { const saved = await value.load(); if (valid(context)) setRecord(saved); if (saved) accept(await value.resolve(), value, context, false); });
    if (valid(context)) setReady(true);
  }
  async function run(work: (context: Context) => Promise<void>) {
    if (working.current || !active.current || !currentOnline.current || document.hidden) return;
    const token = Symbol(), context = { epoch: epoch.current, signal: abort.current.signal }; working.current = token; setBusy(true); setMessage('');
    try { await work(context); }
    catch (error) {
      approved.current = false;
      if (!valid(context)) return;
      const code = error instanceof Error ? error.message : '';
      if (code === 'companion_record_unavailable' || /^invalid_.*_response$/.test(code)) { setBlocked(true); setReady(false); setView(null); setConversation([]); history.current = undefined; policy.current = undefined; }
      setMessage(messages[code] ?? (error instanceof ApiError ? errorText(error) : '本轮结果待核实，请查询原会话'));
      if (error instanceof ApiError && error.status === 401) onError(error);
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; approved.current = false; setView(null); setConversation([]); setMediaID(''); setBusy(false); setReady(false); };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (currentOnline.current && !document.hidden) void run(refresh); };
    const exit = () => { history.current = undefined; policy.current = undefined; invalidate(); };
    const restore = () => { if (currentOnline.current && !document.hidden) void run(refresh); };
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== storage) return;
      history.current = undefined; policy.current = undefined; invalidate();
      if ((event.key === null || event.newValue === null) && seen.current) { setBlocked(true); setMessage(messages.companion_record_unavailable); }
      else if (currentOnline.current && !document.hidden) void run(refresh);
    };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed); addEventListener('pagehide', exit); addEventListener('pageshow', restore);
    return () => { active.current = false; epoch.current++; approved.current = false; abort.current.abort(); working.current = null; history.current = undefined; policy.current = undefined; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); removeEventListener('pagehide', exit); removeEventListener('pageshow', restore); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!record || !view?.turn || !online || busy || blocked || !ready || !['running', 'ready'].includes(view.phase)) return;
    const timer = setTimeout(() => void run(context => locked(context, async value => accept(await (approved.current ? value.continue() : value.resolve()), value, context, approved.current))), 1000);
    return () => clearTimeout(timer);
  }, [record, view, online, busy, blocked, ready]);
  useEffect(() => {
    if (!record || record.stopped) return;
    const timer = setTimeout(() => { approved.current = false; history.current = undefined; policy.current = undefined; setConversation([]); setView(current => current ? { ...current, phase: 'expired', can_reply: false, history_available: false, turn: null } : null); }, Math.max(0, Date.parse(record.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [record]);
  const available = files.filter(item => item.available && Date.parse(item.metadata.expires_at) > Date.now());
  const disabled = !online || busy || blocked || !ready, mayStart = !record || view?.stop_settled === true;
  return <section className="rule-editor companion-session" aria-label="陪伴会话"><div className="section-heading"><h2>{policy.current?.name ?? '陪伴会话'}</h2><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取会话状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}{ready && !configured && <p className="muted">请先配置本地识别、文字和语音服务</p>}
    {configured && mayStart && <form onSubmit={event => { event.preventDefault(); void run(context => {
      policy.current = parseCompanionPolicy(JSON.stringify({ ...template, voice, ...(role === 'custom' ? { policy_id: 'custom-companion', name: '自定义伙伴', instructions } : {}) }));
      history.current = undefined;
      return locked(context, async value => accept(await value.start(crypto.randomUUID()), value, context));
    }); }}>
      <label htmlFor="companion-role">陪伴角色</label><select id="companion-role" value={role} disabled={disabled} onChange={event => setRole(event.target.value)}><option value="puppy">{template.name}</option><option value="custom">自定义角色</option></select>
      {role === 'custom' && <><label htmlFor="companion-instructions">角色说明</label><textarea id="companion-instructions" rows={3} maxLength={1024} value={instructions} disabled={disabled} onChange={event => setInstructions(event.target.value)} /></>}
      <label htmlFor="companion-voice">回答声音</label><select id="companion-voice" value={voice} disabled={disabled} onChange={event => setVoice(event.target.value)}>{voices.map(item => <option key={item} value={item}>{item}</option>)}</select>
      <p className="muted">最多 {template.max_turns} 轮，{template.max_seconds / 60} 分钟</p><button className="primary" disabled={disabled || !voice || role === 'custom' && !instructions.trim()}>开始陪伴</button>
    </form>}
    {record && <article className="vision-task" aria-label="当前陪伴会话"><div className="section-heading"><strong>{view ? phases[view.phase] : record.stopped ? '会话已结束' : '结果待核实'}</strong><span className="muted">已用 {record.turns.length} / {record.max_turns} 轮</span></div>
      {view && !record.stopped && !view.history_available && <p className="muted">会话上下文已清除，请结束后重新开始</p>}
      {conversation.length > 0 ? <div className="conversation" aria-label="本次陪伴记录">{conversation.map((item, index) => <p key={index}><strong>{item.role === 'user' ? '你' : policy.current?.name ?? '伙伴'}</strong><span>{item.content}</span></p>)}</div> : <>
        {view?.turn?.transcript && <p className="text-answer" aria-label="当前识别文本">{view.turn.transcript}</p>}{view?.turn?.answer && <p className="text-answer" aria-label="当前文字回复">{view.turn.answer}</p>}
      </>}
      {view?.can_reply && <form onSubmit={event => { event.preventDefault(); void run(context => locked(context, async value => { approved.current = true; accept(await value.reply(mediaID), value, context); })); }}>
        <label htmlFor="companion-media">本轮录音</label><select id="companion-media" value={mediaID} disabled={disabled} onChange={event => setMediaID(event.target.value)}><option value="">选择已上传录音</option>{available.map(item => <option key={item.metadata.media_id} value={item.metadata.media_id}>音频 {item.metadata.media_id.slice(-8)}</option>)}</select>
        <button className="primary" disabled={disabled || !available.some(item => item.metadata.media_id === mediaID)}>发送本轮录音</button>
      </form>}
      {view?.turn?.media_id && <p className="muted">音频已选中，可在下方授权播放</p>}
      <div className="actions"><button disabled={!online || busy || blocked} onClick={() => void run(context => locked(context, async value => accept(await value.resolve(), value, context)))}>查询原会话</button>
        {view?.turn && !record.stopped && !['succeeded', 'failed', 'discarded', 'unknown', 'expired'].includes(view.phase) && <button disabled={disabled || !configured || !view.history_available || !policy.current} onClick={() => void run(context => locked(context, async value => { approved.current = true; accept(await value.continue(), value, context); }))}>继续本轮</button>}
        <button disabled={!online || busy || blocked || view?.stop_settled} onClick={() => { approved.current = false; history.current = undefined; policy.current = undefined; setConversation([]); setView(current => current ? { ...current, can_reply: false, turn: null } : null); void run(context => locked(context, async value => accept(await value.stop(), value, context))); }}>{record.stopped ? '核实结束结果' : '结束并清除回答'}</button>
      </div><details><summary>会话详情</summary><dl><dt>会话编号</dt><dd>{record.session_id}</dd><dt>到期时间</dt><dd>{new Date(record.expires_at).toLocaleTimeString()}</dd></dl></details>
    </article>}
  </section>;
}
