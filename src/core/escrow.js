import { evaluatePolicy, DEFAULT_POLICY } from './policy.js';
import { Ledger } from './ledger.js';
import { sha256Hex, canon } from './hash.js';

export const STATES = ['DENIED', 'AWAITING_HUMAN', 'AWAITING_PAYER', 'HELD', 'DELIVERED', 'ESCALATED', 'RELEASED', 'VOIDED', 'REFUNDED'];
const TERMINAL = new Set(['DENIED', 'VOIDED', 'REFUNDED']);

/**
 * Escrow engine. Agent asks -> policy -> PayPal AUTHORIZE (money held, not moved)
 * -> seller delivers -> AI verifier -> capture (release) | void (refund) | escalate to human.
 */
export class Escrow {
  constructor({ paypal, brain, policy = {}, ledger = new Ledger(), clock = () => Date.now(), baseUrl = 'http://localhost:8787' }) {
    Object.assign(this, { paypal, brain, policy: { ...DEFAULT_POLICY, ...policy }, ledger, clock, baseUrl, holds: new Map(), seq: 0 });
  }
  now() { return new Date(this.clock()).toISOString(); }
  async log(hold, type, data = {}) { const e = await this.ledger.append({ at: this.now(), holdId: hold.id, type, state: hold.state, ...data }); hold.receipts.push(e.hash); return e; }
  get(id) { const h = this.holds.get(id); if (!h) throw Object.assign(new Error(`hold ${id} not found`), { status: 404 }); return h; }
  list() { return [...this.holds.values()]; }
  spentToday() {
    const day = this.now().slice(0, 10);
    return this.list().filter(h => h.createdAt.slice(0, 10) === day && ['AWAITING_PAYER', 'HELD', 'DELIVERED', 'ESCALATED', 'RELEASED'].includes(h.state)).reduce((s, h) => s + h.amount, 0);
  }
  expect(h, ...states) { if (!states.includes(h.state)) throw Object.assign(new Error(`hold ${h.id} is ${h.state}; expected ${states.join('|')}`), { status: 409 }); }

  /** Agent entry point. `request` is natural language or a structured intent. */
  async propose({ agentId = 'agent', request, intent, deliverWithinHours = 72 }) {
    const parsed = intent || await this.brain.parseIntent(request);
    const id = `H-${String(++this.seq).padStart(4, '0')}`;
    const h = { id, agentId, request: request || null, item: parsed.item, amount: Number(parsed.amount), currency: parsed.currency || 'USD', merchantId: parsed.merchantId, category: parsed.category,
      criteria: parsed.criteria || [], state: 'PROPOSED', createdAt: this.now(), deadline: new Date(this.clock() + deliverWithinHours * 36e5).toISOString(), receipts: [], paypal: {}, verdict: null, parser: this.brain.name };
    this.holds.set(id, h);
    const pol = evaluatePolicy(this.policy, h, this.spentToday() );
    h.policy = pol;
    if (pol.decision === 'deny') { h.state = 'DENIED'; await this.log(h, 'policy.denied', { reasons: pol.reasons, intent: parsed }); return h; }
    if (pol.decision === 'needs_human') { h.state = 'AWAITING_HUMAN'; await this.log(h, 'policy.needs_human', { reasons: pol.reasons, intent: parsed }); return h; }
    await this.log(h, 'policy.allowed', { intent: parsed });
    return this.#openOrder(h);
  }
  async approveByHuman(id, { approver = 'operator', approve = true } = {}) {
    const h = this.get(id); this.expect(h, 'AWAITING_HUMAN');
    if (!approve) { h.state = 'DENIED'; await this.log(h, 'human.rejected', { approver }); return h; }
    await this.log(h, 'human.approved', { approver });
    return this.#openOrder(h);
  }
  async #openOrder(h) {
    const o = await this.paypal.createAuthorizeOrder({ holdId: h.id, amount: h.amount, currency: h.currency, description: `${h.item} (escrow ${h.id})`, merchantId: h.merchantId,
      returnUrl: `${this.baseUrl}/paypal/return?hold=${h.id}`, cancelUrl: `${this.baseUrl}/paypal/cancel?hold=${h.id}` });
    h.paypal.orderId = o.id; h.paypal.approveUrl = o.approveUrl; h.state = 'AWAITING_PAYER';
    await this.log(h, 'paypal.order_created', { orderId: o.id, intent: 'AUTHORIZE', amount: h.amount.toFixed(2), currency: h.currency });
    return h;
  }
  /** Called after the payer approves on PayPal (return_url). Places the hold. */
  async authorize(id) {
    const h = this.get(id); this.expect(h, 'AWAITING_PAYER');
    const a = await this.paypal.authorizeOrder(h.paypal.orderId);
    Object.assign(h.paypal, { authorizationId: a.authorizationId, authExpiresAt: a.expiresAt }); h.state = 'HELD';
    await this.log(h, 'paypal.authorized', { authorizationId: a.authorizationId, status: a.status, expiresAt: a.expiresAt });
    return h;
  }
  async deliver(id, evidence) {
    const h = this.get(id); this.expect(h, 'HELD');
    const evidenceHash = await sha256Hex(canon(evidence));
    h.evidence = evidence; h.evidenceHash = evidenceHash; h.state = 'DELIVERED';
    await this.log(h, 'seller.delivered', { evidenceHash, artifacts: (evidence.artifacts || []).map(a => a.name) });
    const v = await this.brain.verify(h.criteria, evidence);
    h.verdict = v;
    await this.log(h, 'ai.verdict', { verdict: v.verdict, confidence: v.confidence, model: v.model, injection: v.injection.hits, results: v.results.map(r => ({ c: r.criterion, pass: r.pass })) });
    if (v.verdict === 'release') return this.#release(h, `AI verifier: all ${v.results.length} criteria met`);
    if (v.verdict === 'refund') return this.#void(h, 'AI verifier: no criteria met');
    h.state = 'ESCALATED'; await this.log(h, 'escalated', { why: v.injection.suspicious ? 'possible prompt injection in delivery' : 'partial match' });
    return h;
  }
  async resolve(id, { decision, approver = 'operator', note = '' }) {
    const h = this.get(id); this.expect(h, 'ESCALATED');
    await this.log(h, 'human.resolved', { decision, approver, note });
    return decision === 'release' ? this.#release(h, `human ${approver}: ${note}`) : this.#void(h, `human ${approver}: ${note}`);
  }
  async #release(h, why) {
    const c = await this.paypal.captureAuthorization(h.paypal.authorizationId, { amount: h.amount, currency: h.currency, invoiceId: h.id, note: why });
    h.paypal.captureId = c.captureId; h.state = 'RELEASED';
    await this.log(h, 'paypal.captured', { captureId: c.captureId, status: c.status, why });
    return h;
  }
  async #void(h, why) {
    await this.paypal.voidAuthorization(h.paypal.authorizationId); h.state = 'VOIDED';
    await this.log(h, 'paypal.voided', { authorizationId: h.paypal.authorizationId, why });
    return h;
  }
  async refund(id, { reason = 'buyer dispute' } = {}) {
    const h = this.get(id); this.expect(h, 'RELEASED');
    const r = await this.paypal.refundCapture(h.paypal.captureId, { note: reason }); h.paypal.refundId = r.refundId; h.state = 'REFUNDED';
    await this.log(h, 'paypal.refunded', { refundId: r.refundId, reason });
    return h;
  }
  /** Void every hold whose delivery deadline passed. Run on a timer. */
  async sweep() {
    const out = [];
    for (const h of this.list()) if (h.state === 'HELD' && this.clock() > Date.parse(h.deadline)) out.push(await this.#void(h, 'delivery deadline passed'));
    return out;
  }
  /** Portable proof-of-payment: the hold's receipts plus the chain needed to verify them. */
  async proof(id) {
    const h = this.get(id); const chain = this.ledger.entries; const check = await Ledger.verify(chain);
    return { holdId: h.id, state: h.state, amount: h.amount.toFixed(2), currency: h.currency, paypal: { ...h.paypal, approveUrl: undefined }, evidenceHash: h.evidenceHash || null,
      receipts: this.ledger.forHold(h.id), chainHead: check.head, chainValid: check.ok };
  }
  isTerminal(h) { return TERMINAL.has(h.state) || h.state === 'RELEASED'; }
}
