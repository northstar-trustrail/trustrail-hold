// Re-reads every ID in docs/sandbox-run.json straight from the PayPal sandbox API and records PayPal's own status.
import fs from 'node:fs'; import { RestPayPal } from '../src/paypal/rest.js';
const pp = new RestPayPal({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET });
const d = JSON.parse(fs.readFileSync('docs/sandbox-run.json')); const seen = new Set(); d.confirmed = [];
for (const r of d.run) for (const [kind, id, path] of [['order', r.orderId, '/v2/checkout/orders/'], ['authorization', r.authorizationId, '/v2/payments/authorizations/'], ['capture', r.captureId, '/v2/payments/captures/'], ['refund', r.refundId, '/v2/payments/refunds/']]) {
  if (!id || seen.has(id)) continue; seen.add(id);
  const j = await pp.call('GET', path + id); d.confirmed.push({ kind, id, paypalStatus: j.status, amount: j.amount?.value || j.purchase_units?.[0]?.amount?.value, updated: j.update_time || null });
}
d.confirmedAt = new Date().toISOString(); fs.writeFileSync('docs/sandbox-run.json', JSON.stringify(d, null, 1)); console.table(d.confirmed);
