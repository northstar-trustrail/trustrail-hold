import test from 'node:test'; import assert from 'node:assert/strict';
import { verifyDelivery } from '../src/ai/verifier.js';
import { freezeCriteria, validateIntent } from '../src/core/schema.js';
import { parseJudgeOutput } from '../src/ai/judge.js';
import { realEmbedder, ev, SPEC } from './helpers.js';
const F = await freezeCriteria(validateIntent(SPEC).value);
const E = await realEmbedder();
const sem = { skip: E ? false : 'MiniLM model unavailable offline' };
test('good brief: every criterion passes with evidence references', sem, async () => {
  const v = await verifyDelivery({ ...F, evidence: ev('A-good-1'), embedder: E });
  assert.equal(v.decision, 'capture'); assert.equal(v.criteriaHash, F.criteriaHash);
  for (const r of v.results) { assert.equal(r.verdict, 'pass', r.id + r.rationale); assert.ok(r.evidenceRefs.length, `${r.id} has refs`); assert.ok(r.rationale); }
  assert.match(v.results.find(r => r.id === 'Q-2').evidenceRefs[0].ref, /^S\d+\.P\d+$/);
});
test('keyword stuffing is never auto-captured (echo band)', sem, async () => { const v = await verifyDelivery({ ...F, evidence: ev('A-adv-stuffing'), embedder: E }); assert.notEqual(v.decision, 'capture'); assert.ok(v.results.some(r => /restates/.test(r.rationale))); });
test('adjacent topic (GDPR for AI Act order) is not captured', sem, async () => { const v = await verifyDelivery({ ...F, evidence: ev('A-adv-adjacent'), embedder: E }); assert.notEqual(v.decision, 'capture'); assert.equal(v.results.find(r => r.id === 'TOPIC').verdict, 'fail'); });
test('partial answer is not captured (answer-type check)', sem, async () => { const v = await verifyDelivery({ ...F, evidence: ev('A-adv-partial'), embedder: E }); assert.notEqual(v.decision, 'capture'); assert.match(v.results.find(r => r.id === 'Q-2').rationale, /expects an amount/); });
test('placeholder sources fail the deterministic check', async () => { const { LexicalEmbedder } = await import('../src/ai/embed.js'); const v = await verifyDelivery({ ...F, evidence: ev('A-adv-fake-sources'), embedder: E || new LexicalEmbedder() }); const s = v.results.find(r => r.id === 'SRC'); assert.equal(s.verdict, 'fail'); assert.match(s.rationale, /placeholder/); assert.notEqual(v.decision, 'capture'); });
test('injection escalates even when a judge says pass', async () => {
  const yes = { name: 'yes-judge', judge: async ({ passages }) => ({ verdict: 'pass', refs: [passages[0].ref], rationale: 'ok' }) };
  const { LexicalEmbedder } = await import('../src/ai/embed.js');
  const v = await verifyDelivery({ ...F, evidence: ev('A-adv-injection'), embedder: E || new LexicalEmbedder(), judge: yes });
  assert.equal(v.decision, 'escalate'); assert.ok(v.injection.suspicious);
});
test('judge can veto but cannot approve what retrieval rejected', async () => {
  const { LexicalEmbedder } = await import('../src/ai/embed.js');
  const yes = { name: 'yes', judge: async ({ passages }) => ({ verdict: 'pass', refs: [passages[0].ref], rationale: 'ok' }) };
  const v = await verifyDelivery({ ...F, evidence: ev('A-adv-empty-sections'), embedder: E || new LexicalEmbedder(), judge: yes });
  assert.equal(v.decision, 'void');
  if (E) { const no = { name: 'no', judge: async () => ({ verdict: 'fail', refs: [], rationale: 'does not answer' }) }; const w = await verifyDelivery({ ...F, evidence: ev('A-good-1'), embedder: E, judge: no }); assert.notEqual(w.decision, 'capture'); }
});
test('judge output schema: malformed or ref-less pass -> uncertain', () => {
  assert.equal(parseJudgeOutput('sure, pass!', ['S1.P1']).verdict, 'uncertain');
  assert.equal(parseJudgeOutput('{"verdict":"pass","refs":["S9.P9"]}', ['S1.P1']).verdict, 'uncertain');
  assert.equal(parseJudgeOutput('{"verdict":"pass","refs":["S1.P1"],"rationale":"r"}', ['S1.P1']).verdict, 'pass');
  assert.equal(parseJudgeOutput('{"verdict":"maybe"}', []).verdict, 'uncertain');
});
