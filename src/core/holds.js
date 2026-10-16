import { evaluatePolicy, DEFAULT_POLICY } from './policy.js';
import { Ledger } from './ledger.js';
import { sha256Hex, canon } from './hash.js';
import { freezeCriteria, validateEvidence } from './schema.js';
import { parseIntent } from '../ai/intent.js';
import { verifyDelivery } from '../ai/verifier.js';
import { assertCan, canRead } from './authz.js';
import { Settlement } from './settlement.js';
import { Checkpointer, Signer } from './checkpoint.js';

// PayPal authorizations are valid 29 days; the first 3 days are the "honor period" in which
// capture is guaranteed to succeed. Delivery deadlines are capped to fit inside it.
export const AUTH_VALID_DAYS = 29, HONOR_DAYS = 3;
const ACTIVE = ['AWAITING_PAYER', 'HELD', 'ESCALATED', 'RELEASED'];

/**
 * Authorization-hold service for agent research-brief purchases.
 * Not custodial escrow: the buyer's funds stay in the buyer's PayPal account under an authorization.
 * The merchant (this service's PayPal app) decides capture or void based on the frozen criteria.
 */
export class HoldService {
  static async create(opts) { const s = new HoldService(opts); s.checkpoints = new Checkpointer({ signer: opts.signer || await Signer.create(), every: opts.checkpointEvery ?? 5, sink: opts.checkpointSink }); return s; }
  constructor({ paypal, embedder, judge = null, intentLlm = null, policy = {}, sandboxCard = null, clock = () => Date.now(), baseUrl = 'http://localhost:8787' }) {
    Object.assign(this, { sandboxCard, settlement: new Settlement(paypal), embedder, judge, intentLlm, policy: { ...DEFAULT_POLICY, ...policy }, ledger: new Ledger(), clock, baseUrl, holds: new Map(), seq: 0 });
  }
  get paypalMode() { return this.settlement.mode; }
  now() { return new Date(this.clock()).toISOString(); }
  async log(h, type, data = {}) { const e = await this.ledger.append({ at: this.now(), holdId: h.id, type, state: h.state, ...data }); h.receipts.push(e.hash); await this.checkpoints.maybe(this.ledger, /captured|voided|refunded/.test(type)); return e; }
  #get(id) { const h = this.holds.get(id); if (!h) throw Object.assign(new Error(`hold ${id} not found`), { status: 404 }); return h; }
  get(actor, id) { const h = this.#get(id); if (!canRead(actor, h)) throw Object.assign(new Error('forbidden'), { status: 403 }); return h; }
  list(actor) { return [...this.holds.values()].filter(h => canRead(actor, h)); }
  expect(h, ...st) { if (!st.includes(h.state)) throw Object.assign(new Error(`hold ${h.id} is ${h.state}; expected ${st.join('|')}`), { status: 409 }); }
  spentToday(buyerId) { const d = this.now().slice(0, 10); return [...this.holds.values()].filter(h => h.buyerId === buyerId && h.createdAt.slice(0, 10) === d && (ACTIVE.includes(h.state) || h.state === 'AWAITING_HUMAN')).reduce((s, h) => s + h.amount, 0); }

  async propose(actor, { request, intent }) {
    assertCan(actor, 'hold.propose');
    const parsed = await parseIntent(intent ?? request, { llm: this.intentLlm });
    const id = `H-${String(++this.seq).padStart(4, '0')}`;
    const base = { id, buyerId: actor.org, agentId: actor.id, request: typeof request === 'string' ? request : null, createdAt: this.now(), receipts: [], paypal: {}, verdict: null, parser: parsed.parser };
    if (!parsed.ok) { const h = { ...base, state: 'DENIED', amount: 0, currency: 'USD', topic: '(invalid intent)', sellerId: null, policy: { decision: 'deny', reasons: parsed.errors } }; this.holds.set(id, h); await this.log(h, 'intent.rejected', { errors: parsed.errors }); return h; }
    const it = parsed.value; const { criteria, criteriaHash } = await freezeCriteria(it);
    const h = { ...base, intent: Object.freeze(it), topic: it.topic, amount: it.amount, currency: it.currency, sellerId: it.sellerId, criteria, criteriaHash, state: 'PROPOSED',
      deadline: new Date(this.clock() + it.deliverWithinHours * 36e5).toISOString() };
    this.holds.set(id, h);
    h.policy = evaluatePolicy(this.policy, { amount: it.amount, currency: it.currency, merchantId: it.sellerId, category: 'research_brief', criteria }, this.spentToday(actor.org) - 0);
    await this.log(h, 'criteria.frozen', { criteriaHash, criteria: criteria.map(c => c.id) });
    if (h.policy.decision === 'deny') { h.state = 'DENIED'; await this.log(h, 'policy.denied', { reasons: h.policy.reasons }); return h; }
    if (h.policy.decision === 'needs_human') { h.state = 'AWAITING_HUMAN'; await this.log(h, 'policy.needs_human', { reasons: h.policy.reasons }); return h; }
    await this.log(h, 'policy.allowed');
    return this.#openOrder(h);
  }
  async approvePolicy(actor, id, { approve = true } = {}) {
    const h = this.#get(id); assertCan(actor, 'hold.approve_policy', h); this.expect(h, 'AWAITING_HUMAN');
    if (!approve) { h.state = 'DENIED'; await this.log(h, 'human.rejected', { by: actor.id }); return h; }
    await this.log(h, 'human.approved', { by: actor.id }); return this.#openOrder(h);
  }
  async #openOrder(h) {
    const o = await this.settlement.createOrder({ holdId: h.id, amount: h.amount, currency: h.currency, description: `Research brief: ${h.topic} (hold ${h.id})`, merchantId: h.sellerId,
      returnUrl: `${this.baseUrl}/paypal/return?hold=${h.id}`, cancelUrl: `${this.baseUrl}/paypal/cancel?hold=${h.id}`, sandboxCard: this.sandboxCard });
    Object.assign(h.paypal, { orderId: o.id, approveUrl: o.approveUrl }); h.state = 'AWAITING_PAYER';
    await this.log(h, 'paypal.order_created', { orderId: o.id, intent: 'AUTHORIZE', status: o.status, amount: h.amount.toFixed(2), criteriaHash: h.criteriaHash });
    if (o.authorization) await this.#placed(h, o.authorization); // sandbox test card: authorized at creation, no buyer redirect
    return h;
  }
  async #placed(h, a) {
    Object.assign(h.paypal, { authorizationId: a.authorizationId, authStatus: a.status, authExpiresAt: a.expiresAt || new Date(this.clock() + AUTH_VALID_DAYS * 864e5).toISOString(), honorEndsAt: new Date(this.clock() + HONOR_DAYS * 864e5).toISOString() });
    h.state = 'HELD'; await this.log(h, 'paypal.authorized', { authorizationId: a.authorizationId, status: a.status, expiresAt: h.paypal.authExpiresAt }); return h;
  }
  /** After the buyer approves on PayPal. Places the authorization hold. */
  async authorize(actor, id) {
    const h = this.#get(id); assertCan(actor, 'hold.authorize', h); this.expect(h, 'AWAITING_PAYER');
    return this.#placed(h, await this.settlement.authorize(h.paypal.orderId));
  }
  async deliver(actor, id, evidence) {
    const h = this.#get(id); assertCan(actor, 'hold.deliver', h); this.expect(h, 'HELD');
    const ev = validateEvidence(evidence); if (!ev.ok) throw Object.assign(new Error(ev.errors.join('; ')), { status: 400 });
    h.evidence = Object.freeze(ev.value); h.evidenceHash = await sha256Hex(canon(ev.value)); h.state = 'VERIFYING';
    await this.log(h, 'seller.delivered', { evidenceHash: h.evidenceHash, by: actor.id });
    let v;
    try { v = await verifyDelivery({ criteria: h.criteria, criteriaHash: h.criteriaHash, evidence: h.evidence, embedder: this.embedder, judge: this.judge }); }
    catch (e) { h.state = 'ESCALATED'; h.escalatedAt = this.now(); await this.log(h, 'escalated', { why: `verifier error: ${e.message}` }); return h; }
    h.verdict = v;
    await this.log(h, 'ai.verdict', { decision: v.decision, models: v.models, criteriaHash: v.criteriaHash, evidenceHash: v.evidenceHash, results: v.results.map(r => ({ id: r.id, verdict: r.verdict, refs: r.evidenceRefs.map(x => x.ref) })) });
    if (v.decision === 'capture' || v.decision === 'void') {
      try { return await this.#settle(h, v.decision, v.decisionReason); }
      catch (e) { h.state = 'ESCALATED'; h.escalatedAt = this.now(); await this.log(h, 'escalated', { why: `settlement failed: ${e.message}` }); return h; }
    }
    h.state = 'ESCALATED'; h.escalatedAt = this.now(); await this.log(h, 'escalated', { why: v.decisionReason }); return h;
  }
  async resolve(actor, id, { decision, note = '' }) {
    const h = this.#get(id); assertCan(actor, 'hold.resolve', h); this.expect(h, 'ESCALATED');
    if (!['capture', 'void'].includes(decision)) throw Object.assign(new Error('decision must be capture|void'), { status: 400 });
    await this.log(h, 'reviewer.resolved', { decision, by: actor.id, note }); return this.#settle(h, decision, `reviewer ${actor.id}: ${note}`);
  }
  async #settle(h, action, why) {
    const r = await this.settlement.settle(h, action, { reason: why });
    if (action === 'capture') { h.paypal.captureId = r.captureId; h.state = 'RELEASED'; await this.log(h, 'paypal.captured', { captureId: r.captureId, status: r.status, why }); }
    else { h.state = 'VOIDED'; await this.log(h, 'paypal.voided', { authorizationId: h.paypal.authorizationId, why }); }
    return h;
  }
  async refund(actor, id, { reason = 'buyer dispute' } = {}) {
    const h = this.#get(id); assertCan(actor, 'hold.refund', h); this.expect(h, 'RELEASED');
    const r = await this.settlement.refund(h, { reason }); h.paypal.refundId = r.refundId; h.state = 'REFUNDED';
    await this.log(h, 'paypal.refunded', { refundId: r.refundId, reason }); return h;
  }
  async sweep(actor) {
    assertCan(actor, 'hold.sweep'); const out = [];
    for (const h of this.holds.values()) if (h.state === 'HELD' && this.clock() > Date.parse(h.deadline)) out.push(await this.#settle(h, 'void', 'delivery deadline passed'));
    return out;
  }
  async proof(actor, id) {
    const h = this.get(actor, id); const check = await Ledger.verify(this.ledger.entries); const cp = await this.checkpoints.maybe(this.ledger, true) || this.checkpoints.list.at(-1);
    return { holdId: h.id, state: h.state, amount: h.amount.toFixed(2), currency: h.currency, criteriaHash: h.criteriaHash || null, evidenceHash: h.evidenceHash || null,
      paypal: { orderId: h.paypal.orderId, authorizationId: h.paypal.authorizationId, captureId: h.paypal.captureId, refundId: h.paypal.refundId, mode: this.paypalMode },
      verdict: h.verdict && { decision: h.verdict.decision, results: h.verdict.results }, receipts: this.ledger.forHold(h.id), chain: this.ledger.entries.map(e => ({ seq: e.seq, prev: e.prev, hash: e.hash })), chainValid: check.ok, checkpoint: cp, publicKey: this.checkpoints.signer.pubJwk };
  }
}
