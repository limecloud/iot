// 仅验证提供方 HTTP 合同和故障边界，不作为模型推理或质量证据。
import http from 'node:http';
export async function ollamaFixture() {
  const requests = [], paths = [], pending = []; let mode = 'valid';
  const server = http.createServer(async (request, response) => {
    paths.push(request.url);
    if (request.url !== '/api/chat' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const current = mode;
    if (current === 'hold') await new Promise(resolve => pending.push(resolve));
    if (current === 'disconnect') { response.destroy(); return; }
    if (current === 'redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return; }
    if (current === 'oversize') { response.writeHead(200); response.end('x'.repeat(70000)); return; }
    const rule = { version: 1, trigger: { device: 'device-button', event: 'button.pressed' }, conditions: [], actions: [{ device: 'device-lamp', set: { path: 'light.brightness', value: 37 } }], cooldown_ms: 0 };
    if (current === 'foreign') rule.actions[0].device = 'other-space-device';
    if (current === 'tool') rule.actions[0].set.path = 'shell.execute';
    const content = JSON.stringify(current === 'unsupported' ? { supported: false, rule: null } : { supported: true, rule });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'fixture-local', done: true, done_reason: current === 'truncated' ? 'length' : 'stop', message: { role: 'assistant', content }, prompt_eval_count: 300, eval_count: 80 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, paths, origin: `http://127.0.0.1:${server.address().port}`, set mode(value) { mode = value; }, release() { pending.splice(0).forEach(resolve => resolve()); }, async close() { pending.splice(0).forEach(resolve => resolve()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
