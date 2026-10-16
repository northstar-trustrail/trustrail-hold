import test from 'node:test'; import assert from 'node:assert/strict';
import { service, held, who, ev, SPEC, realEmbedder } from './helpers.js';
import { verifyProof } from '../src/core/proof.js';
import { Ledger } from '../src/core/ledger.js';
const E = await realEmbedder(); const sem = { skip: E ? false : 'MiniLM unavailable offline' };

test('lifecycle: good brief -> capture -> refund; receipts + signed proof verify', sem, async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp);
  assert.equal(h.state, 'HELD'); assert.ok(Date.parse(h.paypal.honorEndsAt) < Date.parse(h.paypal.authExpiresAt));
  await svc.deliver(who('seller'), h.id, ev('A-good-1'));
  assert.equal(h.state, 'RELEASED', JSON.stringify(svc.ledger.forHold(h.id).slice(-2).map(e => e.why || e.decision))); assert.match(h.paypal.captureId, /^MOCK-C-/);
  await svc.refund(who('buyer'), h.id); assert.equal(h.state, 'REFUNDED');
  const p = await svc.proof(who('buyer'), h.id); assert.equal((await verifyProof(p)).ok, true, JSON.stringify(await verifyProof(p)));
  assert.deepEqual(p.receipts.map(r => r.type), ['criteria.frozen', 'policy.allowed', 'paypal.order_created', 'paypal.authorized', 'seller.delivered', 'ai.verdict', 'paypal.captured', 'paypal.refunded']);
});
test('failed delivery voids the authorization; malicious delivery escalates to reviewer', async () => {
  const { svc, pp } = await service();
  const a = await held(svc, pp); await svc.deliver(who('seller'), a.id, ev('A-adv-empty-sections'));
  assert.equal(a.state, 'VOIDED'); assert.equal(pp.auths.get(a.paypal.authorizationId).status, 'VOIDED');
  const b = await held(svc, pp); await svc.deliver(who('seller'), b.id, ev('A-adv-injection'));
  assert.equal(b.state, 'ESCALATED');
  await svc.resolve(who('reviewer'), b.id, { decision: 'void', note: 'injection' }); assert.equal(b.state, 'VOIDED');
});
test('permission separation: each role can only do its own step', async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp);
  await assert.rejects(svc.propose(who('seller'), { intent: SPEC }), /seller may not hold.propose/);
  await assert.rejects(svc.deliver(who('agent'), h.id, ev('A-good-1')), /buyer_agent may not hold.deliver/);
  await assert.rejects(svc.refund(who('agent'), h.id), /may not hold.refund/);
  await assert.rejects(svc.resolve(who('seller'), h.id, { decision: 'capture' }), /may not hold.resolve/);
  await assert.rejects(svc.propose(who('reviewer'), { intent: SPEC }), /may not/);
  await assert.rejects(svc.sweep(who('buyer')), /may not hold.sweep/);
  assert.equal(h.state, 'HELD', 'nothing changed');
});
test('cross-user: other seller cannot deliver, other org cannot read', async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp);
  await assert.rejects(svc.deliver(who('seller-2'), h.id, ev('A-good-1')), /not assigned/);
  const outsider = { id: 'mallory', role: 'buyer', org: 'other-co' };
  assert.throws(() => svc.get(outsider, h.id), /forbidden/); assert.equal(svc.list(outsider).length, 0);
  await assert.rejects(svc.refund(outsider, h.id), /not the buyer/);
  assert.equal(svc.list(who('seller-2')).length, 0); assert.equal(svc.list(who('seller')).length, 1);
});
test('duplicate settlement is impossible (sequential and concurrent)', async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp);
  await svc.deliver(who('seller'), h.id, ev('A-adv-injection'));
  const [r1, r2] = await Promise.allSettled([svc.resolve(who('reviewer'), h.id, { decision: 'capture' }), svc.resolve(who('reviewer'), h.id, { decision: 'void' })]);
  assert.equal([r1, r2].filter(r => r.status === 'fulfilled').length, 1, 'exactly one settlement wins');
  await assert.rejects(svc.settlement.settle(h, 'capture', { reason: 'again' }), /already settled/);
  assert.equal(svc.ledger.forHold(h.id).filter(e => /paypal\.(captured|voided)/.test(e.type)).length, 1);
});
test('changed evidence: second delivery rejected; verdict not bound to stored evidence cannot settle', async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp);
  await svc.deliver(who('seller'), h.id, ev('A-adv-injection'));
  await assert.rejects(svc.deliver(who('seller'), h.id, ev('A-good-1')), /is ESCALATED/);
  assert.throws(() => { h.evidence.body = 'swapped'; }, TypeError);
  h.evidenceHash = 'f'.repeat(64); // simulate evidence swapped in storage after the verdict
  await assert.rejects(svc.resolve(who('reviewer'), h.id, { decision: 'capture' }), /not bound/);
});
test('policy: cap, human-approval threshold, invalid intent', async () => {
  const { svc } = await service();
  assert.equal((await svc.propose(who('agent'), { intent: { ...SPEC, amount: 900 } })).state, 'DENIED');
  const big = await svc.propose(who('agent'), { intent: { ...SPEC, amount: 150 } }); assert.equal(big.state, 'AWAITING_HUMAN');
  await assert.rejects(svc.approvePolicy(who('agent'), big.id), /may not/);
  assert.equal((await svc.approvePolicy(who('buyer'), big.id)).state, 'AWAITING_PAYER');
  const bad = await svc.propose(who('agent'), { intent: { ...SPEC, payTo: 'attacker' } }); assert.equal(bad.state, 'DENIED'); assert.match(bad.policy.reasons.join(), /unknown fields/);
});
test('deadline sweep voids stale holds (inside the 3-day honor period)', async () => {
  let t = Date.parse('2026-11-01T12:00:00Z'); const { svc, pp } = await service({ clock: () => t });
  const h = await held(svc, pp); t += 49 * 36e5; await svc.sweep({ id: 's', role: 'system' }); assert.equal(h.state, 'VOIDED');
});
test('signed checkpoints: tampering with a receipt or signature is detected', async () => {
  const { svc, pp } = await service(); const h = await held(svc, pp); await svc.deliver(who('seller'), h.id, ev('A-adv-empty-sections'));
  const p = await svc.proof(who('auditor'), h.id); assert.equal((await verifyProof(p)).ok, true);
  const t1 = structuredClone(p); t1.receipts[0].amount = '1.00'; assert.equal((await verifyProof(t1)).ok, false);
  const t2 = structuredClone(p); t2.checkpoint.head = t2.chain[0].hash; assert.equal((await verifyProof(t2)).ok, false);
  const other = await (await import('../src/core/checkpoint.js')).Signer.create();
  assert.equal((await verifyProof(p, other.pubJwk)).ok, false, 'wrong key rejected');
  assert.equal((await Ledger.verify(svc.ledger.entries)).ok, true);
});
