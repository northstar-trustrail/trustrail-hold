import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HoldService } from '../src/core/holds.js';
import { FileStore } from '../src/core/store.js';
import { MockPayPal } from '../src/paypal/mock.js';
import { LexicalEmbedder } from '../src/ai/embed.js';
import { held, who, ev, SPEC } from './helpers.js';
import { verifyProof } from '../src/core/proof.js';

async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustrail-'));
  let store = new FileStore(path.join(dir, 'state.json'));
  const pp = new MockPayPal();
  const create = () => HoldService.create({ paypal: pp, embedder: new LexicalEmbedder(), store, ...options });
  const svc = await create();
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  return { svc, pp, file: store.file, restart: async () => { store.close(); store = new FileStore(store.file); return create(); } };
}
async function review(svc, pp) {
  const h = await held(svc, pp);
  await svc.deliver(who('seller'), h.id, ev('A-adv-injection'));
  assert.equal(h.state, 'ESCALATED'); return h;
}

test('capture and refund PENDING stay reserved until GET confirms COMPLETED', async t => {
  const { svc, pp, restart } = await setup(t);
  const h = await review(svc, pp);
  const capture = pp.captureAuthorization.bind(pp);
  pp.captureAuthorization = async (...args) => { const r = await capture(...args); pp.captures.get(r.captureId).status = 'PENDING'; return { ...r, status: 'PENDING' }; };
  await svc.resolve(who('reviewer'), h.id, { decision: 'capture' });
  assert.equal(h.state, 'CAPTURE_PENDING'); assert.ok(svc.reservations.has(h.id));
  assert.equal(svc.ledger.forHold(h.id).some(e => e.type === 'paypal.captured'), false);
  const recovered = await restart(); const rh = recovered.get(who('buyer'), h.id);
  assert.equal(rh.state, 'CAPTURE_PENDING');
  pp.captures.get(rh.paypal.captureId).status = 'COMPLETED'; await recovered.reconcile();
  assert.equal(rh.state, 'RELEASED');
  const refund = pp.refundCapture.bind(pp);
  pp.refundCapture = async (...args) => { const r = await refund(...args); pp.refunds.get(r.refundId).status = 'PENDING'; return { ...r, status: 'PENDING' }; };
  await recovered.refund(who('buyer'), h.id); assert.equal(rh.state, 'REFUND_PENDING');
  assert.ok(recovered.reservations.has(h.id));
  pp.refunds.get(rh.paypal.refundId).status = 'COMPLETED'; await recovered.reconcile();
  assert.equal(rh.state, 'REFUNDED'); assert.equal(recovered.reservations.has(h.id), false);
});

test('restart recovers lost capture response by GET without a second POST', async t => {
  const { svc, pp, restart, file } = await setup(t);
  const h = await review(svc, pp); const send = pp.captureAuthorization.bind(pp); let posts = 0;
  pp.captureAuthorization = async (...args) => {
    const disk = JSON.parse(fs.readFileSync(file));
    assert.ok(disk.operations.find(([k]) => k === `${h.id}:capture`));
    assert.ok(disk.guards.find(([id]) => id === h.id));
    posts++; await send(...args); throw new Error('socket closed after PayPal committed');
  };
  await assert.rejects(svc.resolve(who('reviewer'), h.id, { decision: 'capture' }), /socket closed/);
  const recovered = await restart(); const rh = recovered.get(who('buyer'), h.id);
  assert.equal(rh.state, 'RELEASED'); assert.equal(posts, 1);
  assert.equal(recovered.spentToday(h.buyerId), h.amount);
  await assert.rejects(recovered.resolve(who('reviewer'), h.id, { decision: 'void' }), /expected ESCALATED/);
  assert.equal((await verifyProof(await recovered.proof(who('buyer'), h.id))).ok, true);
});

test('failed GET keeps guard and budget after restart; later reconciliation recovers', async t => {
  const { svc, pp, restart } = await setup(t); const h = await review(svc, pp);
  const send = pp.captureAuthorization.bind(pp); pp.captureAuthorization = async (...a) => { await send(...a); throw new Error('lost'); };
  await assert.rejects(svc.resolve(who('reviewer'), h.id, { decision: 'capture' }));
  const get = pp.getOrder.bind(pp); pp.getOrder = async () => { throw new Error('offline'); };
  const recovered = await restart(); assert.ok(recovered.reservations.has(h.id));
  await assert.rejects(recovered.resolve(who('reviewer'), h.id, { decision: 'void' }), /already settled/);
  pp.getOrder = get; await recovered.reconcile(); assert.equal(recovered.holds.get(h.id).state, 'RELEASED');
});

test('webhooks reject invalid signatures, discover lost refund IDs, GET status, and deduplicate', async t => {
  const { svc, pp, restart } = await setup(t); const h = await review(svc, pp);
  await svc.resolve(who('reviewer'), h.id, { decision: 'capture' });
  const refund = pp.refundCapture.bind(pp); let rid;
  pp.refundCapture = async (...a) => { const r = await refund(...a); rid = r.refundId; throw new Error('lost refund response'); };
  await assert.rejects(svc.refund(who('buyer'), h.id));
  const recovered = await restart(); assert.equal(recovered.holds.get(h.id).state, 'RECONCILIATION_REQUIRED');
  const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: rid, status: 'PENDING', supplementary_data: { related_ids: { capture_id: h.paypal.captureId } } } };
  pp.verifyWebhook = async () => false;
  await assert.rejects(recovered.webhook({}, event, 'webhook-id'), /invalid PayPal/);
  pp.verifyWebhook = async () => true;
  await recovered.webhook({}, event, 'webhook-id');
  assert.equal(recovered.holds.get(h.id).state, 'REFUNDED', 'GET status wins over event payload');
  assert.deepEqual(await recovered.webhook({}, event, 'webhook-id'), { duplicate: true });
  assert.deepEqual(await (await restart()).webhook({}, event, 'webhook-id'), { duplicate: true });
});

test('concurrent proposals cannot oversubscribe durable daily reservations', async t => {
  const { svc, restart } = await setup(t, { policy: { dailyLimit: 50 } });
  const holds = await Promise.all(Array.from({ length: 3 }, () => svc.propose(who('agent'), { intent: { ...SPEC, amount: 30 } })));
  assert.equal(holds.filter(h => h.state === 'AWAITING_PAYER').length, 1);
  assert.equal((await restart()).spentToday(who('agent').org), 30);
});

test('file store excludes a second writer and rejects malformed snapshots', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustrail-lock-')); const file = path.join(dir, 's.json');
  const store = new FileStore(file); t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  assert.throws(() => new FileStore(file), /already in use/);
  fs.writeFileSync(file, '{broken'); assert.throws(() => store.load(), SyntaxError);
});


test('non-completed capture and refund statuses never produce paid receipts', async t => {
  const { svc, pp } = await setup(t); const h = await review(svc, pp);
  pp.captureAuthorization = async () => ({ captureId: 'denied', status: 'DECLINED' });
  await svc.resolve(who('reviewer'), h.id, { decision: 'capture' });
  assert.equal(h.state, 'RECONCILIATION_REQUIRED'); assert.ok(svc.reservations.has(h.id));
  assert.equal(svc.ledger.forHold(h.id).some(e => e.type === 'paypal.captured'), false);
  const h2 = await review(svc, pp);
  pp.captureAuthorization = MockPayPal.prototype.captureAuthorization.bind(pp);
  await svc.resolve(who('reviewer'), h2.id, { decision: 'capture' });
  pp.refundCapture = async () => ({ refundId: 'failed', status: 'FAILED' });
  await svc.refund(who('buyer'), h2.id);
  assert.equal(h2.state, 'RECONCILIATION_REQUIRED');
  assert.equal(svc.ledger.forHold(h2.id).some(e => e.type === 'paypal.refunded'), false);
});

test('restart recovers lost authorization and void responses using GET', async t => {
  const { svc, pp, restart } = await setup(t);
  const h = await svc.propose(who('agent'), { intent: SPEC }); pp.approve(h.paypal.orderId);
  const auth = pp.authorizeOrder.bind(pp); pp.authorizeOrder = async (...a) => { await auth(...a); throw new Error('lost'); };
  await assert.rejects(svc.authorize(who('buyer'), h.id));
  const recovered = await restart(); assert.equal(recovered.holds.get(h.id).state, 'HELD');
  await recovered.deliver(who('seller'), h.id, ev('A-adv-injection'));
  const voidAuth = pp.voidAuthorization.bind(pp); pp.voidAuthorization = async (...a) => { await voidAuth(...a); throw new Error('lost'); };
  await assert.rejects(recovered.resolve(who('reviewer'), h.id, { decision: 'void' }));
  const again = await restart(); assert.equal(again.holds.get(h.id).state, 'VOIDED');
  assert.equal(again.reservations.has(h.id), false);
});
