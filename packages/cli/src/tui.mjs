import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { readPrivateToken } from './control-files.mjs';
import { GatewayTaskSession, sampleValue, checkFormValue } from './task-session.mjs';
import { taskError } from './task-journal.mjs';
import { parseBoundedJSON } from '../../protocol/products.mjs';
import { displayNumber, thresholdSamples, thresholdTrigger, unitLabel } from '../../protocol/threshold-form.mjs';
import { compileConditions, conditionOperators, newCondition, operatorsFor, restoreConditions } from '../../protocol/condition-form.mjs';
import { scheduleTrigger } from '../../protocol/schedule-form.mjs';

export const terminalText = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const json = value => terminalText(JSON.stringify(value));
const status = command => command.status === 'confirmed' && command.evidence?.type === 'action_result' ? ({ submitted: '输入已提交', observed: '效果已观测' }[command.evidence.completion] ?? '完成范围未知') : ({ accepted: '已受理', dispatched: '已发送', confirmed: '已确认', unknown: '结果未知', failed: '执行失败', rejected: '已拒绝', expired: '已过期' }[command.status] ?? '结果未知');
const messages = { review_required: '请先核对当前操作', review_expired: '核对已过期，请重新准备操作', original_task_unresolved: '该目标还有未确认的原任务，请先查询', operation_unknown: '结果尚未确认，请查询原任务', original_record_unavailable: '无法核对本地原任务记录，已停止写入', task_session_busy: '另一个终端正在处理任务', gateway_unavailable: '暂时无法连接网关', unauthenticated: '凭据无效或已撤销', forbidden: '当前身份无权执行此操作', invalid_value: '参数不符合设备要求', invalid_threshold: '阈值、单位或滞回不符合设备模型', rule_cycle: '联动形成循环，请调整触发条件或执行设备', revision_conflict: '规则已变化，请重新读取并预演', task_capacity_reached: '本地任务记录已达到上限', invalid_response: '网关响应未通过校验', invalid_simulation: '预演响应未通过校验' };
class Closed extends Error {}

export async function runTextTasks(session, input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output, terminal: !!input.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const say = value => output.write(terminalText(value) + '\n');
  const ask = async label => { output.write(terminalText(label) + '> '); const line = await lines.next(); if (line.done) throw new Closed(); return line.value.trim(); };
  const choose = async (label, items, describe = value => String(value), selected = -1) => {
    if (!items.length) { say('暂无可选项'); return null; }
    say(label); items.forEach((item, index) => say(`${index + 1}. ${describe(item)}`));
    for (;;) { const raw = await ask(selected >= 0 ? `选择，回车保留 ${selected + 1}，0 返回` : '选择，0 返回'); if (raw === '0') return null; const index = raw === '' ? selected : Number(raw) - 1; if (Number.isInteger(index) && index >= 0 && index < items.length) return items[index]; say('请选择列表中的编号'); }
  };
  async function valueForm(schema, label, current = sampleValue(schema)) {
    if (schema.enum?.length) { const selected = await choose(label, schema.enum.map(value => ({ value })), item => json(item.value), schema.enum.findIndex(item => json(item) === json(current))); if (!selected) throw new ClosedForm(); return selected.value; }
    if (schema.type === 'boolean') { const selected = await choose(label, [{ value: true, label: '开启' }, { value: false, label: '关闭' }], item => item.label, current === true ? 0 : 1); if (!selected) throw new ClosedForm(); return selected.value; }
    if (schema.type === 'object') {
      const result = {}; say(label);
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (!(schema.required ?? []).includes(key) && !Object.hasOwn(current ?? {}, key) && await ask(`${key} 为可选字段，输入 1 填写，回车跳过`) !== '1') continue;
        result[key] = await valueForm(child, key, current?.[key] ?? sampleValue(child));
      }
      if (schema.additionalProperties === true) {
        const extra = await ask('补充字段 JSON，回车跳过');
        if (extra) { const fields = parseBoundedJSON(extra); if (!fields || Array.isArray(fields) || typeof fields !== 'object' || Object.keys(fields).some(key => Object.hasOwn(schema.properties ?? {}, key))) throw taskError('invalid_value'); Object.assign(result, fields); }
      }
      return result;
    }
    for (;;) {
      const raw = await ask(`${label}（${schema.type}），回车保留 ${json(current)}`);
      let value = current;
      if (raw) { try { value = schema.type === 'string' ? raw : parseBoundedJSON(raw); } catch { say('请输入有效值'); continue; } }
      if (checkFormValue(value, schema)) return value;
      say('参数不符合设备要求');
    }
  }
  class ClosedForm extends Error {}
  function ruleLines(rule) {
    if (!rule) return ['未启用'];
    return [`${rule.id}：${rule.trigger.schedule ? '定时 ' + json(rule.trigger.schedule) : rule.trigger.device + ' ' + (rule.trigger.property ? json(rule.trigger.property) : rule.trigger.event)}`, ...(rule.conditions.length ? ['条件（全部满足）：' + json(rule.conditions)] : []), ...rule.actions.map((action, index) => `${index + 1}. ${action.device} ${action.invoke ? '调用 ' + action.invoke.path + ' ' + json(action.invoke.input) : '设置 ' + action.set.path + ' = ' + json(action.set.value)}`), `冷却 ${rule.cooldown_ms} 毫秒`];
  }
  function showEvaluation(evaluation) { if (evaluation) { say(`条件判断：${evaluation.matched ? '已满足' : '未满足'}`); say('原观测证据：' + json(evaluation)); } }
  async function confirm() {
    const review = session.review; if (!review) throw taskError('review_required');
    const { record } = review;
    if (record.kind === 'command') {
      say(`设备：${record.input.device_id}`); say(`操作：${record.input.operation.type} ${record.input.operation.path}`);
      say(`当前观测：${json(review.before)}`); say(`目标参数：${json(review.after)}`);
      if (review.capability.risk) say(`风险：${review.capability.risk}；完成范围：${review.capability.completion}`);
      say(`请求到期：${record.input.expires_at}`);
    } else { say('原规则'); ruleLines(review.before?.rule).forEach(say); say(record.kind === 'rule.stop' ? '目标：停用当前修订' : '新规则'); if (record.kind === 'rule.deploy') { ruleLines(review.after).forEach(say); say(review.simulation.matched ? '预演通过，设备尚未执行' : '触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。'); showEvaluation(review.simulation.condition_evaluation); } }
    const word = record.kind === 'command' ? '执行' : record.kind === 'rule.deploy' ? '启用' : '停用';
    if (await ask(`输入“${word}”确认，回车取消`) !== word) { await session.dispatch({ action: 'cancel' }); say('已取消，未发送'); return; }
    say('正在提交'); const result = await session.dispatch({ action: 'commit', task_id: record.task_id });
    say(`原任务：${result.task_id}`); say(result.result?.outcome === 'command' ? status(result.result.command) : result.result?.outcome === 'deployed' ? '自动化已启用' : result.result?.outcome === 'stopped' ? '自动化已停用' : '结果尚未确认');
  }
  async function deviceOperation(current) {
    const device = await choose('选择设备', session.data.devices, item => `${item.device_id} ${item.ready ? '已连接' : '当前未就绪'}`, session.data.devices.findIndex(item => item.device_id === current?.device));
    if (!device) throw new ClosedForm();
    const operations = session.operations(device.device_id);
    const operation = await choose('选择能力', operations, item => `${item.path} ${item.type}`, operations.findIndex(item => item.path === (current?.invoke?.path ?? current?.set?.path)));
    if (!operation) throw new ClosedForm();
    const value = await valueForm(operation.schema, '输入参数', current?.invoke?.input ?? current?.set?.value ?? sampleValue(operation.schema));
    return { device, operation, value };
  }
  async function conditionForm(conditions) {
    const sources = session.conditionSources();
    const forms = restoreConditions(conditions, sources);
    if (!forms) throw taskError('invalid_condition');
    const entries = (nodes = forms, path = []) => nodes.flatMap((node, index) => {
      const entry = { node, parent: nodes, index, path: [...path, index + 1] };
      return [entry, ...(node.kind === 'compare' ? [] : entries(node.children, entry.path))];
    });
    const describe = entry => `${entry.path.join('-')}. ${entry.node.kind === 'compare' ? `${entry.node.source} ${conditionOperators[entry.node.operator]} ${json(entry.node.value)}` : entry.node.kind === 'all' ? '全部满足' : '任一满足'}`;
    async function compare(current) {
      const source = await choose('选择条件属性', sources, source => `${source.device} ${source.path}${source.unit ? '（' + unitLabel(source.unit) + '）' : ''}`, sources.findIndex(source => source.key === current?.source));
      if (!source) return null;
      const form = source.key === current?.source ? structuredClone(current) : newCondition(source);
      const operator = await choose('选择比较方式', operatorsFor(source.schema), operator => conditionOperators[operator], operatorsFor(source.schema).indexOf(form.operator));
      if (!operator) return null;
      form.operator = operator;
      if (source.schema.type === 'boolean' || source.schema.enum?.length) {
        const values = source.schema.enum ?? [true, false];
        const value = await choose('选择比较值', values.map(value => ({ value })), item => json(item.value), values.findIndex(value => (typeof value === 'number' ? displayNumber(value, source.unit ?? '') : String(value)) === form.value));
        if (!value) return null;
        form.value = typeof value.value === 'number' ? displayNumber(value.value, source.unit ?? '') : String(value.value);
      } else for (;;) {
        const string = source.schema.type === 'string';
        const raw = await ask(`比较值（${string ? 'JSON字符串' : unitLabel(source.unit ?? source.schema.type)}），回车保留 ${json(form.value)}，/cancel 返回`);
        if (raw === '/cancel') return null;
        if (raw) {
          if (string) { try { const value = parseBoundedJSON(raw); if (typeof value !== 'string') throw new Error(); form.value = value; } catch { say('请输入JSON字符串，例如 "hello"'); continue; } }
          else form.value = raw;
        }
        if (compileConditions([form], sources)) break;
        say('比较值不符合属性类型、单位精度或值域，请重新填写');
      }
      return compileConditions([form], sources) ? form : null;
    }
    for (;;) {
      say('条件：顶层全部满足'); entries().forEach(entry => say(describe(entry)));
      const command = await ask('1 添加比较  2 添加组合  3 修改条件  4 删除条件  5 保存条件  0 取消条件编辑');
      if (command === '0') return null;
      if (command === '5') { const result = compileConditions(forms, sources); if (result) return result; say('条件组合必须非空，最多4层、32项，每组最多16项'); continue; }
      if (['1', '2'].includes(command)) {
        const parents = [{ children: forms, path: [], depth: 1 }, ...entries().filter(entry => entry.node.kind !== 'compare').map(entry => ({ children: entry.node.children, path: entry.path, depth: entry.path.length + 1 }))];
        const parent = await choose('添加到', parents.filter(parent => parent.children.length < 16 && parent.depth <= (command === '2' ? 3 : 4)), parent => parent.path.length ? `条件 ${parent.path.join('-')}` : '顶层');
        if (!parent) continue;
        const kind = command === '2' ? await choose('组合方式', ['all', 'any'], kind => kind === 'all' ? '全部满足' : '任一满足') : 'compare';
        if (!kind) continue;
        const comparison = await compare(); if (!comparison) continue;
        parent.children.push(kind === 'compare' ? comparison : { kind, children: [comparison] });
        if (!compileConditions(forms, sources)) { parent.children.pop(); say('条件超出组合限额，未添加'); }
      } else if (['3', '4'].includes(command)) {
        const selected = await choose('选择条件', entries(), describe); if (!selected) continue;
        if (command === '4') { if (selected.parent !== forms && selected.parent.length === 1) say('组合至少保留一个条件；如不再需要，请删除整个组合'); else selected.parent.splice(selected.index, 1); continue; }
        if (selected.node.kind === 'compare') { const form = await compare(selected.node); if (form) selected.parent[selected.index] = form; }
        else { const kind = await choose('组合方式', ['all', 'any'], kind => kind === 'all' ? '全部满足' : '任一满足', selected.node.kind === 'all' ? 0 : 1); if (kind) selected.node.kind = kind; }
      }
    }
  }
  async function ruleForm(existing) {
    if (existing && (existing.version !== 1 || restoreConditions(existing.conditions, session.conditionSources()) === null)) { say('当前菜单无法完整编辑此规则版本或条件，请通过 CLI/API 编辑。'); return; }
    const rule = existing ? structuredClone(existing) : { version: 1, id: 'rule-' + randomUUID(), trigger: null, conditions: [], actions: [], cooldown_ms: 10000 };
    const rawId = await ask(`规则 ID，回车保留 ${rule.id}`); if (rawId) rule.id = rawId;
    async function trigger() {
      const sources = [...session.sources(), { kind: 'schedule' }];
      const matches = item => item.kind === 'schedule' ? !!rule.trigger?.schedule : item.device_id === rule.trigger?.device && (item.kind === 'property' ? item.path === rule.trigger?.property?.path && item.unit === rule.trigger.property.unit : item.path === rule.trigger?.event);
      const source = await choose('选择触发事件或属性', sources, item => item.kind === 'schedule' ? '定时' : `${item.device_id} ${item.path}${item.kind === 'property' ? ' 属性（' + unitLabel(item.unit) + '）' : ' 事件'}`, sources.findIndex(matches));
      if (!source) throw new ClosedForm();
      if (source.kind === 'schedule') {
        let time = rule.trigger?.schedule?.time ?? '22:00', zone = rule.trigger?.schedule?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        let days = (rule.trigger?.schedule?.weekdays ?? [1,2,3,4,5,6,7]).join(',');
        for (;;) {
          const next = [];
          for (const [label, value] of [['时间（HH:MM）', time], ['IANA 时区', zone], ['星期（周一=1，逗号分隔）', days]]) { const input = await ask(`${label}，回车保留 ${value}`); if (input === '/cancel') throw new ClosedForm(); next.push(input || value); }
          [time, zone, days] = next;
          const schedule = scheduleTrigger(time, zone, days.split(',').map(day => /^\s*[1-7]\s*$/.test(day) ? Number(day) : NaN));
          if (schedule) { rule.trigger = { schedule }; return; }
          say('请检查时间、时区和星期；输入 /cancel 返回');
        }
      }
      if (source.kind !== 'property') { rule.trigger = { device: source.device_id, event: source.path }; return; }
      const current = matches(source) ? rule.trigger.property : null;
      const direction = await choose('变化方向', [{ value: 'rising', name: '上升越过' }, { value: 'falling', name: '下降越过' }], item => item.name, current?.edge === 'falling' ? 1 : 0);
      if (!direction) throw new ClosedForm();
      let threshold = displayNumber(current?.threshold ?? Math.min(source.schema.maximum ?? Infinity, Math.max(source.schema.minimum ?? -Infinity, 0)), source.unit);
      let hysteresis = displayNumber(current?.hysteresis ?? 0, source.unit);
      say('按显示单位输入，输入 /cancel 返回');
      for (;;) {
        const input = await ask(`阈值（${unitLabel(source.unit)}），回车保留 ${threshold}`); if (input === '/cancel') throw new ClosedForm(); if (input) threshold = input;
        const delta = await ask(`滞回（${unitLabel(source.unit)}），回车保留 ${hysteresis}`); if (delta === '/cancel') throw new ClosedForm(); if (delta) hysteresis = delta;
        const property = thresholdTrigger(source.path, source.unit, source.schema, direction.value, threshold, hysteresis);
        if (property && thresholdSamples(property, source.schema)) { rule.trigger = { device: source.device_id, property }; return; }
        say('阈值或滞回不符合设备模型，请重新填写；输入 /cancel 返回');
      }
    }
    await trigger();
    for (;;) { const value = await ask(`冷却时间（毫秒），回车保留 ${rule.cooldown_ms}`); const number = value === '' ? rule.cooldown_ms : Number(value); if (Number.isSafeInteger(number) && number >= 0 && number <= 86400000) { rule.cooldown_ms = number; break; } say('请输入 0 至 86400000 的整数'); }
    for (;;) {
      ruleLines(rule).forEach(say);
      const command = await ask('1 追加操作  2 修改操作  3 删除操作  4 调整顺序  5 预演并启用  6 更换触发  7 编辑条件  0 取消');
      if (command === '0') return;
      if (command === '6') { await trigger(); continue; }
      if (command === '7') { const conditions = await conditionForm(rule.conditions); if (conditions !== null) rule.conditions = conditions; continue; }
      if (command === '5') {
        if (!rule.actions.length) { say('请至少添加一个操作'); continue; }
        const property = rule.trigger.property;
        const source = session.sources().find(item => item.device_id === rule.trigger.device && (property ? item.kind === 'property' && item.path === property.path && item.unit === property.unit : item.kind !== 'property' && item.path === rule.trigger.event));
        if (!source && !rule.trigger.schedule) throw taskError('unsupported_capability');
        const data = rule.trigger.schedule ? null : property ? thresholdSamples(property, source.schema, { source: 'simulation.tui' }) : await valueForm(source.schema, '预演事件样本');
        if (!data && !rule.trigger.schedule) throw taskError('invalid_threshold');
        if (property) say('预演使用示例采样，不控制设备。');
        await session.dispatch({ action: 'rules.prepare', rule, event_data: data }); await confirm(); return;
      }
      if (!['1', '2', '3', '4'].includes(command)) continue;
      let index = rule.actions.length;
      if (command !== '1') { const selected = await choose('选择操作', rule.actions.map((action, index) => ({ action, index })), item => ruleLines({ ...rule, actions: [item.action] })[1]); if (!selected) continue; index = selected.index; }
      if (command === '3') { rule.actions.splice(index, 1); continue; }
      if (command === '4') { const raw = Number(await ask(`移动到第几步（1 至 ${rule.actions.length}）`)); if (Number.isInteger(raw) && raw >= 1 && raw <= rule.actions.length) { const [item] = rule.actions.splice(index, 1); rule.actions.splice(raw - 1, 0, item); } continue; }
      if (command === '1' && rule.actions.length >= 16) { say('每条规则最多 16 个操作'); continue; }
      const { device, operation, value } = await deviceOperation(rule.actions[index]);
      const action = operation.type === 'action.invoke' ? { device: device.device_id, invoke: { path: operation.path, input: value } } : { device: device.device_id, set: { path: operation.path, value } };
      if (command === '1') rule.actions.push(action); else rule.actions[index] = action;
    }
  }
  try {
    say('LimeIoT 本地任务');
    try { await session.dispatch({ action: 'refresh' }); } catch (error) { say(messages[error.safeCode] ?? error.safeCode); }
    for (;;) {
      say(`${session.origin}  空间 ${session.space}${session.connected ? '  已连接' : '  连接未确认'}`);
      const command = await ask('1 设备控制  2 自动化  3 执行记录  4 原任务恢复  5 刷新  0 退出');
      if (command === '0') break;
      try {
        if (['1', '2'].includes(command)) await session.dispatch({ action: 'refresh' });
        if (command === '1') { const { device, operation, value } = await deviceOperation(); await session.dispatch({ action: 'commands.prepare', device_id: device.device_id, type: operation.type, path: operation.path, value }); await confirm(); }
        if (command === '2') {
          const option = await ask('1 新建规则  2 编辑规则  3 停用规则  0 返回');
          if (option === '1') await ruleForm();
          else if (['2', '3'].includes(option)) { const deployment = await choose('选择规则', session.data.deployments, item => `${item.rule.id}（${item.rule.actions.length} 个操作）`); if (deployment) { if (option === '2') await ruleForm(deployment.rule); else { await session.dispatch({ action: 'rules.stop.prepare', rule_id: deployment.rule.id }); await confirm(); } } }
        }
        if (command === '3') {
          await session.dispatch({ action: 'refresh' });
          for (;;) { session.data.commands.forEach(item => say(`${item.command_id}  ${item.request.device_id} ${item.request.operation.path} ${status(item)}`)); if (!session.data.next_cursor || await ask('输入 1 查看下一页，回车返回') !== '1') break; await session.dispatch({ action: 'refresh', cursor: session.data.next_cursor }); }
          session.data.runs.forEach(run => { say(`运行 ${run.run_id}：${run.command_ids.length} 个关联操作${run.error === 'rule_conditions_not_met' ? '，条件未满足，本次未执行' : run.error ? '，' + run.error : ''}`); showEvaluation(run.condition_evaluation); });
        }
        if (command === '4') {
          const tasks = (await session.view()).tasks;
          const selected = await choose('选择原任务', tasks, task => `${task.task_id} ${task.kind} ${task.pending ? '待核实' : '已记录结果'}`);
          if (selected) { const result = await session.dispatch({ action: 'resolve', task_id: selected.task_id }); say('原任务记录'); if (result.unknown) say('原提交结果未知，以下为当前观测'); say(result.result?.outcome === 'command' ? status(result.result.command) : json(result.result ?? result.observation)); }
        }
        if (command === '5') { await session.dispatch({ action: 'refresh' }); say('已刷新'); }
      } catch (error) { if (error instanceof ClosedForm) continue; if (error instanceof Closed) throw error; say(messages[error.safeCode] ?? error.safeCode ?? '操作未完成'); }
    }
  } catch (error) { if (!(error instanceof Closed)) throw error; }
  finally { rl.close(); }
}

export async function runStdioTasks(session, input = process.stdin, output = process.stdout) {
  let pending = '', sequence = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const emit = async value => { if (!output.write(JSON.stringify(value) + '\n')) await once(output, 'drain'); };
  for await (const chunk of input) {
    try { pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }); }
    catch { throw taskError('invalid_task_encoding'); }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const raw = pending.slice(0, end); pending = pending.slice(end + 1);
      if (Buffer.byteLength(raw) > 32768) throw taskError('task_input_too_large');
      if (++sequence > 1024) throw taskError('task_input_limit');
      try {
        const action = parseBoundedJSON(raw, { maxBytes: 32768, maxDepth: 24, maxNodes: 10000 });
        const result = await session.dispatch(action);
        await emit({ version: 1, sequence, ok: true, result });
      } catch (error) { await emit({ version: 1, sequence, ok: false, error: { code: error.safeCode ?? 'invalid_task_action' } }); }
    }
    if (Buffer.byteLength(pending) > 32768) throw taskError('task_input_too_large');
  }
  try { pending += decoder.decode(); } catch { throw taskError('invalid_task_encoding'); }
  if (pending.trim()) throw taskError('task_input_line_required');
}

export async function runTui(args) {
  try {
    const { values: flags, positionals } = parseArgs({ args, allowPositionals: true, options: { 'space-id': { type: 'string' }, endpoint: { type: 'string' }, 'state-dir': { type: 'string' }, stdio: { type: 'boolean' }, snapshot: { type: 'boolean' } } });
    if (positionals.length) { if (positionals.length !== 1 || positionals[0] !== 'schema') throw taskError('invalid_tui_arguments'); process.stdout.write(await readFile(new URL('../../../contracts/tools/task-session.json', import.meta.url), 'utf8')); return; }
    if (flags.stdio && flags.snapshot) throw taskError('invalid_tui_arguments');
    if (process.env.LIMEIOT_TOKEN && process.env.LIMEIOT_TOKEN_FILE) throw taskError('ambiguous_token_configuration');
    const token = process.env.LIMEIOT_TOKEN ?? (process.env.LIMEIOT_TOKEN_FILE ? await readPrivateToken(process.env.LIMEIOT_TOKEN_FILE) : undefined);
    const session = new GatewayTaskSession({ endpoint: flags.endpoint ?? process.env.LIMEIOT_ENDPOINT ?? 'http://127.0.0.1:17880', token, space: flags['space-id'], directory: flags['state-dir'] ?? path.join(homedir(), '.local/state/limeiot/tasks'), catalog: JSON.parse(await readFile(new URL('../../../contracts/tools/catalog.json', import.meta.url), 'utf8')) });
    if (flags.snapshot) process.stdout.write(JSON.stringify(await session.dispatch({ action: 'refresh' })) + '\n');
    else if (flags.stdio) await runStdioTasks(session);
    else { if (!process.stdin.isTTY || !process.stdout.isTTY) throw taskError('terminal_required'); await runTextTasks(session); }
  } catch (error) { process.stderr.write(JSON.stringify({ error: { code: error.safeCode ?? 'local_file_unavailable' } }) + '\n'); process.exitCode = error.exit ?? 5; }
}
