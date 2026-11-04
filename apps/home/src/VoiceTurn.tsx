import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText, request, type Session } from './api';
import { VoiceTurnClient, parseVoiceTurn, type VoiceTurn as Turn, type VoiceTurnView } from '../../../packages/protocol/voice-turns.mjs';
import { verifySpeechCapabilities } from '../../../packages/protocol/speech.mjs';
import { verifyTextCapabilities } from '../../../packages/protocol/text.mjs';
import { verifyTranscriptionCapabilities } from '../../../packages/protocol/transcription.mjs';
import { sameJSON } from '../../../packages/protocol/products.mjs';
import type { MediaPage } from '../../../packages/protocol/media.mjs';

type Context = { epoch: number; signal: AbortSignal };
const phaseNames = { ready: '可以继续本轮', running: '正在处理', unknown: '结果待核实', failed: '本轮未完成', discarded: '已放弃输出', succeeded: '语音回答已生成', stopped: '本轮已结束', expired: '本轮已到期' };
const stageNames = { transcription: '识别录音', text: '生成回答', speech: '合成语音' };
const messages: Record<string, string> = {
  voice_turn_record_unavailable: '语音回合记录不可用，已暂停新请求', invalid_voice_turn_response: '回合结果未通过校验，请保留原任务',
  voice_turn_pending: '上一轮尚未核实，请先查询或结束本轮', voice_turn_not_configured: '请先配置识别、文字和语音服务',
  voice_turn_source_unavailable: '原录音已不可用', voice_turn_configuration_changed: '模型配置已变化，请结束本轮后重新开始',
  voice_turn_text_unavailable: '没有可继续处理的文本，请结束本轮', voice_turn_answer_not_speakable: '回答超出语音合成限制，请查看文字回答',
  voice_turn_lock_unavailable: '当前浏览器不支持安全提交语音回合', voice_turn_paused: '本轮已暂停，请查询原回合',
};

export function VoiceTurn({ prefix, session, online, files, onError, onGenerated }: { prefix: string; session: Session; online: boolean; files: MediaPage['items']; onError: (error: unknown) => void; onGenerated: (id: string) => void }) {
  const space = decodeURIComponent(prefix.split('/').at(-1)!), storage = `limeiot.voice-turn:${prefix}`;
  const [record, setRecord] = useState<Turn | null>(null), [view, setView] = useState<VoiceTurnView | null>(null);
  const [mediaID, setMediaID] = useState(''), [language, setLanguage] = useState<'auto' | 'zh' | 'en'>('auto'), [voice, setVoice] = useState(''), [voices, setVoices] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), currentOnline = useRef(online), epoch = useRef(0), abort = useRef(new AbortController()), working = useRef<symbol | null>(null), approved = useRef(false), seen = useRef(false), notified = useRef('');
  const generated = useRef(onGenerated); generated.current = onGenerated; currentOnline.current = online;
  const valid = (context: Context) => active.current && epoch.current === context.epoch && currentOnline.current && !document.hidden && !context.signal.aborted;
  function client(context: Context) {
    return new VoiceTurnClient({ origin: location.origin, space, signal: context.signal, active: () => valid(context), request: (resource, input, key) => request<unknown>(resource, session, input, { signal: context.signal, key }), journal: {
      async load() { const raw = localStorage.getItem(storage); if (seen.current && raw === null) throw new Error('voice_turn_record_unavailable'); if (raw !== null) seen.current = true; return raw; },
      async save(previous, next) {
        const raw = localStorage.getItem(storage);
        if (raw === null ? previous !== null : previous === null || !sameJSON(await parseVoiceTurn(raw, location.origin, space), previous)) throw new Error('voice_turn_record_unavailable');
        if (!valid(context)) throw new Error('voice_turn_paused');
        try { const encoded = JSON.stringify(next); localStorage.setItem(storage, encoded); if (localStorage.getItem(storage) !== encoded) throw new Error(); }
        catch { throw new Error('voice_turn_record_unavailable'); }
        seen.current = true; if (valid(context)) setRecord(next);
      },
    } });
  }
  function accept(value: VoiceTurnView, context: Context, reveal = true) {
    if (!valid(context)) return;
    setRecord(value.record); setView(reveal ? value : { ...value, transcript: null, answer: null });
    if (value.media_id && reveal && notified.current !== value.record.turn_id) { notified.current = value.record.turn_id; generated.current(value.media_id); }
    if (!['ready', 'running'].includes(value.phase)) approved.current = false;
  }
  async function locked(context: Context, work: (value: VoiceTurnClient) => Promise<void>) {
    if (!navigator.locks) throw new Error('voice_turn_lock_unavailable');
    await navigator.locks.request(storage, { mode: 'exclusive', ifAvailable: true }, async lock => { if (!lock) throw new ApiError('voice_turn_busy', 429); if (valid(context)) await work(client(context)); });
  }
  async function refresh(context: Context) {
    setReady(false);
    const raw = await request<{ transcription: unknown; text: unknown; speech: unknown }>(`${prefix}/capabilities`, session, undefined, { signal: context.signal });
    const asr = verifyTranscriptionCapabilities(raw.transcription), text = verifyTextCapabilities(raw.text), speech = verifySpeechCapabilities(raw.speech);
    if (!valid(context)) return;
    setConfigured(asr.configured && text.configured && speech.configured); setVoices(speech.configured ? speech.voices : []);
    setVoice(current => speech.configured && speech.voices.includes(current) ? current : speech.configured ? speech.voices[0] : '');
    await locked(context, async value => { const saved = await value.load(); if (valid(context)) setRecord(saved); if (saved) accept(await value.resolve(), context, false); });
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
      if (code === 'voice_turn_record_unavailable' || /^invalid_.*_response$/.test(code)) { setBlocked(true); setReady(false); setView(null); }
      setMessage(messages[code] ?? (error instanceof ApiError ? errorText(error) : '本轮结果待核实，请查询原回合'));
      if (error instanceof ApiError && error.status === 401) onError(error);
    } finally { if (working.current === token) { working.current = null; if (valid(context)) setBusy(false); } }
  }
  useEffect(() => {
    active.current = true;
    const invalidate = () => { epoch.current++; abort.current.abort(); abort.current = new AbortController(); working.current = null; approved.current = false; setView(null); setMediaID(''); setBusy(false); setReady(false); };
    invalidate(); if (online && !document.hidden) void run(refresh);
    const visibility = () => { invalidate(); if (currentOnline.current && !document.hidden) void run(refresh); };
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== storage) return;
      invalidate(); if ((event.key === null || event.newValue === null) && seen.current) { setBlocked(true); setMessage(messages.voice_turn_record_unavailable); }
      else if (currentOnline.current && !document.hidden) void run(refresh);
    };
    document.addEventListener('visibilitychange', visibility); addEventListener('storage', changed);
    return () => { active.current = false; epoch.current++; approved.current = false; abort.current.abort(); working.current = null; document.removeEventListener('visibilitychange', visibility); removeEventListener('storage', changed); };
  }, [online, session.csrf_token]);
  useEffect(() => {
    if (!record || !view || !online || busy || blocked || !ready || !['running', 'ready'].includes(view.phase)) return;
    const timer = setTimeout(() => void run(context => locked(context, async value => accept(await (approved.current ? value.continue() : value.resolve()), context, approved.current))), 1000);
    return () => clearTimeout(timer);
  }, [record, view, online, busy, blocked, ready]);
  useEffect(() => {
    if (!view || !record || ['stopped', 'expired'].includes(view.phase)) return;
    const deadlines = [record.expires_at, record.jobs.transcription?.observation?.output?.expires_at, record.jobs.text?.observation?.output?.expires_at].filter((value): value is string => !!value).map(Date.parse);
    const timer = setTimeout(() => { approved.current = false; setView(current => current ? { ...current, phase: Date.now() >= Date.parse(record.expires_at) ? 'expired' : current.phase, transcript: null, answer: null, media_id: null } : null); }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [view, record]);
  const available = files.filter(item => item.available && Date.parse(item.metadata.expires_at) > Date.now());
  const pending = record && !record.stopped && view?.phase !== 'succeeded' && view?.phase !== 'failed' && view?.phase !== 'discarded';
  const disabled = !online || busy || blocked || !ready;
  return <section className="rule-editor" aria-label="语音对话"><div className="section-heading"><h2>语音对话</h2><button disabled={!online || busy || blocked} onClick={() => void run(refresh)}>读取回合状态</button></div>
    {message && <p className="notice" role="status">{message}</p>}{ready && !configured && <p className="muted">请先配置本地识别、文字和语音服务</p>}
    {configured && <form onSubmit={event => { event.preventDefault(); void run(context => locked(context, async value => { approved.current = true; accept(await value.start({ turn_id: crypto.randomUUID(), media_id: mediaID, language, voice }), context); })); }}>
      <label htmlFor="voice-turn-media">对话录音</label><select id="voice-turn-media" value={mediaID} disabled={disabled || !!pending} onChange={event => setMediaID(event.target.value)}><option value="">选择已上传录音</option>{available.map(item => <option key={item.metadata.media_id} value={item.metadata.media_id}>音频 {item.metadata.media_id.slice(-8)}</option>)}</select>
      <label htmlFor="voice-turn-language">识别语言</label><select id="voice-turn-language" value={language} disabled={disabled || !!pending} onChange={event => setLanguage(event.target.value as 'auto' | 'zh' | 'en')}><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英语</option></select>
      <label htmlFor="voice-turn-voice">回答声音</label><select id="voice-turn-voice" value={voice} disabled={disabled || !!pending} onChange={event => setVoice(event.target.value)}>{voices.map(item => <option key={item} value={item}>{item}</option>)}</select>
      <button disabled={disabled || !!pending || !available.some(item => item.metadata.media_id === mediaID)}>生成语音回答</button>
    </form>}
    {record && <article className="registry-row" aria-label="当前语音回合"><div><strong>{view ? phaseNames[view.phase] : record.stopped ? '本轮已结束' : '结果待核实'}</strong>{view?.stage && <p className="muted">{stageNames[view.stage]}</p>}{view?.transcript !== null && view?.transcript !== undefined && <p aria-label="本轮识别文本" className="text-answer">{view.transcript}</p>}{view?.answer !== null && view?.answer !== undefined && <p aria-label="本轮文字回答" className="text-answer">{view.answer}</p>}{view?.media_id && <p className="muted">音频已选中，可在下方单独授权播放</p>}<details><summary>回合详情</summary><dl><dt>回合编号</dt><dd>{record.turn_id}</dd><dt>录音编号</dt><dd>{record.source.media_id}</dd></dl></details></div><div className="actions">
      <button disabled={!online || busy || blocked} onClick={() => void run(context => locked(context, async value => accept(await value.resolve(), context)))}>查询原回合</button>
      {!record.stopped && Date.parse(record.expires_at) > Date.now() && view?.phase !== 'succeeded' && <button disabled={disabled || !configured} onClick={() => void run(context => locked(context, async value => { approved.current = true; accept(await value.continue(), context); }))}>继续本轮</button>}
      <button disabled={!online || busy || blocked} onClick={() => { approved.current = false; setView(current => current ? { ...current, transcript: null, answer: null, media_id: null } : null); void run(context => locked(context, async value => accept(await value.stop(), context))); }}>结束并清除回答</button>
    </div></article>}
  </section>;
}
