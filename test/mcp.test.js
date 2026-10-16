import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
test('MCP stdio: initialize, list, propose, deliver flow (mock)', { timeout: 10000 }, async (t) => {
  const p = spawn(process.execPath, ['src/mcp.js'], { env: { ...process.env, PAYPAL_CLIENT_ID: '', TRUSTRAIL_URL: '' } });
  t.after(() => p.kill());
  let buf = ''; const waiters = [];
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiters.shift()(JSON.parse(l)); } });
  const rpc = (id, method, params) => new Promise(r => { waiters.push(r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' }); assert.equal(init.result.serverInfo.name, 'trustrail-hold');
  const list = await rpc(2, 'tools/list'); assert.ok(list.result.tools.some(t => t.name === 'submit_delivery'));
  assert.ok(!list.result.tools.some(t => /refund|resolve|human/.test(t.name)), 'operator-only tools not exposed');
  const pr = await rpc(3, 'tools/call', { name: 'propose_purchase', arguments: { request: 'Buy a haiku for $3 from poet. must mention rivers' } });
  const h = JSON.parse(pr.result.content[0].text); assert.equal(h.state, 'AWAITING_PAYER'); assert.ok(h.approveUrl);
  const bad = await rpc(4, 'tools/call', { name: 'submit_delivery', arguments: { holdId: h.holdId, text: 'x' } });
  assert.equal(bad.result.isError, true, 'cannot deliver before the payer approves the hold');
  p.kill();
});
