import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SPEC } from './helpers.js';
const PORT = 18787 + Math.floor(Math.random() * 1000);
const env = { ...process.env, PORT: String(PORT), PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', TRUSTRAIL_EMBEDDER: 'lexical', TRUSTRAIL_URL: `http://localhost:${PORT}` };
test('MCP buyer-agent tools: propose/read only; server enforces permissions', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustrail-mcp-'));
  env.TRUSTRAIL_STORE = path.join(dir, 'state.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = spawn(process.execPath, ['src/server.js'], { env }); t.after(() => srv.kill());
  await new Promise((resolve, reject) => {
    let errors = ''; srv.stderr.on('data', d => { errors += d; });
    srv.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
    srv.stdout.on('data', d => /Trustrail on/.test(d) && resolve());
  });
  const p = spawn(process.execPath, ['src/mcp.js'], { env }); t.after(() => p.kill());
  let buf = ''; const waiters = [];
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiters.shift()(JSON.parse(l)); } });
  const rpc = (id, method, params) => new Promise(r => { waiters.push(r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await rpc(1, 'initialize', {})).result.serverInfo.name, 'trustrail');
  const names = (await rpc(2, 'tools/list')).result.tools.map(t => t.name);
  assert.deepEqual(names, ['propose_research_brief', 'get_hold', 'list_holds', 'get_proof']);
  const r = await rpc(3, 'tools/call', { name: 'propose_research_brief', arguments: { intent: SPEC } });
  const h = JSON.parse(r.result.content[0].text); assert.equal(h.state, 'AWAITING_PAYER'); assert.ok(h.criteriaHash);
  // Even calling the HTTP API directly with the agent's token cannot deliver, resolve, or refund.
  for (const path of ['deliver', 'resolve', 'refund']) {
    const res = await fetch(`http://localhost:${PORT}/api/holds/${h.holdId}/${path}`, { method: 'POST', headers: { Authorization: 'Bearer demo-agent', 'Content-Type': 'application/json' }, body: '{"body":"x","decision":"capture"}' });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await fetch(`http://localhost:${PORT}/api/holds`)).status, 401);
  assert.equal((await fetch(`http://localhost:${PORT}/api/paypal/webhook`, { method: 'POST', body: '{}' })).status, 401);
});
