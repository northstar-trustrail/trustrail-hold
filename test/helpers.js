import fs from 'node:fs';
import { HoldService } from '../src/core/holds.js';
import { MockPayPal } from '../src/paypal/mock.js';
import { MiniLMEmbedder, LexicalEmbedder } from '../src/ai/embed.js';
import { DEMO_TOKENS } from '../src/app.js';
export const EVAL = JSON.parse(fs.readFileSync(new URL('../eval/cases.json', import.meta.url)));
export const ev = id => EVAL.cases.find(c => c.id === id).evidence;
export const SPEC = EVAL.specs.A;
export const who = k => DEMO_TOKENS[`demo-${k}`];
let mini;
/** Real MiniLM if it can load (cached after first download), else null so semantic tests skip rather than fake. */
export async function realEmbedder() { if (mini === undefined) { try { mini = await new MiniLMEmbedder().load(); } catch { mini = null; } } return mini; }
export async function service({ embedder, ...o } = {}) {
  const pp = new MockPayPal();
  const svc = await HoldService.create({ paypal: pp, embedder: embedder || await realEmbedder() || new LexicalEmbedder(), ...o });
  return { svc, pp };
}
export async function held(svc, pp, intent = SPEC) {
  const h = await svc.propose(who('agent'), { intent }); pp.approve(h.paypal.orderId); return svc.authorize(who('buyer'), h.id);
}
