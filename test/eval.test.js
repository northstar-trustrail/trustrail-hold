import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { summarize } from '../eval/metrics.js';
import { VERIFIER_CONFIG } from '../src/ai/verifier-config.js';
import { validateIntent, freezeCriteria } from '../src/core/schema.js';
import { parseBrief, runDeterministic } from '../src/core/brief.js';

test('evaluation denominators distinguish bad approvals, good approvals, and total escalations', () => {
  const s = summarize([
    { id: 'bad-pass', label: 'reject', decision: 'capture' },
    { id: 'bad-escalate', label: 'reject', decision: 'escalate' },
    { id: 'good-pass', label: 'capture', decision: 'capture' },
    { id: 'good-void', label: 'capture', decision: 'void' },
    { id: 'good-escalate', label: 'capture', decision: 'escalate' },
  ]);
  assert.deepEqual(s.falseApproval, { count: 1, total: 2, rate: 0.5 });
  assert.equal(s.goodAutoApproval.rate, 1 / 3); assert.equal(s.escalation.rate, 2 / 5);
  assert.equal(s.goodWronglyVoided.count, 1); assert.deepEqual(s.falseApprovalIds, ['bad-pass']);
  assert.equal(summarize([]).falseApproval.rate, null);
});

test('held-out set covers new topics and compliant good work without changing frozen thresholds', async () => {
  assert.ok(Object.isFrozen(VERIFIER_CONFIG.retrieval));
  assert.throws(() => { VERIFIER_CONFIG.retrieval.pass = 0; }, TypeError);
  const old = JSON.parse(fs.readFileSync(new URL('../eval/cases.json', import.meta.url)));
  const data = JSON.parse(fs.readFileSync(new URL('../eval/heldout-v1.json', import.meta.url)));
  assert.ok(data.cases.length >= 15); assert.equal(data.protocol.thresholdConfig, VERIFIER_CONFIG.version);
  const oldTopics = Object.values(old.specs).map(s => s.topic);
  for (const spec of Object.values(data.specs)) { assert.equal(validateIntent(spec).ok, true); assert.equal(oldTopics.includes(spec.topic), false); }
  const kinds = new Set(data.cases.map(c => c.kind));
  for (const k of ['good', 'fabricated-citation', 'factual-error', 'off-topic', 'padding']) assert.ok(kinds.has(k));
  for (const c of data.cases.filter(c => c.label === 'capture')) {
    const { criteria } = await freezeCriteria(data.specs[c.spec]);
    for (const rule of criteria.filter(r => r.kind === 'deterministic')) assert.equal(runDeterministic(rule, c.evidence, parseBrief(c.evidence.body)).verdict, 'pass', `${c.id}: ${rule.id}`);
  }
});

test('held-out v2: new topics, required kinds, compliant good work, real source snapshots', async () => {
  const data = JSON.parse(fs.readFileSync(new URL('../eval/heldout-v2.json', import.meta.url)));
  const earlier = [...Object.values(JSON.parse(fs.readFileSync(new URL('../eval/cases.json', import.meta.url))).specs),
    ...Object.values(JSON.parse(fs.readFileSync(new URL('../eval/heldout-v1.json', import.meta.url))).specs)].map(s => s.topic);
  assert.ok(data.cases.length >= 20);
  for (const spec of Object.values(data.specs)) { assert.equal(validateIntent(spec).ok, true); assert.equal(earlier.includes(spec.topic), false); }
  const kinds = new Set(data.cases.map(c => c.kind));
  for (const k of ['good', 'fabricated-citation', 'wrong-number', 'wrong-entity', 'padding', 'off-topic', 'prompt-injection']) assert.ok(kinds.has(k), k);
  for (const c of data.cases) for (const s of c.evidence.sources) assert.ok(data.sourceFixtures[s.url], `${c.id}: fixture for ${s.url}`);
  for (const c of data.cases.filter(c => c.label === 'capture')) {
    const { criteria } = await freezeCriteria(data.specs[c.spec]);
    for (const rule of criteria.filter(r => r.kind === 'deterministic')) assert.equal(runDeterministic(rule, c.evidence, parseBrief(c.evidence.body)).verdict, 'pass', `${c.id}: ${rule.id}`);
  }
});
