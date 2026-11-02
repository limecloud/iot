import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const origin = process.env.LIMEIOT_TEST_CONTROL_ORIGIN;
export const post = (value, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(value) });
export async function cloudClient() {
  const token = (await readFile(process.env.LIMEIOT_TEST_CONTROL_TOKEN_FILE, 'utf8')).trim();
  const login = await fetch(`${origin}/api/console/v1/auth/local`, { ...post({ token }), headers: { Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal(login.status, 200); const cookie = login.headers.getSetCookie()[0].split(';')[0]; await login.body.cancel();
  const auth = await (await fetch(`${origin}/api/console/v1/auth/session`, { headers: { Cookie: cookie } })).json();
  async function call(resource, value, expected = 200) {
    const response = await fetch(origin + resource, { ...(value === undefined ? {} : post(value)), headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': auth.csrf_token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12000) });
    const body = await response.json(); assert.equal(response.status, expected, body.error?.code); return body;
  }
  return {
    call,
    async pair() { const space = await call('/api/console/v1/spaces', { request_key: randomBytes(16).toString('hex'), name: '配对验证家庭' }); return call(`/api/console/v1/spaces/${space.space_id}/pairings`, { request_key: randomBytes(16).toString('hex'), scopes: ['commands.write', 'devices.read'] }); },
    bindings: space => call(`/api/console/v1/spaces/${space}/gateways`),
    revoke: binding => call(`/api/console/v1/spaces/${binding.space_id}/gateways/${binding.gateway_id}/revoke`, { revision: binding.revision }),
    connection: binding => call(`/api/console/v1/spaces/${binding.space_id}/gateways/${binding.gateway_id}/connection`),
  };
}
export async function fixture(mode) {
  const token = (await readFile(process.env.LIMEIOT_TEST_CONTROL_PROXY_SECRET_FILE, 'utf8')).trim();
  const response = await fetch(`${origin}/__fixture`, { ...(mode === undefined ? {} : post(mode)), headers: { 'X-LimeIoT-Test-Token': token, 'Content-Type': 'application/json' } }); assert.equal(response.status, 200); return response.json();
}
