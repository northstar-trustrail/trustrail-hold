import { parseAuthorizeResponse, approveLink } from './interface.js';
// In-memory PayPal sandbox twin. Enforces the same state rules PayPal does
// (must approve before authorize; cannot capture a voided auth; one final capture).
let n = 0; const id = p => `${p}${Date.now().toString(36).toUpperCase()}${(++n).toString(36).toUpperCase().padStart(4, '0')}`;
export class MockPayPal {
  constructor() { this.orders = new Map(); this.auths = new Map(); this.captures = new Map(); this.refunds = new Map(); this.mode = 'mock'; }
  async createAuthorizeOrder({ holdId, amount, currency = 'USD', description, merchantId }) {
    const oid = id('MOCK-O-');
    const o = { id: oid, intent: 'AUTHORIZE', status: 'PAYER_ACTION_REQUIRED', purchase_units: [{ reference_id: holdId, description, amount: { currency_code: currency, value: Number(amount).toFixed(2) } }],
      links: [{ rel: 'payer-action', href: `#approve/${oid}`, method: 'GET' }] };
    this.orders.set(oid, o);
    return { id: oid, status: o.status, approveUrl: approveLink(o), merchantId };
  }
  /** Simulates the buyer clicking "Continue" on the PayPal approval page. */
  approve(orderId) { const o = this.#order(orderId); if (o.status !== 'PAYER_ACTION_REQUIRED') throw new Error(`ORDER_NOT_APPROVABLE: ${o.status}`); o.status = 'APPROVED'; return o; }
  async getOrder(orderId) { return structuredClone(this.#order(orderId)); }
  async authorizeOrder(orderId) {
    const o = this.#order(orderId);
    if (o.status !== 'APPROVED') { const e = new Error('PayPal POST authorize -> 422 UNPROCESSABLE_ENTITY ORDER_NOT_APPROVED'); e.status = 422; throw e; }
    const aid = id('MOCK-A-'); const exp = new Date(Date.now() + 29 * 864e5).toISOString();
    const a = { id: aid, status: 'CREATED', amount: o.purchase_units[0].amount, expiration_time: exp, orderId };
    this.auths.set(aid, a); o.status = 'COMPLETED'; o.purchase_units[0].payments = { authorizations: [a] };
    return parseAuthorizeResponse(o);
  }
  async captureAuthorization(aid, { amount, invoiceId } = {}) {
    const a = this.#auth(aid);
    if (a.status !== 'CREATED') { const e = new Error(`PayPal capture -> 422 AUTHORIZATION_ALREADY_${a.status}`); e.status = 422; throw e; }
    if (amount && Number(amount) > Number(a.amount.value)) { const e = new Error('PayPal capture -> 422 MAX_CAPTURE_AMOUNT_EXCEEDED'); e.status = 422; throw e; }
    a.status = 'CAPTURED'; const cid = id('MOCK-C-'); this.captures.set(cid, { id: cid, invoice_id: invoiceId, status: 'COMPLETED', amount: amount ? { ...a.amount, value: Number(amount).toFixed(2) } : a.amount });
    const o = this.orders.get(a.orderId); o.purchase_units[0].payments.captures = [this.captures.get(cid)];
    return { captureId: cid, status: 'COMPLETED' };
  }
  async voidAuthorization(aid) { const a = this.#auth(aid); if (a.status !== 'CREATED') { const e = new Error(`PayPal void -> 422 AUTHORIZATION_ALREADY_${a.status}`); e.status = 422; throw e; } a.status = 'VOIDED'; return { status: 'VOIDED' }; }
  async refundCapture(cid) { const c = this.captures.get(cid); if (!c) throw new Error('RESOURCE_NOT_FOUND'); if (c.status === 'REFUNDED') { const e = new Error('PayPal refund -> 422 CAPTURE_FULLY_REFUNDED'); e.status = 422; throw e; } c.status = 'REFUNDED'; const rid = id('MOCK-R-'); this.refunds.set(rid, { id: rid, status: 'COMPLETED', amount: c.amount }); return { refundId: rid, status: 'COMPLETED' }; }
  async getAuthorization(id) { return structuredClone(this.#auth(id)); }
  async getCapture(id) { const c = this.captures.get(id); if (!c) throw new Error('RESOURCE_NOT_FOUND'); return structuredClone(c); }
  async getRefund(id) { const r = this.refunds.get(id); if (!r) throw new Error('RESOURCE_NOT_FOUND'); return structuredClone(r); }
  #order(oid) { const o = this.orders.get(oid); if (!o) { const e = new Error('RESOURCE_NOT_FOUND'); e.status = 404; throw e; } return o; }
  #auth(aid) { const a = this.auths.get(aid); if (!a) { const e = new Error('RESOURCE_NOT_FOUND'); e.status = 404; throw e; } return a; }
}
