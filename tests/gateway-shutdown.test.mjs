import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { until } from '../tools/dev-stack.mjs';
import { base, post, environmentStack, thresholdRule } from './fixtures/zigbee/runtime.mjs';

async function eventStream(origin, headers) {
  const abort = new AbortController();
  const response = await fetch(origin + base + '/events/stream', { headers, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  const ended = (async () => {
    try {
      while (!(await reader.read()).done) {}
      return true;
    } catch { return false; }
    finally { reader.releaseLock(); }
  })();
  return { ended, async close() { abort.abort(); await ended; } };
}

async function signalExit(child, signal) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const expired = setTimeout(() => reject(new Error('gateway_shutdown_exceeded_4000ms')), 4000);
    child.once('exit', (code, exitSignal) => {
      clearTimeout(expired);
      resolve({ code, signal: exitSignal, elapsed_ms: Date.now() - started });
    });
    child.kill(signal);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal}保持SSE连接与在途ZNP读取时有界退出，恢复串口且重启不重放`, { timeout: 45000 }, async t => {
    const streams = [];
    let stalled;
    // 故障回归失败时也先释放本测试的客户端，让旧网关有机会退出和恢复TTY。
    t.after(async () => { stalled?.destroy(); await Promise.all(streams.map(stream => stream.close())); });
    const { directory, stack, sensor, commands, control, stats } = await environmentStack(t, 1, { timeoutMs: 30000 });
    assert.equal((await stack.request(base + '/rule-deployments', post(thresholdRule()))).status, 200);
    const initial = await sensor();
    await until(async () => (await sensor()).state_revision > initial.state_revision);
    await control(2900);
    const original = await until(async () => {
      const items = await commands();
      return items.length === 1 && items[0].status === 'confirmed' && items[0];
    });
    const origin = stack.env.LIMEIOT_ENDPOINT;
    const login = await fetch(origin + '/api/v1/auth/session', {
      ...post({ token: stack.env.LIMEIOT_TOKEN }), headers: { 'Content-Type': 'application/json', Origin: origin },
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.json();
    streams.push(await eventStream(origin, { Cookie: cookie }));
    streams.push(await eventStream(origin, { Authorization: 'Bearer ' + stack.env.LIMEIOT_TOKEN }));
    if (signal === 'SIGTERM') {
      const url = new URL(origin);
      stalled = net.createConnection({ host: url.hostname, port: Number(url.port) });
      await new Promise((resolve, reject) => { stalled.once('connect', resolve); stalled.once('error', reject); });
      stalled.on('error', () => {});
      stalled.resume();
      stalled.write(`POST ${base}/commands HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${stack.env.LIMEIOT_TOKEN}\r\nIdempotency-Key: shutdown-incomplete\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{"device_id":`);
    }
    // 30秒读取已真实到达软件NCP，证明退出依赖取消，而不是等读取自然超时。
    await control(2900, 'timeout');
    await until(async () => (await stats()).timeout_requests > 0);
    const result = await signalExit(stack.gateway, signal);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.ok(result.elapsed_ms < 4000);
    assert.equal((await stats()).termios_restored, true, '当前进程已释放在途读取并恢复TTY后才可重启');
    assert.deepEqual(await Promise.all(streams.map(stream => stream.ended)), [true, true], 'SSE正常结束，不能以客户端中断冒充服务端关停');
    if (stalled) await until(() => stalled.destroyed);
    const logs = (await readFile(path.join(stack.directory, 'gateway.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(logs.some(value => value.event === 'gateway.stopping' && value.signal === signal));
    const shutdown = logs.find(value => value.event === 'gateway.stopped');
    assert.equal(shutdown.http_drained, signal !== 'SIGTERM');
    assert.equal(logs.some(value => value.event === 'gateway.http_drain_timeout'), signal === 'SIGTERM');
    await control(2900);
    await stack.restartGateway();
    await until(async () => (await sensor()).ready && (await stack.request(base + '/devices/device-lamp')).value.ready);
    const after = await commands();
    assert.deepEqual(after.map(command => command.command_id), [original.command_id]);
    assert.equal(after[0].status, 'confirmed');
    assert.equal((await stack.request(base + '/runs')).value.items.length, 1);
    assert.equal((await stack.request(base + '/commands/by-key/shutdown-incomplete')).status, 404);
    const oldSession = await fetch(origin + base + '/devices', { headers: { Cookie: cookie } });
    assert.equal(oldSession.status, 401);
    const report = { passed: true, signal, exit: result, sse_clients: 2, browser_session_and_bearer: true,
      server_ended_streams: true, serial_restored_before_restart: true, http_drained: shutdown.http_drained,
      pending_znp_timeout_ms: 30000, stalled_http_body: signal === 'SIGTERM',
      incomplete_request_not_committed: true, gateway_restart_no_replay: true,
      previous_browser_session_rejected: true, hardware: false, published: false, full_goal_completed: false };
    await writeFile(path.join(directory, 'shutdown-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: path.join(directory, 'shutdown-report.json') }));
  });
}
