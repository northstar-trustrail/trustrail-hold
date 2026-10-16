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
// capture has its highest likelihood of success, but is not guaranteed. Delivery deadlines are capped to fit inside it.
export const AUTH_VALID_DAYS = 29, HONOR_DAYS = 3;

/**
 * Authorization-hold service for agent research-brief purchases.
 * Not custodial escrow: the buyer's funds stay in the buyer's PayPal account under an authorization.
 * The merchant (this service's PayPal app) decides capture or void based on the frozen criteria.
 */
export class HoldService {
  static async create(opts) {
    const s = new HoldService(opts);
    const saved = opts.store?.load();
    s.checkpoints = new Checkpointer({ signer: opts.signer || await Signer.create(saved?.signingKey), every: opts.checkpointEvery ?? 5, sink: opts.checkpointSink });
    if (saved) {
      if (saved.paypalMode !== s.paypalMode) throw new Error('store PayPal mode mismatch');
      if (saved.signingKey && (saved.signingKey.x !== s.checkpoints.signer.pubJwk.x || saved.signingKey.y !== s.checkpoints.signer.pubJwk.y)) throw new Error('store signing key mismatch');
      s.holds = new Map(saved.holds); s.seq = saved.seq;
      s.reservations = new Map(saved.reservations); s.webhookIds = new Set(saved.webhookIds);
      s.settlement.operations = new Map(saved.operations); s.settlement.done = new Map(saved.guards);
      s.ledger.entries = saved.ledger; s.checkpoints.list = saved.checkpoints;
      if (!(await Ledger.verify(s.ledger.entries)).ok) throw new Error('stored ledger is corrupt');
      if (saved.mock && s.paypalMode === 'mock') for (const [k, v] of Object.entries(saved.mock)) s.settlement.paypal[k] = new Map(v);
      for (const h of s.holds.values()) {
        if (h.evidence) Object.freeze(h.evidence);
        if (h.state === 'VERIFYING') { h.state = 'ESCALATED'; await s.log(h, 'recovery.interrupted_verification'); }
      }
    }
    await s.reconcile(); s.persist(); return s;
  }
  constructor({ paypal, embedder, judge = null, intentLlm = null, policy = {}, sandboxCard = null, clock = () => Date.now(), baseUrl = 'http://localhost:8787', store = null, sourceChecker = null }) {
    Object.assign(this, { sandboxCard, store, sourceChecker, embedder, judge, intentLlm, policy: { ...DEFAULT_POLICY, ...policy }, ledger: new Ledger(), clock, baseUrl, holds: new Map(), reservations: new Map(), webhookIds: new Set(), seq: 0 });
    this.settlement = new Settlement(paypal, () => this.persist());
    // Serialize mutations, including policy reservations and asynchronous ledger appends.
    let tail = Promise.resolve();
    for (const name of ['propose', 'approvePolicy', 'authorize', 'deliver', 'resolve', 'refund', 'sweep', 'reconcile', 'webhook', 'proof']) {
      const fn = this[name].bind(this);
      this[name] = (...args) => { const next = tail.then(() => fn(...args)); tail = next.catch(() => {}); return next; };
    }
  }
  persist() {
    if (!this.store || !this.checkpoints) return;
    const pp = this.settlement.paypal;
    this.store.save({ paypalMode: this.paypalMode, holds: [...this.holds], seq: this.seq, reservations: [...this.reservations], webhookIds: [...this.webhookIds],
      operations: [...this.settlement.operations], guards: [...this.settlement.done], ledger: this.ledger.entries, checkpoints: this.checkpoints.list,
      signingKey: this.checkpoints.signer.privateJwk,
      mock: this.paypalMode === 'mock' ? Object.fromEntries(['orders', 'auths', 'captures', 'refunds'].map(k => [k, [...(pp[k] || [])]])) : undefined });
  }
  get paypalMode() { return this.settlement.mode; }
  now() { return new Date(this.clock()).toISOString(); }
  async log(h, type, data = {}) { const e = await this.ledger.append({ at: this.now(), holdId: h.id, type, state: h.state, ...data }); h.receipts.push(e.hash); await this.checkpoints.maybe(this.ledger, /captured|voided|refunded/.test(type)); this.persist(); return e; }
  #get(id) { const h = this.holds.get(id); if (!h) throw Object.assign(new Error(`hold ${id} not found`), { status: 404 }); return h; }
  get(actor, id) { const h = this.#get(id); if (!canRead(actor, h)) throw Object.assign(new Error('forbidden'), { status: 403 }); return h; }
  list(actor) { return [...this.holds.values()].filter(h => canRead(actor, h)); }
  expect(h, ...st) { if (!st.includes(h.state)) throw Object.assign(new Error(`hold ${h.id} is ${h.state}; expected ${st.join('|')}`), { status: 409 }); }
  spentToday(buyerId) { const d = this.now().slice(0, 10); return [...this.reservations.values()].filter(r => r.buyerId === buyerId && r.day === d).reduce((sum, r) => sum + r.amount, 0); }

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
    if (h.policy.decision !== 'deny') this.reservations.set(h.id, { buyerId: h.buyerId, day: h.createdAt.slice(0, 10), amount: h.amount });
    await this.log(h, 'criteria.frozen', { criteriaHash, criteria: criteria.map(c => c.id) });
    if (h.policy.decision === 'deny') { h.state = 'DENIED'; await this.log(h, 'policy.denied', { reasons: h.policy.reasons }); return h; }
    if (h.policy.decision === 'needs_human') { h.state = 'AWAITING_HUMAN'; await this.log(h, 'policy.needs_human', { reasons: h.policy.reasons }); return h; }
    await this.log(h, 'policy.allowed');
    return this.#openOrder(h);
  }
  async approvePolicy(actor, id, { approve = true } = {}) {
    const h = this.#get(id); assertCan(actor, 'hold.approve_policy', h); this.expect(h, 'AWAITING_HUMAN');
    if (!approve) { h.state = 'DENIED'; this.reservations.delete(h.id); await this.log(h, 'human.rejected', { by: actor.id }); return h; }
    await this.log(h, 'human.approved', { by: actor.id }); return this.#openOrder(h);
  }
  async #openOrder(h) {
    const o = await this.settlement.createOrder(h, { holdId: h.id, amount: h.amount, currency: h.currency, description: `Research brief: ${h.topic} (hold ${h.id})`, merchantId: h.sellerId,
      returnUrl: `${this.baseUrl}/paypal/return?hold=${h.id}`, cancelUrl: `${this.baseUrl}/paypal/cancel?hold=${h.id}`, sandboxCard: this.sandboxCard });
    Object.assign(h.paypal, { orderId: o.id, approveUrl: o.approveUrl }); h.state = 'AWAITING_PAYER';
    await this.log(h, 'paypal.order_created', { orderId: o.id, intent: 'AUTHORIZE', status: o.status, amount: h.amount.toFixed(2), criteriaHash: h.criteriaHash });
    if (o.authorization) await this.#placed(h, o.authorization); // sandbox test card: authorized at creation, no buyer redirect
    return h;
  }
  async #placed(h, a) {
    // Conservative fallback clocks start at proposal; recovery never extends them.
    Object.assign(h.paypal, { authorizationId: a.authorizationId, authStatus: a.status, authExpiresAt: a.expiresAt || h.paypal.authExpiresAt || new Date(Date.parse(h.createdAt) + AUTH_VALID_DAYS * 864e5).toISOString(), honorEndsAt: h.paypal.honorEndsAt || new Date(Date.parse(h.createdAt) + HONOR_DAYS * 864e5).toISOString() });
    if (a.status !== 'CREATED') { h.state = 'RECONCILIATION_REQUIRED'; await this.log(h, 'paypal.authorization_unconfirmed', { status: a.status }); return h; }
    h.state = 'HELD'; await this.log(h, 'paypal.authorized', { authorizationId: a.authorizationId, status: a.status, expiresAt: h.paypal.authExpiresAt }); return h;
  }
  /** After the buyer approves on PayPal. Places the authorization hold. */
  async authorize(actor, id) {
    const h = this.#get(id); assertCan(actor, 'hold.authorize', h); this.expect(h, 'AWAITING_PAYER');
    return this.#placed(h, await this.settlement.authorize(h));
  }
  async deliver(actor, id, evidence) {
    const h = this.#get(id); assertCan(actor, 'hold.deliver', h); this.expect(h, 'HELD');
    const ev = validateEvidence(evidence); if (!ev.ok) throw Object.assign(new Error(ev.errors.join('; ')), { status: 400 });
    h.evidence = Object.freeze(ev.value); h.evidenceHash = await sha256Hex(canon(ev.value)); h.state = 'VERIFYING';
    await this.log(h, 'seller.delivered', { evidenceHash: h.evidenceHash, by: actor.id });
    let v;
    try { v = await verifyDelivery({ criteria: h.criteria, criteriaHash: h.criteriaHash, evidence: h.evidence, embedder: this.embedder, judge: this.judge, sourceChecker: this.sourceChecker }); }
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
    await this.applyPayment(h, action, r, why); return h;
  }
  async applyPayment(h, kind, r, why = 'PayPal reconciliation') {
    if (kind === 'capture') {
      h.paypal.captureId = r.captureId; h.paypal.captureStatus = r.status;
      h.state = r.status === 'COMPLETED' && r.captureId ? 'RELEASED' : r.status === 'PENDING' ? 'CAPTURE_PENDING' : 'RECONCILIATION_REQUIRED';
    } else if (kind === 'refund') {
      h.paypal.refundId = r.refundId; h.paypal.refundStatus = r.status;
      h.state = r.status === 'COMPLETED' && r.refundId ? 'REFUNDED' : r.status === 'PENDING' ? 'REFUND_PENDING' : 'RECONCILIATION_REQUIRED';
    } else h.state = r.status === 'VOIDED' ? 'VOIDED' : 'RECONCILIATION_REQUIRED';
    if (['VOIDED', 'REFUNDED'].includes(h.state)) this.reservations.delete(h.id);
    const complete = ['RELEASED', 'REFUNDED', 'VOIDED'].includes(h.state);
    const op = this.settlement.operations.get(`${h.id}:${kind}`);
    if (op) { op.result = r; op.state = complete ? 'APPLIED' : r.status === 'PENDING' ? 'PENDING' : 'UNKNOWN'; }
    const type = complete ? { capture: 'captured', refund: 'refunded', void: 'voided' }[kind] : `${kind}_${r.status === 'PENDING' ? 'pending' : 'unconfirmed'}`;
    await this.log(h, `paypal.${type}`, { ...r, why });
  }
  async refund(actor, id, { reason = 'buyer dispute' } = {}) {
    const h = this.#get(id); assertCan(actor, 'hold.refund', h); this.expect(h, 'RELEASED');
    try { const r = await this.settlement.refund(h, { reason }); await this.applyPayment(h, 'refund', r, reason); }
    catch (e) { h.state = 'RECONCILIATION_REQUIRED'; await this.log(h, 'paypal.refund_unconfirmed', { why: e.message }); throw e; }
    return h;
  }
  async reconcile() { return this.reconcileNow(); }
  async reconcileNow() {
    for (const op of this.settlement.operations.values()) {
      if (op.state === 'APPLIED') continue;
      const h = this.holds.get(op.holdId); if (!h) continue;
      // Successful create/authorize responses have already been applied during normal flow.
      if (op.kind === 'create' && h.paypal.orderId && (!op.result?.authorization || h.paypal.authStatus === 'CREATED')) { op.state = 'APPLIED'; continue; }
      if (op.kind === 'authorize' && h.paypal.authorizationId && h.paypal.authStatus === 'CREATED') { op.state = 'APPLIED'; continue; }
      try {
        const r = await this.settlement.lookup(h, op);
        if (!r) { h.state = 'RECONCILIATION_REQUIRED'; continue; }
        if (op.kind === 'create') { h.paypal.orderId = r.id; h.paypal.approveUrl = r.approveUrl; h.state = 'AWAITING_PAYER'; if (r.authorization) await this.#placed(h, r.authorization); op.state = r.authorization && r.authorization.status !== 'CREATED' ? 'PENDING' : 'APPLIED'; }
        else if (op.kind === 'authorize') { await this.#placed(h, r); op.state = r.status === 'CREATED' ? 'APPLIED' : 'UNKNOWN'; }
        else await this.applyPayment(h, op.kind, r);
      } catch (e) { op.error = e.message; /* Keep pending state and reservation while PayPal is unavailable. */ }
    }
    this.persist();
  }
  async webhook(headers, event, webhookId) {
    const p = this.settlement.paypal;
    if (!webhookId || !p.verifyWebhook || !await p.verifyWebhook(headers, event, webhookId)) throw Object.assign(new Error('invalid PayPal webhook signature'), { status: 401 });
    if (!event.id || !event.resource?.id) throw Object.assign(new Error('invalid webhook event'), { status: 400 });
    if (this.webhookIds.has(event.id)) return { duplicate: true };
    const r = event.resource, related = r.supplementary_data?.related_ids || {};
    const kind = event.event_type?.startsWith('PAYMENT.CAPTURE.') ? (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? 'refund' : 'capture')
      : event.event_type?.startsWith('PAYMENT.REFUND.') ? 'refund' : null;
    // Use only locally known operations. Verified events discover IDs, but GET is the authority.
    if (kind) for (const h of this.holds.values()) {
      const op = this.settlement.operations.get(`${h.id}:${kind}`);
      const up = r.links?.find(l => l.rel === 'up')?.href?.split('/').pop();
      const matches = kind === 'capture'
        ? h.paypal.captureId === r.id || related.order_id === h.paypal.orderId || r.invoice_id === `${h.id}-${h.paypal.orderId}`
        : h.paypal.refundId === r.id || related.capture_id === h.paypal.captureId || up === h.paypal.captureId;
      if (!op || op.state === 'APPLIED' || !matches) continue;
      op.result = { ...(op.result || {}), [kind === 'capture' ? 'captureId' : 'refundId']: r.id };
      this.persist();
    }
    await this.reconcileNow();
    this.webhookIds.add(event.id); this.persist(); return { received: true };
  }
  async sweep(actor) {
    assertCan(actor, 'hold.sweep'); const out = [];
    for (const h of this.holds.values()) if (h.state === 'HELD' && this.clock() > Date.parse(h.deadline)) out.push(await this.#settle(h, 'void', 'delivery deadline passed'));
    return out;
  }
  async proof(actor, id) {
    const h = this.get(actor, id); const check = await Ledger.verify(this.ledger.entries); const cp = await this.checkpoints.maybe(this.ledger, true) || this.checkpoints.list.at(-1);
    this.persist();
    return { holdId: h.id, state: h.state, amount: h.amount.toFixed(2), currency: h.currency, criteriaHash: h.criteriaHash || null, evidenceHash: h.evidenceHash || null,
      paypal: { orderId: h.paypal.orderId, authorizationId: h.paypal.authorizationId, captureId: h.paypal.captureId, refundId: h.paypal.refundId, mode: this.paypalMode },
      verdict: h.verdict && { decision: h.verdict.decision, results: h.verdict.results }, receipts: this.ledger.forHold(h.id), chain: this.ledger.entries.map(e => ({ seq: e.seq, prev: e.prev, hash: e.hash })), chainValid: check.ok, checkpoint: cp, publicKey: this.checkpoints.signer.pubJwk };
  }
}
