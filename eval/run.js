// Reproducible held-out evaluation. Never substitute lexical scores for MiniLM.
import fs from 'node:fs';
import { freezeCriteria, validateIntent } from '../src/core/schema.js';
import { verifyDelivery } from '../src/ai/verifier.js';
import { VERIFIER_CONFIG } from '../src/ai/verifier-config.js';
import { MiniLMEmbedder, LexicalEmbedder } from '../src/ai/embed.js';
import { SourceChecker } from '../src/ai/source-check.js';
import { fetchPublicSource } from '../src/ai/source-fetch.js';
import { summarize } from './metrics.js';
import { sha256Hex } from '../src/core/hash.js';
const bytes = fs.readFileSync(new URL('./heldout-v1.json', import.meta.url), 'utf8');
const data = JSON.parse(bytes);
const frozen = {};
for (const [id, spec] of Object.entries(data.specs)) {
  const v = validateIntent(spec); if (!v.ok) throw new Error(`${id}: ${v.errors.join('; ')}`);
  frozen[id] = await freezeCriteria(v.value);
}
const systems = [];
let mini, modelError;
try { mini = await new MiniLMEmbedder().load(); } catch (e) { modelError = e.message; }
const sourceMode = process.env.EVAL_LIVE_SOURCES === '1' ? 'live-network' : 'offline-authored-fixtures';
const fetchSource = sourceMode === 'live-network' ? fetchPublicSource : async url => {
  const fixture = data.sourceFixtures[url];
  if (!fixture) throw new Error('no offline fixture');
  return { url, ...fixture };
};
for (const embedder of [new LexicalEmbedder(), ...(mini ? [mini] : [])]) for (const sourceCheck of [false, true]) {
  const rows = [];
  for (const c of data.cases) {
    const v = await verifyDelivery({ ...frozen[c.spec], evidence: c.evidence, embedder, sourceChecker: sourceCheck ? new SourceChecker({ fetchSource }) : null });
    rows.push({ id: c.id, kind: c.kind, label: c.label, decision: v.decision, sourceCheck: v.sourceCheck,
      results: v.results.map(r => ({ id: r.id, verdict: r.verdict, score: r.score, rationale: r.rationale })) });
  }
  systems.push({ name: embedder.name, sourceCheck, summary: summarize(rows), rows });
}
const comparisonToLexical = mini ? Object.fromEntries(['falseApproval', 'goodAutoApproval', 'escalation'].map(k => [k, systems[2].summary[k].rate - systems[0].summary[k].rate]))
  : { status: 'not-measured', reason: 'MiniLM unavailable; no model scores substituted' };
const report = { sourceMode, comparisonToLexical, protocol: data.protocol, datasetSha256: await sha256Hex(bytes), config: VERIFIER_CONFIG,
  miniLM: { available: !!mini, error: modelError || null }, systems };
const out = process.env.EVAL_OUT || 'eval/results-heldout-v1.json';
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.table(systems.map(s => ({ system: s.name, sourceCheck: s.sourceCheck,
  falseApproval: `${s.summary.falseApproval.count}/${s.summary.falseApproval.total}`,
  goodAutoApproval: `${s.summary.goodAutoApproval.count}/${s.summary.goodAutoApproval.total}`,
  escalation: `${s.summary.escalation.count}/${s.summary.escalation.total}` })));
if (!mini) console.log(`MiniLM NOT MEASURED: ${modelError}`);
console.log(`Full decisions, failures, dataset hash, and frozen config: ${out}`);
if (!mini && process.env.EVAL_REQUIRE_MINILM === '1') process.exitCode = 1;
