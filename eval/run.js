// Labeled evaluation: runs the real verifier over eval/cases.json and reports false-approval rate.
// Usage: npm run eval            (MiniLM embeddings + deterministic checks)
//        npm run eval:llm        (+ local Qwen2.5-0.5B judge)   TRUSTRAIL_JUDGE=openai also works.
import fs from 'node:fs';
import { freezeCriteria, validateIntent } from '../src/core/schema.js';
import { verifyDelivery, THRESHOLDS } from '../src/ai/verifier.js';
import { MiniLMEmbedder, LexicalEmbedder } from '../src/ai/embed.js';
import { judgeFromEnv } from '../src/app.js';
const { specs, cases } = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url)));
const embedder = process.env.TRUSTRAIL_EMBEDDER === 'lexical' ? new LexicalEmbedder() : await new MiniLMEmbedder().load();
const judge = judgeFromEnv(process.env);
const frozen = {}; for (const [k, s] of Object.entries(specs)) { const v = validateIntent(s); if (!v.ok) throw new Error(v.errors); frozen[k] = await freezeCriteria(v.value); }
const rows = [];
for (const c of cases) {
  const f = frozen[c.spec]; const t = Date.now();
  const v = await verifyDelivery({ ...f, evidence: c.evidence, embedder, judge });
  rows.push({ holdout: !!c.holdout, id: c.id, kind: c.kind, label: c.label, decision: v.decision, ms: Date.now() - t, sem: v.results.filter(r => r.id.startsWith('Q')).map(r => `${r.id}:${r.verdict[0]}${r.score}`).join(' '), det: v.results.filter(r => !r.id.startsWith('Q')).map(r => `${r.id}:${r.verdict[0]}`).join(' '), note: c.note });
}
const rej = rows.filter(r => r.label === 'reject'), good = rows.filter(r => r.label === 'capture');
const fa = rej.filter(r => r.decision === 'capture'), fr = good.filter(r => r.decision === 'void'), esc = good.filter(r => r.decision === 'escalate');
const summary = { embedder: embedder.name, judge: judge?.name || 'none', thresholds: THRESHOLDS, cases: rows.length, normal: good.length, adversarial: rej.length,
  falseApprovalRate: `${fa.length}/${rej.length}`, falseRejectionRate: `${fr.length}/${good.length}`, goodEscalatedToHuman: `${esc.length}/${good.length}`, autoCaptureOfGood: `${good.filter(r => r.decision === 'capture').length}/${good.length}`,
  falseApprovals: fa.map(r => r.id),
  holdout: (() => { const h = rows.filter(r => r.holdout); return { cases: h.length, falseApprovals: h.filter(r => r.label === 'reject' && r.decision === 'capture').map(r => r.id), goodCaptured: h.filter(r => r.label === 'capture' && r.decision === 'capture').length + '/' + h.filter(r => r.label === 'capture').length }; })() };
console.table(rows.map(({ note, ...r }) => r)); console.log(JSON.stringify(summary, null, 2));
const out = process.env.EVAL_OUT; if (out) fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
