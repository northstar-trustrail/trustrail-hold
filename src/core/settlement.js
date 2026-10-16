// The ONLY component holding PayPal credentials. Executes capture/void exactly once per hold,
// and only for a verdict bound to the hold's frozen criteria hash and stored evidence hash.
export class Settlement {
  constructor(paypal) { this.paypal = paypal; this.done = new Map(); this.mode = paypal.mode; }
  async settle(hold, action, { reason }) {
    if (this.done.has(hold.id)) { const e = new Error(`hold ${hold.id} already settled (${this.done.get(hold.id).action})`); e.status = 409; throw e; }
    if (!hold.paypal.authorizationId) { const e = new Error('no authorization to settle'); e.status = 409; throw e; }
    if (hold.verdict && (hold.verdict.criteriaHash !== hold.criteriaHash || hold.verdict.evidenceHash !== hold.evidenceHash)) { const e = new Error('verdict is not bound to this hold\'s frozen criteria/evidence'); e.status = 409; throw e; }
    this.done.set(hold.id, { action, pending: true });
    try {
      const r = action === 'capture'
        ? await this.paypal.captureAuthorization(hold.paypal.authorizationId, { amount: hold.amount, currency: hold.currency, invoiceId: `${hold.id}-${hold.paypal.orderId}`, note: reason })
        : await this.paypal.voidAuthorization(hold.paypal.authorizationId);
      this.done.set(hold.id, { action, ...r }); return r;
    } catch (e) { this.done.delete(hold.id); throw e; }
  }
  async refund(hold, { reason }) {
    if (!hold.paypal.captureId) { const e = new Error('nothing captured'); e.status = 409; throw e; }
    return this.paypal.refundCapture(hold.paypal.captureId, { note: reason });
  }
  createOrder(a) { return this.paypal.createAuthorizeOrder(a); }
  authorize(orderId) { return this.paypal.authorizeOrder(orderId); }
}
