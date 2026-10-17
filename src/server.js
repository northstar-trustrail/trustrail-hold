#!/usr/bin/env node
import http from 'node:http'; import fs from 'node:fs/promises'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { buildService, tokensFromEnv } from './app.js';
import { assertCan } from './core/authz.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svc = await buildService(); const TOKENS = tokensFromEnv(process.env);
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// Raw bytes are kept for PayPal webhook signature verification; JSON is parsed from the same bytes.
const rawText = req => new Promise((ok, bad) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > 2e5) { bad(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); }); req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', bad); });
const parse = d => { try { return d ? JSON.parse(d) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); } };
const body = async req => parse(await rawText(req));
const actorOf = req => TOKENS[(req.headers.authorization || '').replace(/^Bearer\s+/i, '')] || null;
const SYSTEM = { id: 'sweeper', role: 'system' };

const routes = [
  ['GET', /^\/api\/config$/, () => ({ sourceCheck: svc.sourceChecker ? 'on (live public fetch)' : 'off (TRUSTRAIL_SOURCE_CHECK=0)', paypal: svc.paypalMode, embedder: svc.embedder.name, judge: svc.judge?.name || null, policy: svc.policy, publicKey: svc.checkpoints.signer.pubJwk })],
  ['GET', /^\/api\/me$/, (a) => a],
  ['GET', /^\/api\/holds$/, (a) => svc.list(a)],
  ['POST', /^\/api\/holds$/, (a, m, b) => svc.propose(a, b)],
  ['GET', /^\/api\/holds\/([\w-]+)$/, (a, m) => svc.get(a, m[1])],
  ['POST', /^\/api\/holds\/([\w-]+)\/policy-approval$/, (a, m, b) => svc.approvePolicy(a, m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/simulate-payer-approval$/, async (a, m) => { if (svc.paypalMode !== 'mock') throw Object.assign(new Error('mock mode only; approve on PayPal'), { status: 400 }); const h = svc.get(a, m[1]); svc.settlement.paypal.approve(h.paypal.orderId); return svc.authorize(a, m[1]); }],
  ['POST', /^\/api\/holds\/([\w-]+)\/deliver$/, (a, m, b) => svc.deliver(a, m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/resolve$/, (a, m, b) => svc.resolve(a, m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/refund$/, (a, m, b) => svc.refund(a, m[1], b)],
  ['GET', /^\/api\/holds\/([\w-]+)\/proof$/, (a, m) => svc.proof(a, m[1])],
  ['GET', /^\/api\/ledger$/, (a) => { assertCan(a, 'ledger.read'); return svc.ledger.entries; }],
  ['GET', /^\/api\/checkpoints$/, () => ({ publicKey: svc.checkpoints.signer.pubJwk, checkpoints: svc.checkpoints.list })],
];
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/paypal/webhook' && req.method === 'POST') { const raw = await rawText(req); return send(res, 200, await svc.webhook(req.headers, parse(raw), process.env.PAYPAL_WEBHOOK_ID, raw)); }
    if (url.pathname === '/paypal/return') { // buyer approved on PayPal; PayPal's approval is the buyer's consent
      const h = svc.holds.get(url.searchParams.get('hold')); if (!h) return send(res, 404, { error: 'unknown hold' });
      await svc.authorize({ id: 'paypal-return', role: 'buyer', org: h.buyerId }, h.id); res.writeHead(302, { Location: `/#${h.id}` }); return res.end();
    }
    if (url.pathname === '/paypal/cancel') { res.writeHead(302, { Location: '/' }); return res.end(); }
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re); if (!m || req.method !== method) continue;
      const actor = actorOf(req); if (!actor && !/config/.test(url.pathname)) return send(res, 401, { error: 'missing or unknown bearer token' });
      return send(res, 200, await fn(actor, m, method === 'POST' ? await body(req) : {}));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const p = url.pathname === '/' ? '/web/index.html' : /^\/(src|eval)\//.test(url.pathname) ? url.pathname : '/web' + url.pathname;
    const file = path.join(root, path.normalize(p)); if (!file.startsWith(root + path.sep) || /src\/(app|server|mcp)\.js$|eval\/(?!cases\.json)/.test(file)) return send(res, 403, { error: 'forbidden' });
    const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch (e) { send(res, e.status || (e.code === 'ENOENT' ? 404 : 500), { error: e.message, debugId: e.debugId }); }
}).listen(PORT, () => console.log(`Trustrail on http://localhost:${PORT} paypal=${svc.paypalMode} embedder=${svc.embedder.name} judge=${svc.judge?.name || 'none'}`));
setInterval(() => svc.reconcile().then(() => svc.sweep(SYSTEM)).catch(() => {}), 60_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { svc.persist(); svc.store?.close(); process.exit(0); });
