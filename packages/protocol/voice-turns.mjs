import { documentDigest } from './model-validation.mjs';
import { parseBoundedJSON, sameJSON } from './products.mjs';
import { createTranscriptionOriginal, validTranscriptionOriginal, verifyTranscriptionCapabilities, verifyTranscriptionTask } from './transcription.mjs';
import { createTextOriginal, parseTextInput, validTextOriginal, verifyTextCapabilities, verifyTextTask } from './text.mjs';
import { createSpeechOriginal, parseSpeechInput, validSpeechOriginal, verifySpeechCapabilities, verifySpeechTask } from './speech.mjs';
import { verifyMediaPage } from './media.mjs';

const kinds = ['transcription', 'text', 'speech'];
const families = { transcription: 'audio-transcriptions', text: 'text-generations', speech: 'speech-syntheses' };
const identities = { transcription: 'transcription_id', text: 'text_id', speech: 'synthesis_id' };
const creators = { transcription: createTranscriptionOriginal, text: createTextOriginal, speech: createSpeechOriginal };
const originals = { transcription: validTranscriptionOriginal, text: validTextOriginal, speech: validSpeechOriginal };
const verifiers = { transcription: verifyTranscriptionTask, text: verifyTextTask, speech: verifySpeechTask };
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const timestamp = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const problem = code => Object.assign(new Error(code), { code });
const instructions = '请根据用户的语音内容，用简短、清晰的中文回答。回答不超过300字，不调用工具。';
const pending = value => !value || ['running', 'unknown'].includes(value.status);

export const voiceTurnLimits = Object.freeze({ max_seconds: 300, calls_per_stage: 1, stages: Object.freeze([...kinds]), playback: false, memory: false });

export function parseVoiceTextContext(raw) {
  try {
    const value = parseBoundedJSON(raw, { maxBytes: 32768, maxDepth: 4, maxNodes: 128 });
    if (!fields(value, 'instructions,history') || !Array.isArray(value.history) || value.history.length > 14 || value.history.length % 2 !== 0) throw new Error();
    parseTextInput(JSON.stringify({ instructions: value.instructions, messages: [...value.history, { role: 'user', content: '_' }], retain_seconds: 600, expires_at: '2030-01-01T00:00:00.000Z' }));
    return value;
  } catch { throw problem('invalid_voice_turn_context'); }
}

function validObservation(v) {
  return fields(v, 'identity_digest,terminal_digest,status,updated_at,output,media_id') && hash(v.identity_digest) && (v.terminal_digest === null || hash(v.terminal_digest)) && ['running', 'succeeded', 'failed', 'unknown', 'discarded'].includes(v.status) && timestamp(v.updated_at) && (v.media_id === null || identifier(v.media_id) && v.media_id.startsWith('media-')) && (v.output === null || fields(v.output, 'content_digest,expires_at,cleared_at') && hash(v.output.content_digest) && timestamp(v.output.expires_at) && (v.output.cleared_at === null || timestamp(v.output.cleared_at)));
}

// 本地账本只保存原键、摘要和去正文观测；其内容不授予网关执行权限。
export async function parseVoiceTurn(raw, origin, space, { contextual = false } = {}) {
  try {
    const v = parseBoundedJSON(raw, { maxBytes: 32768, maxDepth: 8, maxNodes: 512 });
    const withContext = contextual && v?.version === 2;
    if (!fields(v, 'version,origin,space_id,turn_id,created_at,expires_at,source,language,voice,retain_seconds,deployments,jobs,stopped,checksum' + (withContext ? ',text_context' : '')) || !(v.version === 1 || withContext) || v.origin !== origin || v.space_id !== space || !identifier(space) || !identifier(v.turn_id) || !timestamp(v.created_at) || !timestamp(v.expires_at) || Date.parse(v.expires_at) <= Date.parse(v.created_at) || Date.parse(v.expires_at) - Date.parse(v.created_at) > 300000 || !fields(v.source, 'media_id,content_digest,expires_at') || !identifier(v.source.media_id) || !v.source.media_id.startsWith('media-') || !hash(v.source.content_digest) || !timestamp(v.source.expires_at) || Date.parse(v.expires_at) > Date.parse(v.source.expires_at) || !['auto', 'zh', 'en'].includes(v.language) || !identifier(v.voice) || v.voice.length > 64 || v.retain_seconds !== 600 || !fields(v.deployments, 'transcription,text,speech') || !kinds.every(kind => hash(v.deployments[kind])) || !fields(v.jobs, 'transcription,text,speech') || typeof v.stopped !== 'boolean' || !hash(v.checksum)) throw new Error();
    if (withContext && (!fields(v.text_context, 'digest,history_messages') || !hash(v.text_context.digest) || !Number.isInteger(v.text_context.history_messages) || v.text_context.history_messages < 0 || v.text_context.history_messages > 14 || v.text_context.history_messages % 2 !== 0)) throw new Error();
    const { checksum, ...body } = v; if (await documentDigest(body) !== checksum) throw new Error();
    for (const [index, kind] of kinds.entries()) {
      const job = v.jobs[kind]; if (job === null) continue;
      if (!fields(job, 'original,observation,rejected_code,discard_attempted') || !originals[kind](job.original, origin, space, `${v.turn_id}-${kind}`) || !(job.observation === null || validObservation(job.observation)) || !(job.rejected_code === null || typeof job.rejected_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(job.rejected_code)) || typeof job.discard_attempted !== 'boolean' || index > 0 && (!v.jobs[kinds[index - 1]] || v.jobs[kinds[index - 1]].observation?.status !== 'succeeded') || job.discard_attempted && !v.stopped) throw new Error();
      if (job.observation) {
        const observed = job.observation, succeeded = observed.status === 'succeeded';
        if ((observed.terminal_digest !== null) !== ['succeeded', 'failed', 'discarded'].includes(observed.status) || (observed.output !== null) !== (succeeded && kind !== 'speech') || (observed.media_id !== null) !== (succeeded && kind === 'speech') || job.rejected_code !== null) throw new Error();
      }
      if (kind === 'transcription' && (job.original.input.media_id !== v.source.media_id || job.original.input.media_digest !== v.source.content_digest || job.original.input.language !== v.language)) throw new Error();
      if (kind === 'text' && (job.original.input.message_count !== (withContext ? v.text_context.history_messages + 1 : 1) || job.original.input.retain_seconds !== v.retain_seconds)) throw new Error();
      if (kind === 'speech' && (job.original.voice !== v.voice || job.original.retain_seconds !== v.retain_seconds)) throw new Error();
      if (kind !== 'speech' && await documentDigest({ space_id: space, idempotency_key: job.original.idempotency_key, input: job.original.input }) !== job.original.request_digest) throw new Error();
    }
    return v;
  } catch { throw problem('voice_turn_record_unavailable'); }
}

async function observation(task, kind, previous) {
  const identity = { id: task[identities[kind]], request_digest: task.request_digest, deployment: task.deployment, created_at: task.created_at };
  const terminal = ['succeeded', 'failed', 'discarded'].includes(task.status) ? { status: task.status, updated_at: task.updated_at, error_code: task.error_code, usage: task.usage ?? null, media_id: task.media_id ?? null, output: task.output ? { content_digest: task.output.content_digest, expires_at: task.output.expires_at } : null } : null;
  const next = { identity_digest: await documentDigest(identity), terminal_digest: terminal === null ? null : await documentDigest(terminal), status: task.status, updated_at: new Date(task.updated_at).toISOString(), output: task.output ? { content_digest: task.output.content_digest, expires_at: new Date(task.output.expires_at).toISOString(), cleared_at: task.output.cleared_at === null ? null : new Date(task.output.cleared_at).toISOString() } : null, media_id: task.media_id ?? null };
  if (previous && (next.identity_digest !== previous.identity_digest || previous.terminal_digest !== null && previous.terminal_digest !== next.terminal_digest || Date.parse(next.updated_at) < Date.parse(previous.updated_at) || ['succeeded', 'failed', 'discarded'].includes(previous.status) && next.status !== previous.status || previous.status === 'unknown' && !['unknown', 'discarded'].includes(next.status) || previous.media_id !== null && next.media_id !== previous.media_id || previous.output && (!next.output || previous.output.content_digest !== next.output.content_digest || previous.output.expires_at !== next.output.expires_at || previous.output.cleared_at !== null && previous.output.cleared_at !== next.output.cleared_at))) throw problem('invalid_voice_turn_response');
  return next;
}

// 调用方必须在整个操作期间持有空间级独占锁，并提供当前前台/进程的取消信号。
export class VoiceTurnClient {
  constructor({ origin, space, journal, request, signal, active = () => true, now = () => Date.now(), contextual = false, textContext, deadline = Infinity }) {
    this.origin = origin; this.space = space; this.journal = journal; this.request = request; this.signal = signal; this.active = active; this.now = now;
    this.prefix = `/api/v1/spaces/${encodeURIComponent(space)}`;
    this.contextual = contextual || textContext !== undefined;
    this.textContext = textContext === undefined ? undefined : parseVoiceTextContext(JSON.stringify(textContext));
    if (!(deadline === Infinity || Number.isSafeInteger(deadline) && deadline > 0)) throw problem('invalid_voice_turn_context');
    this.deadline = deadline;
  }
  check() { if (this.signal?.aborted || !this.active()) throw problem('voice_turn_paused'); }
  async load() {
    this.check(); const raw = await this.journal.load(); this.check();
    return raw === null ? null : parseVoiceTurn(raw, this.origin, this.space, { contextual: this.contextual });
  }
  async save(previous, body) {
    this.check(); const { checksum: _, ...rest } = body;
    const next = { ...rest, checksum: await documentDigest(rest) }; this.check();
    await this.journal.save(previous, next); this.check();
    const raw = await this.journal.load(); this.check();
    if (raw === null || !sameJSON(await parseVoiceTurn(raw, this.origin, this.space, { contextual: this.contextual }), next)) throw problem('voice_turn_record_unavailable');
    return next;
  }
  async call(resource, input, key) {
    this.check(); const value = await this.request(this.prefix + resource, input, key); this.check(); return value;
  }
  async capabilities() {
    const raw = await this.call('/capabilities');
    return { transcription: verifyTranscriptionCapabilities(raw.transcription), text: verifyTextCapabilities(raw.text), speech: verifySpeechCapabilities(raw.speech) };
  }
  async source(record) {
    const page = verifyMediaPage(await this.call('/media'), this.space);
    const source = page.items.find(item => item.metadata.media_id === record.source.media_id);
    if (!source?.available || source.metadata.content_digest !== record.source.content_digest || Date.parse(source.metadata.expires_at) !== Date.parse(record.source.expires_at) || Date.parse(source.metadata.expires_at) <= this.now()) throw problem('voice_turn_source_unavailable');
    return source;
  }
  async start({ turn_id, media_id, language, voice }) {
    if (!identifier(turn_id) || turn_id.length > 96 || !identifier(media_id) || !media_id.startsWith('media-') || !['auto', 'zh', 'en'].includes(language) || !identifier(voice) || voice.length > 64) throw problem('invalid_voice_turn_request');
    const previous = await this.load();
    if (previous && (kinds.some(kind => previous.jobs[kind] && !previous.jobs[kind].rejected_code && (pending(previous.jobs[kind].observation) || previous.jobs[kind].discard_attempted && kind === 'text' && previous.jobs[kind].observation.status === 'succeeded' && previous.jobs[kind].observation.output?.cleared_at === null)) || previous.turn_id === turn_id)) throw problem('voice_turn_pending');
    if (previous && !previous.stopped && previous.jobs.speech?.observation?.status !== 'succeeded' && !kinds.some(kind => previous.jobs[kind]?.rejected_code || ['failed', 'discarded'].includes(previous.jobs[kind]?.observation?.status))) throw problem('voice_turn_pending');
    const capabilities = await this.capabilities();
    if (!kinds.every(kind => capabilities[kind].configured) || !capabilities.speech.voices.includes(voice)) throw problem('voice_turn_not_configured');
    const page = verifyMediaPage(await this.call('/media'), this.space), source = page.items.find(item => item.metadata.media_id === media_id);
    if (!source?.available || Date.parse(source.metadata.expires_at) - this.now() < 1000) throw problem('voice_turn_source_unavailable');
    const created = this.now(), expires = Math.min(created + 300000, Date.parse(source.metadata.expires_at), this.deadline);
    if (expires <= created) throw problem('voice_turn_expired');
    if (this.contextual && !this.textContext) throw problem('voice_turn_context_unavailable');
    const context = this.contextual ? { text_context: { digest: await documentDigest(this.textContext), history_messages: this.textContext.history.length } } : {};
    const record = await this.save(previous, { version: this.contextual ? 2 : 1, ...context, origin: this.origin, space_id: this.space, turn_id, created_at: new Date(created).toISOString(), expires_at: new Date(expires).toISOString(), source: { media_id, content_digest: source.metadata.content_digest, expires_at: new Date(source.metadata.expires_at).toISOString() }, language, voice, retain_seconds: 600, deployments: Object.fromEntries(kinds.map(kind => [kind, capabilities[kind].deployment.revision])), jobs: { transcription: null, text: null, speech: null }, stopped: false });
    return this.advance(record);
  }
  async accept(record, kind, raw) {
    const job = record.jobs[kind], task = await verifiers[kind](raw, this.space, job.original.idempotency_key, job.original); this.check();
    if (task.deployment.revision !== record.deployments[kind]) throw problem('invalid_voice_turn_response');
    const next = { ...job, observation: await observation(task, kind, job.observation) };
    return { record: await this.save(record, { ...record, jobs: { ...record.jobs, [kind]: next } }), task };
  }
  async resolveRecord(record) {
    const tasks = {};
    for (const kind of kinds) {
      const job = record.jobs[kind]; if (!job || job.rejected_code !== null) continue;
      const result = await this.accept(record, kind, await this.call(`/${families[kind]}/by-key/${encodeURIComponent(job.original.idempotency_key)}`));
      record = result.record; tasks[kind] = result.task;
    }
    return { record, tasks };
  }
  view(record, tasks = {}) {
    const expired = this.now() >= Date.parse(record.expires_at), visible = !record.stopped && !expired;
    const body = kind => visible && tasks[kind]?.output && Date.parse(tasks[kind].output.expires_at) > this.now() ? tasks[kind].output.text : null;
    let phase = record.stopped ? 'stopped' : expired ? 'expired' : 'ready';
    if (visible) for (const kind of kinds) {
      const job = record.jobs[kind];
      if (job?.rejected_code) { phase = 'failed'; break; }
      if (job && job.observation?.status !== 'succeeded') { phase = job.observation?.status ?? 'unknown'; break; }
      if (!job) { phase = 'ready'; break; }
      if (kind === 'speech') phase = 'succeeded';
    }
    return { record, phase, stage: [...kinds].reverse().find(kind => record.jobs[kind]) ?? null, transcript: body('transcription'), answer: body('text'), media_id: visible && phase === 'succeeded' ? record.jobs.speech.observation.media_id : null };
  }
  async resolve() { const record = await this.load(); if (!record) throw problem('voice_turn_not_found'); const result = await this.resolveRecord(record); return this.view(result.record, result.tasks); }
  async continue() { const record = await this.load(); if (!record) throw problem('voice_turn_not_found'); return this.advance(record); }
  async advance(record) {
    let { record: current, tasks } = await this.resolveRecord(record);
    if (current.stopped || this.now() >= Date.parse(current.expires_at)) return this.view(current, tasks);
    if (current.version === 2 && (!this.textContext || await documentDigest(this.textContext) !== current.text_context.digest)) throw problem('voice_turn_context_unavailable');
    for (const kind of kinds) {
      const job = current.jobs[kind];
      if (job) { if (job.rejected_code || job.observation?.status !== 'succeeded') break; continue; }
      await this.source(current);
      const capabilities = await this.capabilities();
      if (!kinds.every(stage => capabilities[stage].configured && capabilities[stage].deployment.revision === current.deployments[stage])) throw problem('voice_turn_configuration_changed');
      const deadline = new Date(Math.min(this.now() + 85000, Date.parse(current.expires_at))).toISOString();
      const availableText = stage => {
        const output = tasks[stage]?.output;
        if (!output || output.text === null || !output.text.trim() || Date.parse(output.expires_at) <= this.now()) throw problem('voice_turn_text_unavailable');
        return output.text;
      };
      let input;
      if (kind === 'transcription') input = { media_id: current.source.media_id, media_digest: current.source.content_digest, language: current.language, expires_at: deadline };
      if (kind === 'text') input = { instructions: current.version === 2 ? this.textContext.instructions : instructions, messages: [...(current.version === 2 ? this.textContext.history : []), { role: 'user', content: availableText('transcription') }], retain_seconds: current.retain_seconds, expires_at: deadline };
      if (kind === 'speech') {
        input = { text: availableText('text'), voice: current.voice, retain_seconds: current.retain_seconds, expires_at: deadline };
        try { parseSpeechInput(JSON.stringify(input)); } catch { throw problem('voice_turn_answer_not_speakable'); }
      }
      const original = await creators[kind](this.origin, this.space, `${current.turn_id}-${kind}`, input); this.check();
      if (this.now() >= Date.parse(current.expires_at)) return this.view(current, tasks);
      current = await this.save(current, { ...current, jobs: { ...current.jobs, [kind]: { original, observation: null, rejected_code: null, discard_attempted: false } } });
      if (this.now() >= Date.parse(current.expires_at)) return this.view(current, tasks);
      let raw;
      try { raw = await this.call(`/${families[kind]}`, input, original.idempotency_key); }
      catch (error) {
        if (error.definitiveRejection) {
          const rejected = { ...current.jobs[kind], rejected_code: error.code };
          await this.save(current, { ...current, jobs: { ...current.jobs, [kind]: rejected } });
        }
        throw error;
      }
      const result = await this.accept(current, kind, raw); current = result.record; tasks[kind] = result.task;
      if (result.task.status !== 'succeeded') break;
    }
    return this.view(current, tasks);
  }
  async stop() {
    let record = await this.load(); if (!record) throw problem('voice_turn_not_found');
    if (!record.stopped) record = await this.save(record, { ...record, stopped: true });
    for (const kind of kinds) {
      const job = record.jobs[kind];
      if (!job || job.rejected_code || kind === 'text' && job.observation?.output?.cleared_at || !pending(job.observation) && !(kind === 'text' && job.observation.status === 'succeeded')) continue;
      if (!job.discard_attempted) {
        record = await this.save(record, { ...record, jobs: { ...record.jobs, [kind]: { ...job, discard_attempted: true } } });
        const result = await this.accept(record, kind, await this.call(`/${families[kind]}/by-key/${encodeURIComponent(job.original.idempotency_key)}/discard`, {})); record = result.record;
      } else {
        const result = await this.accept(record, kind, await this.call(`/${families[kind]}/by-key/${encodeURIComponent(job.original.idempotency_key)}`)); record = result.record;
      }
    }
    return this.view(record);
  }
}
