// Real PayPal sandbox lifecycle through the full Trustrail service (needs PAYPAL_CLIENT_ID/SECRET).
// Buyer approval: TRUSTRAIL_SANDBOX_CARD (a PayPal sandbox test card) authorizes without a browser login.
// Writes docs/sandbox-run.json with the real sandbox order/authorization/capture/refund IDs.
import fs from 'node:fs';
import { buildService, DEMO_TOKENS } from '../src/app.js';
if (!process.env.PAYPAL_CLIENT_ID) { console.error('set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'); process.exit(1); }
process.env.TRUSTRAIL_SANDBOX_CARD ||= '4032039317984658';
// This script exercises PayPal money movement. The build box cannot reach public citation hosts, so the
// source check (on by default) would escalate every delivery; it is turned off here unless set explicitly.
process.env.TRUSTRAIL_SOURCE_CHECK ??= '0';
// Fresh store per run so a previous mock/sandbox snapshot is never mixed into the recorded IDs.
process.env.TRUSTRAIL_STORE ||= `${process.env.TMPDIR || '/tmp'}/trustrail-sandbox-${Date.now()}.json`;
const svc = await buildService(process.env); const A = DEMO_TOKENS;
const actor = k => A[`demo-${k}`];
const { specs, cases } = JSON.parse(fs.readFileSync('eval/cases.json'));
const ev = id => cases.find(c => c.id === id).evidence;
const run = [];
const rec = (label, h) => { const r = { scenario: label, holdId: h.id, state: h.state, decision: h.verdict?.decision || null, orderId: h.paypal.orderId, authorizationId: h.paypal.authorizationId, captureId: h.paypal.captureId || null, captureStatus: h.paypal.captureStatus || null, refundId: h.paypal.refundId || null, refundStatus: h.paypal.refundStatus || null }; run.push(r); console.log(r); };
// 1) good delivery -> capture, then buyer dispute -> refund
let h = await svc.propose(actor('agent'), { intent: specs.A }); await svc.deliver(actor('seller'), h.id, ev('A-good-1')); rec('good delivery -> capture', h);
await svc.refund(actor('buyer'), h.id, { reason: 'sandbox refund test' }); rec('buyer dispute -> refund', h);
// 2) failed delivery -> void
h = await svc.propose(actor('agent'), { intent: specs.A }); await svc.deliver(actor('seller'), h.id, ev('A-adv-empty-sections')); rec('empty delivery -> void', h);
// 3) malicious delivery -> escalate -> reviewer voids
h = await svc.propose(actor('agent'), { intent: specs.A }); await svc.deliver(actor('seller'), h.id, ev('A-adv-injection')); rec('prompt injection -> escalate', h);
await svc.resolve(actor('reviewer'), h.id, { decision: 'void', note: 'injection attempt' }); rec('reviewer -> void', h);
const proof = await svc.proof(actor('auditor'), h.id);
fs.writeFileSync('docs/sandbox-run.json', JSON.stringify({ version: JSON.parse(fs.readFileSync('package.json')).version, ranAt: new Date().toISOString(), api: 'https://api-m.sandbox.paypal.com', paypalMode: svc.paypalMode, embedder: svc.embedder.name, run, checkpoint: proof.checkpoint, publicKey: proof.publicKey }, null, 1));
svc.store?.close();
console.log('wrote docs/sandbox-run.json');
