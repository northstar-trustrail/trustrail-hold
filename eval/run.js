// Reproducible evaluation. Never substitute lexical scores for MiniLM.
// EVAL_SET=v2 (default; held-out) or v1 (development set since v0.3.1).
import fs from 'node:fs';
import { freezeCriteria, validateIntent } from '../src/core/schema.js';
import { verifyDelivery } from '../src/ai/verifier.js';
import { VERIFIER_CONFIG } from '../src/ai/verifier-config.js';
import { MiniLMEmbedder, LexicalEmbedder } from '../src/ai/embed.js';
import { SourceChecker } from '../src/ai/source-check.js';
import { fetchPublicSource } from '../src/ai/source-fetch.js';
import { startFixtureServer } from './fixture-server.js';
import { summarize } from './metrics.js';
import { sha256Hex } from '../src/core/hash.js';
const set = process.env.EVAL_SET || 'v2';
const file = { v1: 'heldout-v1.json', v2: 'heldout-v2.json' }[set]; if (!file) throw new Error('EVAL_SET must be v1 or v2');
const bytes = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const data = JSON.parse(bytes);
const frozen = {};
for (const [id, spec] of Object.entries(data.specs)) {
  const v = validateIntent(spec); if (!v.ok) throw new Error(`${id}: ${v.errors.join('; ')}`);
  frozen[id] = await freezeCriteria(v.value);
}
let mini, modelError;
try { mini = await new MiniLMEmbedder().load(); } catch (e) { modelError = e.message; }
const live = process.env.EVAL_LIVE_SOURCES === '1';
const fixtureServer = live ? null : await startFixtureServer(data.sourceFixtures);
const sourceMode = live ? 'live-network' : `local fixture server (127.0.0.1) for ${fixtureServer.hosts.join(', ')}`;
const fetchSource = (url, cfg) => fetchPublicSource(url, { timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes, testRoutes: fixtureServer?.routes });
const systems = [];
for (const embedder of [new LexicalEmbedder(), ...(mini ? [mini] : [])]) for (const sourceCheck of [false, true]) {
  const rows = [];
  for (const c of data.cases) {
    const v = await verifyDelivery({ ...frozen[c.spec], evidence: c.evidence, embedder, sourceChecker: sourceCheck ? new SourceChecker({ fetchSource }) : null });
    rows.push({ id: c.id, kind: c.kind, label: c.label, decision: v.decision, decisionReason: v.decisionReason, sourceCheck: v.sourceCheck,
      results: v.results.map(r => ({ id: r.id, verdict: r.verdict, score: r.score, rationale: r.rationale })) });
  }
  systems.push({ name: embedder.name, sourceCheck, summary: summarize(rows), rows });
}
await fixtureServer?.close();
const comparisonToLexical = mini ? Object.fromEntries(['falseApproval', 'goodAutoApproval', 'escalation'].map(k => [k, { minilmOnly: systems[2].summary[k].rate - systems[0].summary[k].rate, minilmSourceCheck: systems[3].summary[k].rate - systems[0].summary[k].rate }]))
  : { status: 'not-measured', reason: 'MiniLM unavailable; no model scores substituted' };
const report = { set, role: set === 'v2' ? 'held-out' : 'development (used to design the v2 source check)', sourceMode, comparisonToLexical, protocol: data.protocol,
  datasetSha256: await sha256Hex(bytes), config: VERIFIER_CONFIG, miniLM: { available: !!mini, error: modelError || null }, systems };
const out = process.env.EVAL_OUT || `eval/results-heldout-${set}.json`;
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.table(systems.map(s => ({ system: s.name, sourceCheck: s.sourceCheck,
  falseApproval: `${s.summary.falseApproval.count}/${s.summary.falseApproval.total}`,
  goodAutoApproval: `${s.summary.goodAutoApproval.count}/${s.summary.goodAutoApproval.total}`,
  escalation: `${s.summary.escalation.count}/${s.summary.escalation.total}`,
  wronglyVoided: `${s.summary.goodWronglyVoided.count}/${s.summary.goodWronglyVoided.total}` })));
if (!mini) console.log(`MiniLM NOT MEASURED: ${modelError}`);
console.log(`Set ${set} (${report.role}); full decisions: ${out}`);
if (!mini && process.env.EVAL_REQUIRE_MINILM === '1') process.exitCode = 1;
