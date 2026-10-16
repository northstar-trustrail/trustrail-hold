#!/usr/bin/env node
import http from 'node:http'; import fs from 'node:fs/promises'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { buildEscrow } from './app.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escrow = buildEscrow();
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) bad(new Error('body too large')); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });
const view = h => ({ ...h, evidence: h.evidence ? { ...h.evidence, text: h.evidence.text?.slice(0, 4000) } : undefined });

const routes = [
  ['GET', /^\/api\/config$/, () => ({ paypal: escrow.paypal.mode, ai: escrow.brain.name, policy: escrow.policy })],
  ['GET', /^\/api\/holds$/, () => escrow.list().map(view)],
  ['POST', /^\/api\/holds$/, (m, b) => escrow.propose(b)],
  ['GET', /^\/api\/holds\/([\w-]+)$/, m => escrow.get(m[1])],
  ['POST', /^\/api\/holds\/([\w-]+)\/human$/, (m, b) => escrow.approveByHuman(m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/simulate-approval$/, m => { if (escrow.paypal.mode !== 'mock') throw Object.assign(new Error('only in mock mode; approve on PayPal instead'), { status: 400 }); escrow.paypal.approve(escrow.get(m[1]).paypal.orderId); return escrow.authorize(m[1]); }],
  ['POST', /^\/api\/holds\/([\w-]+)\/authorize$/, m => escrow.authorize(m[1])],
  ['POST', /^\/api\/holds\/([\w-]+)\/deliver$/, (m, b) => escrow.deliver(m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/resolve$/, (m, b) => escrow.resolve(m[1], b)],
  ['POST', /^\/api\/holds\/([\w-]+)\/refund$/, (m, b) => escrow.refund(m[1], b)],
  ['GET', /^\/api\/holds\/([\w-]+)\/proof$/, m => escrow.proof(m[1])],
  ['GET', /^\/api\/ledger$/, () => escrow.ledger.entries],
  ['POST', /^\/api\/sweep$/, () => escrow.sweep()],
];

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/paypal/return') { // PayPal redirects the payer here after approval
      const id = url.searchParams.get('hold'); await escrow.authorize(id);
      res.writeHead(302, { Location: `/#${id}` }); return res.end();
    }
    if (url.pathname === '/paypal/cancel') { res.writeHead(302, { Location: '/' }); return res.end(); }
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(m, method === 'POST' ? await body(req) : {}));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    let p = url.pathname === '/' ? '/web/index.html' : url.pathname.startsWith('/src/') ? url.pathname : '/web' + url.pathname;
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'forbidden' });
    const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch (e) {
    send(res, e.status || (e.code === 'ENOENT' ? 404 : 500), { error: e.message, debugId: e.debugId });
  }
}).listen(PORT, () => console.log(`Trustrail Hold on http://localhost:${PORT}  (paypal=${escrow.paypal.mode}, ai=${escrow.brain.name})`));
setInterval(() => escrow.sweep().catch(() => {}), 60_000).unref();
