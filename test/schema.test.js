import test from 'node:test'; import assert from 'node:assert/strict';
import { validateIntent, freezeCriteria, validateEvidence } from '../src/core/schema.js';
import { parseIntent } from '../src/ai/intent.js';
import { SPEC } from './helpers.js';
test('valid research-brief intent passes; unknown/invalid fields are rejected', () => {
  assert.equal(validateIntent(SPEC).ok, true);
  assert.match(validateIntent({ ...SPEC, payTo: 'x' }).errors.join(), /unknown fields: payTo/);
  assert.match(validateIntent({ ...SPEC, amount: 10.123 }).errors.join(), /amount/);
  assert.match(validateIntent({ ...SPEC, deliverWithinHours: 200 }).errors.join(), /honor period/);
  assert.match(validateIntent({ ...SPEC, kind: 'laptop' }).errors.join(), /research_brief/);
  assert.match(validateIntent({ ...SPEC, minDistinctDomains: 9 }).errors.join(), /minDistinctDomains/);
});
test('criteria are frozen and committed by hash', async () => {
  const a = await freezeCriteria(validateIntent(SPEC).value), b = await freezeCriteria(validateIntent(SPEC).value);
  assert.equal(a.criteriaHash, b.criteriaHash); assert.ok(Object.isFrozen(a.criteria) && Object.isFrozen(a.criteria[0].params));
  assert.throws(() => { a.criteria[0].params.minWords = 0; }, TypeError);
  assert.deepEqual(a.criteria.map(c => c.id), ['SEC-1', 'SEC-2', 'SEC-3', 'TOPIC', 'LEN', 'SRC', 'Q-1', 'Q-2', 'Q-3']);
  const c = await freezeCriteria(validateIntent({ ...SPEC, minWords: 151 }).value); assert.notEqual(c.criteriaHash, a.criteriaHash);
});
test('evidence schema', () => { assert.equal(validateEvidence({ body: '' }).ok, false); assert.equal(validateEvidence({ body: 'x', sources: [{ url: 'nope' }] }).ok, false); });
test('intent from text: amount must literally appear (anti-hallucination)', async () => {
  const fakeLlm = { name: 'fake', complete: async () => JSON.stringify({ ...SPEC, amount: 450 }) };
  const r = await parseIntent('Get me a research brief on the EU AI Act from briefsmith for $45', { llm: fakeLlm });
  assert.equal(r.ok, false); assert.match(r.errors.join(), /hallucination/);
  const ok = await parseIntent('x $45', { llm: { name: 'fake', complete: async () => JSON.stringify(SPEC) } }); assert.equal(ok.ok, true);
});
