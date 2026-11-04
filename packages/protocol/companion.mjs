import { parseBoundedJSON, sameJSON } from './products.mjs';
import { documentDigest } from './model-validation.mjs';
import { VoiceTurnClient, parseVoiceTurn, parseVoiceTextContext } from './voice-turns.mjs';

const fields = (v, names) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const hash = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const problem = code => Object.assign(new Error(code), { code });
const stopSettled = record => record.turns.every(slot => slot.record === null || slot.record.stopped && Object.entries(slot.record.jobs).every(([kind, job]) =>
  job === null || job.rejected_code !== null || job.observation && ['succeeded', 'failed', 'discarded'].includes(job.observation.status) &&
  (kind !== 'text' || job.observation.status !== 'succeeded' || job.observation.output?.cleared_at !== null)));

export function parseCompanionPolicy(raw) {
  try {
    const v = parseBoundedJSON(raw, { maxBytes: 16384, maxDepth: 2, maxNodes: 32 });
    if (!fields(v, 'schema_version,policy_id,version,name,instructions,language,voice,max_turns,max_seconds') || v.schema_version !== 1 ||
        typeof v.policy_id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(v.policy_id) || typeof v.version !== 'string' || !/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(v.version) ||
        typeof v.name !== 'string' || !v.name.length || Array.from(v.name).length > 80 || typeof v.instructions !== 'string' || !v.instructions.trim() ||
        !['auto', 'zh', 'en'].includes(v.language) || !id(v.voice) || !Number.isInteger(v.max_turns) || v.max_turns < 1 || v.max_turns > 8 ||
        !Number.isInteger(v.max_seconds) || v.max_seconds < 30 || v.max_seconds > 1800) throw new Error();
    parseVoiceTextContext(JSON.stringify({ instructions: v.instructions, history: [] }));
    return v;
  } catch { throw problem('invalid_companion_policy'); }
}

export async function parseCompanionSession(raw, origin, space) {
  try {
    const v = parseBoundedJSON(raw, { maxBytes: 65535, maxDepth: 16, maxNodes: 8192 });
    if (!fields(v, 'version,origin,space_id,session_id,previous_ids,policy_digest,deployments,created_at,expires_at,max_turns,stopped,history,turns,checksum') ||
        v.version !== 1 || v.origin !== origin || v.space_id !== space || typeof space !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(space) || !id(v.session_id) ||
        !Array.isArray(v.previous_ids) || v.previous_ids.length > 256 || v.previous_ids.some(value => !id(value) || value === v.session_id) || new Set(v.previous_ids).size !== v.previous_ids.length ||
        !hash(v.policy_digest) || !fields(v.deployments, 'transcription,text,speech') || !Object.values(v.deployments).every(hash) || !time(v.created_at) || !time(v.expires_at) || Date.parse(v.expires_at) <= Date.parse(v.created_at) || Date.parse(v.expires_at) - Date.parse(v.created_at) > 1800000 ||
        !Number.isInteger(v.max_turns) || v.max_turns < 1 || v.max_turns > 8 || typeof v.stopped !== 'boolean' || !fields(v.history, 'digest,message_count') || !hash(v.history.digest) ||
        !Number.isInteger(v.history.message_count) || v.history.message_count < 0 || v.history.message_count > 16 || v.history.message_count % 2 !== 0 ||
        !Array.isArray(v.turns) || v.turns.length > v.max_turns || !hash(v.checksum)) throw new Error();
    const { checksum, ...body } = v; if (await documentDigest(body) !== checksum) throw new Error();
    let completed = 0;
    for (const [index, slot] of v.turns.entries()) {
      if (!fields(slot, 'turn_id,media_id,context_digest,completed,record') || slot.turn_id !== `${v.session_id}_t${index + 1}` ||
          typeof slot.media_id !== 'string' || !/^media-[A-Za-z0-9_-]{1,122}$/.test(slot.media_id) || !hash(slot.context_digest) || typeof slot.completed !== 'boolean' ||
          index < v.turns.length - 1 && !slot.completed || slot.completed && slot.record === null) throw new Error();
      if (slot.record !== null) {
        const turn = await parseVoiceTurn(JSON.stringify(slot.record), origin, space, { contextual: true });
        if (turn.version !== 2 || !sameJSON(turn.deployments, v.deployments) || turn.turn_id !== slot.turn_id || turn.source.media_id !== slot.media_id || turn.text_context.digest !== slot.context_digest ||
            turn.text_context.history_messages !== index * 2 || Date.parse(turn.created_at) < Date.parse(v.created_at) || Date.parse(turn.expires_at) > Date.parse(v.expires_at) ||
            slot.completed && turn.jobs.speech?.observation?.status !== 'succeeded') throw new Error();
      }
      if (slot.completed) completed++;
    }
    if (v.history.message_count !== completed * 2 || completed === 0 && v.history.digest !== await documentDigest([])) throw new Error();
    return v;
  } catch { throw problem('companion_record_unavailable'); }
}

// 会话只保存摘要和原回合；历史正文由调用方显式持有，不建立服务端记忆或设备队列。
export class CompanionClient {
  constructor({ origin, space, journal, request, policy, history, signal, active = () => true, now = () => Date.now() }) {
    this.origin = origin; this.space = space; this.journal = journal; this.request = request;
    this.policy = policy === undefined ? undefined : parseCompanionPolicy(JSON.stringify(policy));
    this.history = history === undefined ? undefined : structuredClone(history);
    this.signal = signal; this.active = active; this.now = now; this.busy = false;
  }
  check() { if (this.signal?.aborted || !this.active()) throw problem('companion_paused'); }
  async operate(action) {
    if (this.busy) throw problem('companion_busy'); this.busy = true;
    try { this.check(); return await action(); } finally { this.busy = false; }
  }
  async load() {
    this.check(); const raw = await this.journal.load(); this.check();
    return raw === null ? null : parseCompanionSession(raw, this.origin, this.space);
  }
  async requireRecord() { const record = await this.load(); if (!record) throw problem('companion_not_found'); return record; }
  async save(previous, body) {
    this.check(); const { checksum: _, ...rest } = body, next = { ...rest, checksum: await documentDigest(rest) };
    await parseCompanionSession(JSON.stringify(next), this.origin, this.space); this.check();
    await this.journal.save(previous, next); this.check();
    const saved = await this.load(); if (!saved || !sameJSON(saved, next)) throw problem('companion_record_unavailable'); return saved;
  }
  async historyAvailable(record) { return Array.isArray(this.history) && this.history.length === record.history.message_count && await documentDigest(this.history) === record.history.digest; }
  async deployments() {
    const capabilities = await new VoiceTurnClient({ origin: this.origin, space: this.space, journal: this.journal, request: this.request, signal: this.signal, active: this.active, now: this.now }).capabilities();
    if (!Object.values(capabilities).every(value => value.configured) || !capabilities.speech.voices.includes(this.policy.voice)) throw problem('companion_not_configured');
    return Object.fromEntries(Object.entries(capabilities).map(([kind, value]) => [kind, value.deployment.revision]));
  }
  async requireLive(record) {
    if (record.stopped) throw problem('companion_stopped');
    if (this.now() >= Date.parse(record.expires_at)) throw problem('companion_expired');
    if (!this.policy || await documentDigest(this.policy) !== record.policy_digest || this.policy.max_turns !== record.max_turns ||
        Date.parse(record.expires_at) - Date.parse(record.created_at) !== this.policy.max_seconds * 1000) throw problem('companion_policy_changed');
    if (!await this.historyAvailable(record)) throw problem('companion_history_unavailable');
    if (!sameJSON(await this.deployments(), record.deployments)) throw problem('companion_configuration_changed');
    return { instructions: this.policy.instructions, history: this.history };
  }
  voice(record, index, textContext) {
    const sessionID = record.session_id, turnID = record.turns[index].turn_id;
    const loadSession = async () => {
      const current = await this.requireRecord();
      if (current.session_id !== sessionID || current.turns[index]?.turn_id !== turnID) throw problem('companion_record_unavailable');
      return current;
    };
    return new VoiceTurnClient({ origin: this.origin, space: this.space, request: this.request, signal: this.signal, active: this.active, now: this.now,
      contextual: true, textContext, deadline: Date.parse(record.expires_at), journal: {
        load: async () => { const current = await loadSession(); return current.turns[index].record === null ? null : JSON.stringify(current.turns[index].record); },
        save: async (previous, next) => {
          const current = await loadSession();
          if (!sameJSON(current.turns[index].record, previous) || current.stopped && !next.stopped) throw problem('companion_record_unavailable');
          const turns = structuredClone(current.turns); turns[index].record = next;
          await this.save(current, { ...current, turns });
        },
      } });
  }
  async view(record, turn = null) {
    const available = await this.historyAvailable(record), last = record.turns.at(-1);
    const phase = record.stopped ? 'stopped' : this.now() >= Date.parse(record.expires_at) ? 'expired' : turn?.phase ?? (last ? last.record === null ? 'prepared' : last.completed ? 'succeeded' : 'paused' : 'ready');
    const policyMatches = this.policy !== undefined && await documentDigest(this.policy) === record.policy_digest;
    return { record, phase, history_available: available, turns_remaining: record.max_turns - record.turns.length,
      can_reply: !record.stopped && this.now() < Date.parse(record.expires_at) && available && policyMatches && (!last || last.completed) && record.turns.length < record.max_turns,
      stop_settled: record.stopped && stopSettled(record), turn: ['stopped', 'expired'].includes(phase) ? null : turn };
  }
  async finish(turn) {
    let record = await this.requireRecord(); const index = record.turns.length - 1, slot = record.turns[index];
    if (!slot || turn.record.turn_id !== slot.turn_id || !sameJSON(turn.record, slot.record)) throw problem('companion_record_unavailable');
    if (!record.stopped && this.now() < Date.parse(record.expires_at) && turn.phase === 'succeeded' && !slot.completed && turn.transcript !== null && turn.answer !== null && await this.historyAvailable(record)) {
      const history = [...this.history, { role: 'user', content: turn.transcript }, { role: 'assistant', content: turn.answer }];
      const turns = structuredClone(record.turns); turns[index].completed = true;
      record = await this.save(record, { ...record, turns, history: { digest: await documentDigest(history), message_count: history.length } });
      this.history = history;
    }
    return this.view(record, turn);
  }
  async start(sessionID) { return this.operate(async () => {
    if (!id(sessionID) || !this.policy) throw problem('invalid_companion_request');
    const previous = await this.load();
    if (previous && (!previous.stopped || !stopSettled(previous))) throw problem('companion_session_pending');
    const ids = previous ? [...previous.previous_ids, previous.session_id] : [];
    if (ids.includes(sessionID) || ids.length > 256) throw problem('companion_session_id_unavailable');
    const deployments = await this.deployments(), created = this.now();
    const record = await this.save(previous, { version: 1, origin: this.origin, space_id: this.space, session_id: sessionID, previous_ids: ids,
      policy_digest: await documentDigest(this.policy), deployments, created_at: new Date(created).toISOString(), expires_at: new Date(created + this.policy.max_seconds * 1000).toISOString(),
      max_turns: this.policy.max_turns, stopped: false, history: { digest: await documentDigest([]), message_count: 0 }, turns: [] });
    this.history = []; return this.view(record);
  }); }
  async reply(mediaID) { return this.operate(async () => {
    let record = await this.requireRecord(); const candidate = await this.requireLive(record);
    if (record.turns.at(-1) && !record.turns.at(-1).completed) throw problem('companion_turn_pending');
    if (record.turns.length >= record.max_turns) throw problem('companion_turn_budget_exceeded');
    const context = parseVoiceTextContext(JSON.stringify(candidate));
    if (typeof mediaID !== 'string' || !/^media-[A-Za-z0-9_-]{1,122}$/.test(mediaID)) throw problem('invalid_companion_request');
    const index = record.turns.length, slot = { turn_id: `${record.session_id}_t${index + 1}`, media_id: mediaID, context_digest: await documentDigest(context), completed: false, record: null };
    record = await this.save(record, { ...record, turns: [...record.turns, slot] });
    const turn = await this.voice(record, index, context).start({ turn_id: slot.turn_id, media_id: mediaID, language: this.policy.language, voice: this.policy.voice });
    return this.finish(turn);
  }); }
  async resolve() { return this.operate(async () => {
    const record = await this.requireRecord(), index = record.turns.length - 1;
    if (index < 0 || record.turns[index].record === null) return this.view(record);
    return this.finish(await this.voice(record, index).resolve());
  }); }
  async continue() { return this.operate(async () => {
    const record = await this.requireRecord(), context = await this.requireLive(record), index = record.turns.length - 1;
    if (index < 0 || record.turns[index].record === null) throw problem('companion_preparation_incomplete');
    return this.finish(await (record.turns[index].completed ? this.voice(record, index).resolve() : this.voice(record, index, context).continue()));
  }); }
  async stop() { return this.operate(async () => {
    this.history = undefined;
    let record = await this.requireRecord();
    if (!record.stopped) record = await this.save(record, { ...record, stopped: true });
    for (let index = 0; index < record.turns.length; index++) if (record.turns[index].record !== null) await this.voice(record, index).stop();
    return this.view(await this.requireRecord());
  }); }
}
