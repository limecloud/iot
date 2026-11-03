import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createPrivate, privateDirectory, readPrivate, writePrivate } from './control-files.mjs';
import { documentDigest, canonicalJSON } from '../../protocol/model-validation.mjs';

export const taskError = (code, exit = 2) => Object.assign(new Error(code), { safeCode: code, exit });
const hash = value => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['command', 'rule.deploy', 'rule.stop']);

// 本地任务记录只用于恢复原请求；不能授予网关权限或作为设备成功证据。
export class TaskJournal {
  constructor(directory, origin, space) {
    this.origin = origin; this.space = space;
    this.directory = path.join(path.resolve(directory), hash(origin + '\n' + space));
    this.seen = new Set();
  }
  async record(kind, input) {
    const request_digest = await documentDigest({ kind, input });
    const task_id = 'task-' + hash(this.origin + '\n' + this.space + '\n' + request_digest);
    return { version: 1, origin: this.origin, space_id: this.space, task_id, kind, input: structuredClone(input), request_digest, result: null };
  }
  file(id) {
    if (!/^task-[a-f0-9]{64}$/.test(id ?? '')) throw taskError('task_not_found');
    return path.join(this.directory, id + '.json');
  }
  async validate(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'input,kind,origin,request_digest,result,space_id,task_id,version' || value.version !== 1 || value.origin !== this.origin || value.space_id !== this.space || !kinds.has(value.kind)) throw taskError('original_record_unavailable', 5);
    const expected = await this.record(value.kind, value.input);
    if (expected.task_id !== value.task_id || expected.request_digest !== value.request_digest || value.result !== null && (typeof value.result !== 'object' || Array.isArray(value.result))) throw taskError('original_record_unavailable', 5);
    return value;
  }
  async list() {
    try {
      await privateDirectory(this.directory, true);
      const names = (await readdir(this.directory)).filter(name => name !== '.lock');
      if (names.length > 256 || names.some(name => !/^task-[a-f0-9]{64}\.json$/.test(name))) throw new Error();
      if ([...this.seen].some(name => !names.includes(name))) throw new Error();
      const records = [];
      for (const name of names) {
        const record = await this.validate(await readPrivate(path.join(this.directory, name)));
        if (name !== record.task_id + '.json') throw new Error();
        records.push(record); this.seen.add(name);
      }
      return records;
    } catch { throw taskError('original_record_unavailable', 5); }
  }
  async create(record) {
    try {
      await createPrivate(this.file(record.task_id), record);
      this.seen.add(record.task_id + '.json');
      const saved = await this.validate(await readPrivate(this.file(record.task_id)));
      if (canonicalJSON(saved) !== canonicalJSON(record)) throw new Error();
    } catch { throw taskError('original_record_unavailable', 5); }
  }
  async save(record, result) {
    const next = { ...record, result: structuredClone(result) };
    try {
      await writePrivate(this.file(record.task_id), next);
      const saved = await this.validate(await readPrivate(this.file(record.task_id)));
      if (canonicalJSON(saved) !== canonicalJSON(next)) throw new Error();
      return saved;
    } catch { throw taskError('original_record_unavailable', 6); }
  }
  async locked(run) {
    const file = path.join(this.directory, '.lock');
    const own = { pid: process.pid, host: hostname(), nonce: randomUUID() };
    try {
      await privateDirectory(this.directory, true);
      try { await createPrivate(file, own); }
      catch (error) {
        if (error.code !== 'EEXIST') throw taskError('original_record_unavailable', 5);
        let previous;
        try { previous = await readPrivate(file); } catch { throw taskError('task_session_busy', 4); }
        if (previous.host !== own.host || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.nonce !== 'string') throw taskError('task_session_busy', 4);
        // 不自动删除旧锁：检查PID后删除存在竞态，可能移除其他进程刚取得的锁。
        throw taskError('task_session_busy', 4);
      }
    } catch (error) { throw error.safeCode ? error : taskError('original_record_unavailable', 5); }
    try { return await run(); }
    finally {
      try { if (canonicalJSON(await readPrivate(file)) === canonicalJSON(own)) await unlink(file); } catch { /* 留锁时后续写入保守拒绝。 */ }
    }
  }
}
