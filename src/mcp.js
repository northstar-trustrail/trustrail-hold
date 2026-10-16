#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0) for a BUYER AGENT. It proxies to a running Trustrail server with
// the agent's own bearer token, so the agent can propose and read, and nothing else: it cannot approve,
// deliver, resolve, capture, void, or refund. (Server-side permissions enforce this, not the tool list.)
import { reviewViewResult } from './core/operations.js';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
const BASE = (process.env.TRUSTRAIL_URL || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.TRUSTRAIL_TOKEN || 'demo-agent';
const INTENT = { type: 'object', additionalProperties: false, required: ['kind', 'topic', 'questions', 'minSources', 'minWords', 'maxWords', 'amount', 'currency', 'sellerId', 'deliverWithinHours'],
  properties: { kind: { const: 'research_brief' }, topic: { type: 'string' }, questions: { type: 'array', items: { type: 'string' }, maxItems: 6 }, requiredSections: { type: 'array', items: { type: 'string' } },
    minSources: { type: 'integer' }, minDistinctDomains: { type: 'integer' }, minWords: { type: 'integer' }, maxWords: { type: 'integer' }, amount: { type: 'number' }, currency: { const: 'USD' }, sellerId: { type: 'string' }, deliverWithinHours: { type: 'integer', maximum: 72 } } };
export const TOOLS = [
  { name: 'build_expiring_review_view', description: 'Build a read-only operations review view of your unresolved holds expiring within 1-72 hours, including overdue holds. Returns validated Community grid filters, sort, summary, and a workspace URL. Cannot approve or settle.', inputSchema: { type: 'object', additionalProperties: false, properties: { withinHours: { type: 'integer', minimum: 1, maximum: 72, default: 24 } } } },
  { name: 'propose_research_brief', description: 'Order a research brief. Payment is only an authorization hold on the buyer\'s PayPal until delivery passes the frozen criteria. Returns a hold; a human must approve the PayPal authorization (approveUrl).', inputSchema: { type: 'object', properties: { intent: INTENT }, required: ['intent'] } },
  { name: 'get_hold', description: 'Get a hold you created, including per-criterion verdicts with evidence references.', inputSchema: { type: 'object', properties: { holdId: { type: 'string' } }, required: ['holdId'] } },
  { name: 'list_holds', description: 'List your holds.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_proof', description: 'Signed proof bundle (receipts, hash chain, signed checkpoint) for a hold.', inputSchema: { type: 'object', properties: { holdId: { type: 'string' } }, required: ['holdId'] } },
];
async function api(method, p, body) { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }
const slim = h => ({ holdId: h.id, state: h.state, topic: h.topic, amount: h.amount, sellerId: h.sellerId, criteriaHash: h.criteriaHash, criteria: h.criteria?.map(c => `${c.id}: ${c.text}`), policy: h.policy, approveUrl: h.state === 'AWAITING_PAYER' ? h.paypal?.approveUrl : undefined,
  verdict: h.verdict && { decision: h.verdict.decision, results: h.verdict.results.map(r => ({ id: r.id, verdict: r.verdict, refs: r.evidenceRefs.map(e => e.ref), rationale: r.rationale })) }, paypal: { orderId: h.paypal?.orderId, authorizationId: h.paypal?.authorizationId, captureId: h.paypal?.captureId } });
const impl = { build_expiring_review_view: async a => reviewViewResult(await api('GET', '/api/holds'), a), propose_research_brief: a => api('POST', '/api/holds', { intent: a.intent }).then(slim), get_hold: a => api('GET', `/api/holds/${encodeURIComponent(a.holdId)}`).then(slim), list_holds: () => api('GET', '/api/holds').then(l => l.map(slim)), get_proof: a => api('GET', `/api/holds/${encodeURIComponent(a.holdId)}/proof`) };
export async function handle({ id, method, params = {} }) {
  const ok = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'trustrail', version: '0.2.0' } });
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'ping') return ok({});
  if (method === 'tools/call') { const fn = impl[params.name]; if (!fn) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } };
    try { return ok({ content: [{ type: 'text', text: JSON.stringify(await fn(params.arguments || {}), null, 2) }] }); } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e.message }] }); } }
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method ${method} not found` } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readline.createInterface({ input: process.stdin }).on('line', async l => { let m; try { m = JSON.parse(l); } catch { return; } const r = await handle(m); if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
}
