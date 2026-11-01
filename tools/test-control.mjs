import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as httpServer, request as upstreamRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

// 只创建自己的无宿主卷 MySQL；不读取或连接用户已有实例。
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'limeiot-control-test-'));
const name = `limeiot-control-test-${randomBytes(8).toString('hex')}`;
const password = randomBytes(32).toString('hex');
let started = false;
let api;
let proxy;
const relay = process.argv.includes('--gateway-relay');
const pairing = relay || process.argv.includes('--gateway-pairing');
const relaySockets = new Set();
let relayCA;
if (process.argv.slice(2).some(value => !['--gateway-pairing', '--gateway-relay'].includes(value))) throw new Error('unsupported_test_option');
async function startProxy(backend) {
  const token = randomBytes(32).toString('hex');
  await writeFile(join(scratch, 'proxy-token'), token, { mode: 0o600 });
  const state = { reviews: 0, claims: 0, statuses: 0, relay_connections: 0, drop_claims: false, hold_claims: false, reject_relays: false };
  const held = [];
  const handle = async (request, response) => {
    if (request.url === '/__fixture') {
      if (request.headers['x-limeiot-test-token'] !== token) { response.writeHead(403).end(); return; }
      if (request.method === 'POST') {
        let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1024) { response.writeHead(400).end(); return; } }
        try {
          const value = JSON.parse(raw); state.drop_claims = value.drop_claims === true; state.hold_claims = value.hold_claims === true; state.reject_relays = value.reject_relays === true;
          if (value.close_relays === true) for (const socket of relaySockets) socket.destroy();
        } catch { response.writeHead(400).end(); return; }
        if (!state.hold_claims) held.splice(0).forEach(release => release());
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(state)); return;
    }
    const category = request.url?.match(/^\/api\/pairing\/v1\/[^/]+\/(review|claim|status)$/)?.[1];
    if (category) state[{ review: 'reviews', claim: 'claims', status: 'statuses' }[category]]++;
    const upstream = upstreamRequest(new URL(request.url, backend), { method: request.method, headers: request.headers }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        if (category === 'claim' && state.drop_claims) { response.destroy(); return; }
        const release = () => { if (!response.destroyed) { response.writeHead(incoming.statusCode, incoming.headers); response.end(Buffer.concat(chunks)); } };
        if (category === 'claim' && state.hold_claims) held.push(release); else release();
      });
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end(); });
    request.pipe(upstream);
  };
  if (relay) {
    relayCA = join(scratch, 'relay-ca.crt');
    const caKey = join(scratch, 'relay-ca.key'), certificate = join(scratch, 'relay-server.crt'), request = join(scratch, 'relay.csr'), extension = join(scratch, 'relay.ext');
    const keyFile = join(scratch, 'relay.key');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=LimeIoT Relay Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', relayCA]);
    await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=LimeIoT Relay Test', '-keyout', keyFile, '-out', request]);
    await writeFile(extension, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
    await run('openssl', ['x509', '-req', '-in', request, '-CA', relayCA, '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-extfile', extension, '-out', certificate]);
    const cert = await readFile(relayCA);
    setDefaultCACertificates([...getCACertificates('default'), cert.toString()]);
    proxy = httpsServer({ key: await readFile(keyFile), cert: await readFile(certificate) }, handle);
    proxy.on('upgrade', (request, socket, head) => {
      relaySockets.add(socket); socket.once('close', () => relaySockets.delete(socket)); socket.on('error', () => {});
      if (request.url !== '/api/gateway/v1/connect' || state.reject_relays) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      state.relay_connections++;
      const upstream = upstreamRequest(new URL(request.url, backend), { method: 'GET', headers: request.headers });
      upstream.on('upgrade', (incoming, upstreamSocket, upstreamHead) => {
        relaySockets.add(upstreamSocket); upstreamSocket.once('close', () => relaySockets.delete(upstreamSocket)); upstreamSocket.on('error', () => socket.destroy()); socket.once('close', () => upstreamSocket.destroy()); upstreamSocket.once('close', () => socket.destroy());
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}\r\n`)).join('')}\r\n`);
        if (head.length) upstreamSocket.write(head); if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
      });
      upstream.on('response', incoming => { incoming.resume(); socket.end(`HTTP/1.1 ${incoming.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
      upstream.on('error', () => socket.destroy()); upstream.end();
    });
  } else proxy = httpServer(handle);
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  return `${relay ? 'https' : 'http'}://127.0.0.1:${proxy.address().port}`;
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let output = '';
    child.stdout?.on('data', value => { output += value; });
    child.stderr?.on('data', value => { output += value; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code})${options.stdio ? '' : `: ${output}`}`)));
  });
}
async function stopAPI() {
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const child = api;
  let timer;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) await exited;
  api = undefined;
}
async function processSmoke(env) {
  const consoleToken = randomBytes(32).toString('hex');
  for (const [name, value] of Object.entries({ key: randomBytes(32).toString('hex'), console: consoleToken, admin: randomBytes(32).toString('hex') })) {
    await writeFile(join(scratch, name), value, { mode: 0o600 });
  }
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = pairing ? await startProxy(`http://127.0.0.1:${port}`) : `http://127.0.0.1:${port}`;
  const apiEnv = { ...env, LIMEIOT_CONTROL_MODE: 'private', LIMEIOT_CONTROL_LISTEN: `127.0.0.1:${port}`, LIMEIOT_CONTROL_ORIGIN: origin, LIMEIOT_CONSOLE_ORIGIN: origin, LIMEIOT_ADMIN_ORIGIN: origin, LIMEIOT_CONTROL_KEY_FILE: join(scratch, 'key'), LIMEIOT_CONSOLE_TOKEN_FILE: join(scratch, 'console'), LIMEIOT_ADMIN_TOKEN_FILE: join(scratch, 'admin'), LIMEIOT_CONTROL_EDGE_TOKEN_FILE: '', LIMEIOT_CONSOLE_OIDC_ISSUER: '', LIMEIOT_ADMIN_OIDC_ISSUER: '', LIMEIOT_CONSOLE_OIDC_SECRET_FILE: '', LIMEIOT_ADMIN_OIDC_SECRET_FILE: '', LIMEIOT_CONSOLE_OIDC_CLIENT_ID: '', LIMEIOT_ADMIN_OIDC_CLIENT_ID: '' };
  const binary = join(scratch, 'api');
  await run('go', ['build', '-trimpath', '-o', binary, './cmd/api'], { cwd: resolve(root, 'server'), env, stdio: 'inherit' });
  await run('go', ['run', './cmd/migrate'], { cwd: resolve(root, 'server'), env, stdio: 'inherit' });
  async function startAPI() {
    api = spawn(binary, [], { env: apiEnv, stdio: 'ignore' });
    let startError;
    api.once('error', error => { startError = error; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (startError || api.exitCode !== null || api.signalCode !== null) throw new Error('control API exited before readiness');
      const ready = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      if (ready) { await ready.body?.cancel(); if (ready.status === 200) return; }
      await delay(100);
    }
    throw new Error('control API readiness timed out');
  }
  async function request(path, options = {}, status = 200) {
    const response = await fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
    if (response.status !== status) { await response.body?.cancel(); throw new Error(`control process request failed (${response.status})`); }
    return response;
  }
  await startAPI();
  const loggedIn = await request('/api/console/v1/auth/local', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: consoleToken }) });
  const cookie = loggedIn.headers.getSetCookie()[0]?.split(';')[0];
  await loggedIn.body?.cancel();
  if (!cookie) throw new Error('control process did not create a session');
  const session = await (await request('/api/console/v1/auth/session', { headers: { Cookie: cookie } })).json();
  const space = await (await request('/api/console/v1/spaces', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ request_key: 'process-smoke', name: '进程恢复家庭' }) })).json();
  await stopAPI();
  await startAPI();
  const restored = await (await request('/api/console/v1/auth/session', { headers: { Cookie: cookie } })).json();
  const spaces = await (await request('/api/console/v1/spaces', { headers: { Cookie: cookie } })).json();
  if (restored.principal?.principal_id !== session.principal?.principal_id || !spaces.spaces?.some(item => item.space_id === space.space_id)) throw new Error('control process lost durable session or space');
  if (pairing) await run(process.execPath, ['--test', '--test-concurrency=1', 'tests/pairing.test.mjs', ...(relay ? ['tests/relay.test.mjs'] : [])], { env: { ...env, ...(relayCA ? { NODE_EXTRA_CA_CERTS: relayCA, LIMEIOT_TEST_CONTROL_CA_FILE: relayCA } : {}), LIMEIOT_TEST_CONTROL_ORIGIN: origin, LIMEIOT_TEST_CONTROL_TOKEN_FILE: join(scratch, 'console'), LIMEIOT_TEST_CONTROL_PROXY_SECRET_FILE: join(scratch, 'proxy-token') }, stdio: 'inherit' });
  await stopAPI();
  console.log('真实控制面进程：显式迁移、登录、建空间、进程重启及原会话恢复通过。');
}
const report = { passed: false, isolated_mysql: true, hardware: false };
try {
  await writeFile(join(scratch, 'mysql.env'), `MYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}\nMYSQL_DATABASE=limeiot_test\nMYSQL_USER=limeiot_test\nMYSQL_PASSWORD=${password}\n`, { mode: 0o600 });
  await run('docker', ['run', '--detach', '--rm', '--pull=never', '--name', name, '--publish', '127.0.0.1::3306', '--env-file', join(scratch, 'mysql.env'), 'mysql:8.4']);
  started = true;
  const mapping = await run('docker', ['port', name, '3306/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('unexpected test port');
  const dsnPath = join(scratch, 'mysql.dsn');
  await writeFile(dsnPath, `limeiot_test:${password}@tcp(${mapping})/limeiot_test?parseTime=true&charset=utf8mb4`, { mode: 0o600 });
  const env = { ...process.env, GOTOOLCHAIN: 'go1.26.10', LIMEIOT_CONTROL_MYSQL_DSN_FILE: dsnPath, LIMEIOT_CONTROL_TEST_ISOLATED: '1', GIN_MODE: 'release' };
  console.log('验证 Go 控制面：临时 MySQL 8.4、HTTP 与 OIDC 提供方夹具。');
  await run('go', ['test', '-race', '-count=1', './...'], { cwd: resolve(root, 'server'), env, stdio: 'inherit' });
  await run('go', ['vet', './...'], { cwd: resolve(root, 'server'), env, stdio: 'inherit' });
  await processSmoke(env);
  report.process_restart = true;
  if (pairing) report.gateway_pairing = true;
  if (relay) report.gateway_wss = true;
  report.passed = true;
} finally {
  await stopAPI();
  if (proxy) { for (const socket of relaySockets) socket.destroy(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (started) await run('docker', ['stop', '--time', '5', name]);
  await rm(scratch, { recursive: true, force: true });
  const reportDir = resolve(root, relay ? '.dev/relay-test' : pairing ? '.dev/pairing-test' : '.dev/control-test');
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
