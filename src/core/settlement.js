// Single-merchant model: the configured PayPal app's merchant receives all payments.
// sellerId identifies the deliverer, not a PayPal payee. This is not a marketplace.
export class Settlement {
  constructor(paypal, persist = () => {}) {
    Object.assign(this, { paypal, persist, operations: new Map(), done: new Map(), mode: paypal.mode });
  }
  async run(h, kind, send) {
    const key = `${h.id}:${kind}`;
    if (this.operations.has(key)) throw Object.assign(new Error(`hold ${h.id} already settled or operation pending (${kind})`), { status: 409 });
    const op = { holdId: h.id, kind, requestId: `${kind}-${h.id}-${crypto.randomUUID()}`, state: 'UNKNOWN' };
    this.operations.set(key, op);
    this.persist(); // Write intent and guard BEFORE sending any money-changing request.
    try {
      const result = await send(op.requestId);
      Object.assign(op, { result, state: result.status === 'PENDING' ? 'PENDING' : 'OBSERVED' });
      this.persist();
      return result;
    } catch (e) {
      // An error cannot prove that money did not move. Keep the guard and use GETs.
      op.error = e.message; this.persist(); throw e;
    }
  }
  async settle(h, action, { reason }) {
    if (this.done.has(h.id)) throw Object.assign(new Error(`hold ${h.id} already settled`), { status: 409 });
    if (!h.paypal.authorizationId) throw Object.assign(new Error('no authorization to settle'), { status: 409 });
    if (h.verdict && (h.verdict.criteriaHash !== h.criteriaHash || h.verdict.evidenceHash !== h.evidenceHash)) throw Object.assign(new Error('verdict is not bound to this hold\'s frozen criteria/evidence'), { status: 409 });
    this.done.set(h.id, { action, pending: true });
    return this.run(h, action, requestId => action === 'capture'
      ? this.paypal.captureAuthorization(h.paypal.authorizationId, { amount: h.amount, currency: h.currency, invoiceId: `${h.id}-${h.paypal.orderId}`, note: reason, requestId })
      : this.paypal.voidAuthorization(h.paypal.authorizationId, { requestId }));
  }
  refund(h, { reason }) {
    if (!h.paypal.captureId) throw Object.assign(new Error('nothing captured'), { status: 409 });
    return this.run(h, 'refund', requestId => this.paypal.refundCapture(h.paypal.captureId, { note: reason, requestId }));
  }
  createOrder(h, args) { return this.run(h, 'create', requestId => this.paypal.createAuthorizeOrder({ ...args, requestId })); }
  authorize(h) { return this.run(h, 'authorize', requestId => this.paypal.authorizeOrder(h.paypal.orderId, { requestId })); }
  async lookup(h, op) {
    const p = this.paypal;
    if (op.kind === 'create') {
      if (!op.result?.id) return null; // Unknown order ID needs operator reconciliation.
      const o = await p.getOrder(op.result.id);
      const a = o.purchase_units?.flatMap(u => u.payments?.authorizations || [])[0];
      return { ...op.result, status: o.status, authorization: a ? { authorizationId: a.id, status: a.status, expiresAt: a.expiration_time } : null };
    }
    if (op.kind === 'authorize') {
      const a = h.paypal.authorizationId ? await p.getAuthorization(h.paypal.authorizationId) : (await p.getOrder(h.paypal.orderId)).purchase_units?.flatMap(u => u.payments?.authorizations || [])[0];
      return a && { authorizationId: a.id, status: a.status, expiresAt: a.expiration_time };
    }
    if (op.kind === 'void') {
      const a = await p.getAuthorization(h.paypal.authorizationId);
      return a.status === 'VOIDED' ? { status: 'VOIDED' } : null;
    }
    if (op.kind === 'capture') {
      let id = op.result?.captureId;
      if (!id) {
        const o = await p.getOrder(h.paypal.orderId);
        const captures = o.purchase_units?.flatMap(u => u.payments?.captures || []) || [];
        id = captures.find(c => c.invoice_id === `${h.id}-${h.paypal.orderId}`)?.id;
      }
      if (!id) return null;
      const c = await p.getCapture(id);
      if (c.amount && (c.amount.currency_code !== h.currency || Number(c.amount.value) !== h.amount)) throw new Error('capture amount mismatch');
      return { captureId: c.id, status: c.status };
    }
    if (op.kind === 'refund') {
      // GET capture does not list refund IDs. A lost response needs a verified
      // refund webhook to discover the ID; do not infer completion from capture.
      if (!op.result?.refundId) { await p.getCapture(h.paypal.captureId); return null; }
      const r = await p.getRefund(op.result.refundId);
      if (r.amount && (r.amount.currency_code !== h.currency || Number(r.amount.value) !== h.amount)) throw new Error('refund amount mismatch');
      return { refundId: r.id, status: r.status };
    }
  }
}
