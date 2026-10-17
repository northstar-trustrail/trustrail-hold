import { parseAuthorizeResponse, approveLink } from './interface.js';
// Real PayPal REST adapter (sandbox by default). Credentials come from env; never logged.
export class RestPayPal {
  constructor({ clientId, clientSecret, base = 'https://api-m.sandbox.paypal.com', fetchImpl = globalThis.fetch } = {}) {
    if (!clientId || !clientSecret) throw new Error('RestPayPal needs clientId and clientSecret');
    Object.assign(this, { clientId, clientSecret, base, fetch: fetchImpl, token: null, tokenExp: 0, mode: 'sandbox' });
  }
  async accessToken() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const r = await this.fetch(`${this.base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (!r.ok) throw new Error(`PayPal OAuth failed: HTTP ${r.status}`);
    const j = await r.json(); this.token = j.access_token; this.tokenExp = Date.now() + j.expires_in * 1000;
    return this.token;
  }
  async call(method, path, body, requestId, { rawBody = null } = {}) {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency
    const r = await this.fetch(`${this.base}${path}`, { method, headers, body: rawBody ?? (body ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(15000) });
    const text = await r.text(); const j = text ? JSON.parse(text) : {};
    if (!r.ok) { const e = new Error(`PayPal ${method} ${path} -> ${r.status} ${j.name || ''} ${(j.details || []).map(d => d.issue).join(',') || j.message || ''}`.trim()); e.status = r.status; e.debugId = j.debug_id; e.details = j.details; throw e; }
    return j;
  }
  async createAuthorizeOrder({ holdId, amount, currency = 'USD', description, merchantId, returnUrl, cancelUrl, sandboxCard, requestId }) {
    const source = sandboxCard
      // Sandbox-only shortcut for unattended demos: a PayPal sandbox test card authorizes without a buyer login.
      ? { card: { number: sandboxCard.number, expiry: sandboxCard.expiry, security_code: sandboxCard.cvv, name: 'Sandbox Buyer' } }
      : { paypal: { experience_context: { brand_name: 'Trustrail', user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl } } };
    if (sandboxCard && !this.base.includes('sandbox')) throw new Error('sandbox test cards are only allowed against the sandbox API');
    // Single merchant: omit payee so PayPal uses the app credential owner's account.
    // merchantId is an internal deliverer ID and is never presented as a PayPal payee.
    const o = await this.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: holdId, custom_id: holdId, description: String(description).slice(0, 127), soft_descriptor: 'TRUSTRAIL',
        amount: { currency_code: currency, value: Number(amount).toFixed(2) } }],
      payment_source: source,
    }, requestId || `create-${holdId}-${crypto.randomUUID()}`);
    const auth = o.purchase_units?.[0]?.payments?.authorizations?.[0];
    return { id: o.id, status: o.status, approveUrl: approveLink(o), merchantId, authorization: auth ? { authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time } : null };
  }
  getAuthorization(id) { return this.call('GET', `/v2/payments/authorizations/${encodeURIComponent(id)}`); }
  getCapture(id) { return this.call('GET', `/v2/payments/captures/${encodeURIComponent(id)}`); }
  getRefund(id) { return this.call('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`); }
  /**
   * PayPal signs the exact bytes it sent. Re-serializing a parsed event can change them (key order, number
   * formatting, escapes), so when the raw body is available it is spliced verbatim into the request as webhook_event.
   */
  async verifyWebhook(headers, event, webhookId, rawBody = null) {
    const fields = { auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'] };
    if (Object.values(fields).some(v => !v)) return false;
    const path = '/v1/notifications/verify-webhook-signature';
    let raw = null;
    if (typeof rawBody === 'string') { JSON.parse(rawBody); raw = JSON.stringify({ ...fields, webhook_id: webhookId }).slice(0, -1) + ',"webhook_event":' + rawBody + '}'; }
    const r = await this.call('POST', path, { ...fields, webhook_id: webhookId, webhook_event: event }, undefined, { rawBody: raw });
    return r.verification_status === 'SUCCESS';
  }
  getOrder(orderId) { return this.call('GET', `/v2/checkout/orders/${orderId}`); }
  async authorizeOrder(orderId, { requestId } = {}) { return parseAuthorizeResponse(await this.call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, requestId || `auth-${orderId}`)); }
  async captureAuthorization(authorizationId, { amount, currency = 'USD', invoiceId, note, requestId } = {}) {
    const c = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
      final_capture: true, invoice_id: invoiceId, note_to_payer: note?.slice(0, 255),
      ...(amount ? { amount: { currency_code: currency, value: Number(amount).toFixed(2) } } : {}) }, requestId || `cap-${authorizationId}`);
    return { captureId: c.id, status: c.status };
  }
  async voidAuthorization(authorizationId, { requestId } = {}) { await this.call('POST', `/v2/payments/authorizations/${authorizationId}/void`, null, requestId || `void-${authorizationId}`); return { status: 'VOIDED' }; }
  async refundCapture(captureId, { note, requestId } = {}) { const r = await this.call('POST', `/v2/payments/captures/${captureId}/refund`, { note_to_payer: note?.slice(0, 255) }, requestId || `ref-${captureId}`); return { refundId: r.id, status: r.status }; }
}
