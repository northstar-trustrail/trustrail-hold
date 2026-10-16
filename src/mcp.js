#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0). Lets any MCP agent buy through Trustrail Hold.
// TRUSTRAIL_URL=http://localhost:8787 proxies to a running dashboard server (shared state);
// otherwise an in-process engine is used.
import readline from 'node:readline';
import { buildEscrow } from './app.js';

const TOOLS = [
  { name: 'propose_purchase', description: 'Ask to buy something. Money is only HELD (PayPal authorization), never sent, until delivery is verified. Include objective acceptance criteria after "must".',
    inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'e.g. "Buy a 500-word blog post for $30 from wordsmith. It must be at least 500 words; mention PayPal"' }, agentId: { type: 'string' } }, required: ['request'] } },
  { name: 'get_hold', description: 'Get the state of a hold (AWAITING_PAYER means a human must approve on PayPal via approveUrl).', inputSchema: { type: 'object', properties: { holdId: { type: 'string' } }, required: ['holdId'] } },
  { name: 'list_holds', description: 'List all holds and their states.', inputSchema: { type: 'object', properties: {} } },
  { name: 'submit_delivery', description: 'Seller side: submit delivery evidence. The AI verifier checks it against the criteria and captures, voids, or escalates.',
    inputSchema: { type: 'object', properties: { holdId: { type: 'string' }, text: { type: 'string' }, artifacts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } }, required: ['holdId', 'text'] } },
  { name: 'get_proof', description: 'Hash-chained proof-of-payment receipts for a hold.', inputSchema: { type: 'object', properties: { holdId: { type: 'string' } }, required: ['holdId'] } },
];
// Deliberately NOT exposed to agents: human approval, escalation resolve, refund. Those stay with the human operator.

const remote = process.env.TRUSTRAIL_URL?.replace(/\/$/, '');
const local = remote ? null : buildEscrow();
async function api(method, path, body) {
  const r = await fetch(remote + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
}
const slim = h => ({ holdId: h.id, state: h.state, item: h.item, amount: h.amount, currency: h.currency, merchantId: h.merchantId, criteria: h.criteria, policy: h.policy, approveUrl: h.state === 'AWAITING_PAYER' ? h.paypal?.approveUrl : undefined, verdict: h.verdict && { verdict: h.verdict.verdict, results: h.verdict.results }, paypal: h.paypal && { orderId: h.paypal.orderId, authorizationId: h.paypal.authorizationId, captureId: h.paypal.captureId } });
const impl = {
  propose_purchase: a => remote ? api('POST', '/api/holds', a) : local.propose(a),
  get_hold: a => remote ? api('GET', `/api/holds/${a.holdId}`) : local.get(a.holdId),
  list_holds: () => remote ? api('GET', '/api/holds') : local.list(),
  submit_delivery: a => remote ? api('POST', `/api/holds/${a.holdId}/deliver`, { text: a.text, artifacts: a.artifacts || [] }) : local.deliver(a.holdId, { text: a.text, artifacts: a.artifacts || [] }),
  get_proof: a => remote ? api('GET', `/api/holds/${a.holdId}/proof`) : local.proof(a.holdId),
};
export async function handle(msg) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trustrail-hold', version: '0.1.0' } });
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'ping') return ok({});
  if (method === 'tools/call') {
    const fn = impl[params.name]; if (!fn) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } };
    try { const out = await fn(params.arguments || {}); const v = Array.isArray(out) ? out.map(slim) : out.chainHead ? out : slim(out); return ok({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] }); }
    catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e.message }] }); }
  }
  if (id === undefined) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not found` } };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => { if (!line.trim()) return; let m; try { m = JSON.parse(line); } catch { return; } const r = await handle(m); if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
}
