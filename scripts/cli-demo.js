// End-to-end run in the terminal. Uses PayPal sandbox if PAYPAL_CLIENT_ID/SECRET are set
// (you will be asked to open the approval link), otherwise the mock twin.
import readline from 'node:readline/promises';
import { buildEscrow } from '../src/app.js';
const e = buildEscrow(); const log = (...a) => console.log(...a);
log(`paypal=${e.paypal.mode} ai=${e.brain.name}\n`);
const h = await e.propose({ agentId: 'cli-agent', request: 'Buy a competitor pricing report for $40 from datasmith. It must include at least 3 competitors; cover pricing tiers; in csv' });
log('proposed', h.id, h.state, h.criteria);
if (e.paypal.mode === 'mock') e.paypal.approve(h.paypal.orderId);
else { log('\nApprove the hold with a sandbox buyer account:\n ', h.paypal.approveUrl); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); await rl.question('Press Enter after approving... '); rl.close(); }
await e.authorize(h.id); log('held', h.paypal.authorizationId, 'expires', h.paypal.authExpiresAt);
await e.deliver(h.id, { text: 'Competitor pricing tiers\n- Acme: 3 tiers\n- Globex: 3 tiers\n- Initech: per-seat tiers', artifacts: [{ name: 'pricing.csv' }] });
log('verdict', h.verdict.verdict, h.verdict.results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.criterion}`));
log('final', h.state, 'capture', h.paypal.captureId);
const p = await e.proof(h.id); log('proof: chainValid', p.chainValid, 'receipts', p.receipts.length, 'head', p.chainHead.slice(0, 16));
