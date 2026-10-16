import test from 'node:test'; import assert from 'node:assert/strict';
import { RestPayPal } from '../src/paypal/rest.js'; import { OpenAICompatJudge } from '../src/ai/judge.js';
// Contract tests: assert the exact PayPal REST calls the adapter makes, with a recorded-shape fake server.
function fakeFetch(log) {
  return async (url, init) => {
    log.push({ url, method: init.method, headers: init.headers, body: init.body });
    const p = new URL(url).pathname; const j = (o, s = 200) => ({ ok: s < 300, status: s, json: async () => o, text: async () => (o == null ? '' : JSON.stringify(o)) });
    if (p === '/v1/oauth2/token') return j({ access_token: 'A21AA-test', expires_in: 32400 });
    if (p === '/v2/checkout/orders') return j({ id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T' }] }, 201);
    if (p.endsWith('/authorize')) return j({ id: '5O190127TN364715T', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [{ id: '0AW2184448108334S', status: 'CREATED', expiration_time: '2026-12-01T00:00:00Z' }] } }] }, 201);
    if (p.endsWith('/capture')) return j({ id: '7TK53561YB803214S', status: 'COMPLETED' }, 201);
    if (p.endsWith('/void')) return j(null, 204);
    if (p.endsWith('/refund')) return j({ id: '1JU08902781691411', status: 'COMPLETED' }, 201);
    return j({ name: 'RESOURCE_NOT_FOUND', message: 'nope', debug_id: 'abc' }, 404);
  };
}
test('RestPayPal speaks Orders v2 / Payments v2', async () => {
  const log = []; const pp = new RestPayPal({ clientId: 'id', clientSecret: 'sec', fetchImpl: fakeFetch(log) });
  const o = await pp.createAuthorizeOrder({ holdId: 'H-0001', amount: 40, description: 'report', returnUrl: 'http://x/r', cancelUrl: 'http://x/c' });
  assert.equal(o.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T');
  const body = JSON.parse(log[1].body); assert.equal(body.intent, 'AUTHORIZE'); assert.equal(body.purchase_units[0].payee, undefined, 'single merchant uses credential owner'); assert.equal(body.purchase_units[0].amount.value, '40.00');
  assert.match(log[1].headers['PayPal-Request-Id'], /^create-H-0001-/); assert.ok(body.payment_source.paypal.experience_context.return_url);
  assert.equal(log[0].headers.Authorization, 'Basic ' + btoa('id:sec'));
  const a = await pp.authorizeOrder(o.id); assert.equal(a.authorizationId, '0AW2184448108334S');
  assert.equal((await pp.captureAuthorization(a.authorizationId, { amount: 40 })).captureId, '7TK53561YB803214S');
  assert.equal((await pp.voidAuthorization('X')).status, 'VOIDED');
  assert.equal((await pp.refundCapture('7TK53561YB803214S')).status, 'COMPLETED');
  assert.equal(log.filter(l => l.url.endsWith('/v1/oauth2/token')).length, 1, 'token cached');
  await assert.rejects(pp.getOrder('missing'), /404 RESOURCE_NOT_FOUND/);
});
test('sandbox test card path is refused against the live API', async () => {
  const pp = new RestPayPal({ clientId: 'id', clientSecret: 's', base: 'https://api-m.paypal.com', fetchImpl: fakeFetch([]) });
  await assert.rejects(pp.createAuthorizeOrder({ holdId: 'H', amount: 1, sandboxCard: { number: '4', expiry: '2030-12', cvv: '1' } }), /only allowed against the sandbox/);
});
test('OpenAICompatJudge: sends untrusted-fenced prompt, parses schema', async () => {
  let sent; const fetchImpl = async (u, i) => { sent = JSON.parse(i.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"pass","refs":["S1.P1"],"rationale":"states fines"}' } }] }) }; };
  const j = new OpenAICompatJudge({ baseUrl: 'http://llm/v1', model: 'm', fetchImpl });
  const r = await j.judge({ criterion: { params: { question: 'What are the fines?' } }, passages: [{ ref: 'S1.P1', text: 'up to 7%' }] });
  assert.equal(r.verdict, 'pass'); assert.match(sent.messages[1].content, /untrusted="true"/); assert.equal(sent.temperature, 0);
});


test('webhook signature verification uses PayPal verification endpoint and exact headers', async () => {
  let sent;
  const pp = new RestPayPal({ clientId: 'id', clientSecret: 'test', fetchImpl: async (url, init) => {
    if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'test', expires_in: 3600 }) };
    sent = { url, ...JSON.parse(init.body) }; return { ok: true, text: async () => '{"verification_status":"SUCCESS"}' };
  } });
  const headers = Object.fromEntries(['auth-algo', 'cert-url', 'transmission-id', 'transmission-sig', 'transmission-time'].map(k => [`paypal-${k}`, k]));
  assert.equal(await pp.verifyWebhook({}, {}, 'id'), false);
  assert.equal(await pp.verifyWebhook(headers, { id: 'WH-1' }, 'configured-id'), true);
  assert.ok(sent.url.endsWith('/v1/notifications/verify-webhook-signature'));
  assert.equal(sent.webhook_id, 'configured-id'); assert.equal(sent.transmission_sig, 'transmission-sig');
  assert.deepEqual(sent.webhook_event, { id: 'WH-1' });
});
