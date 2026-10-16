import test from 'node:test';
import assert from 'node:assert/strict';
import { operationRow, buildReviewView, validateReviewView, reviewViewResult } from '../src/core/operations.js';
const now = Date.parse('2026-10-16T12:00:00Z');
const at = hours => new Date(now + hours * 36e5).toISOString();

test('agent review view includes overdue and pending holds, excludes final states and missing clocks', () => {
  const holds = [
    { id: 'overdue', state: 'ESCALATED', amount: 20, deadline: at(-1) },
    { id: 'honor', state: 'HELD', amount: 30, deadline: at(48), paypal: { honorEndsAt: at(3), authExpiresAt: at(600) } },
    { id: 'pending', state: 'CAPTURE_PENDING', amount: 40, deadline: at(8) },
    { id: 'later', state: 'HELD', amount: 50, deadline: at(48) },
    ...['RELEASED', 'REFUNDED', 'VOIDED', 'DENIED'].map(state => ({ id: state, state, amount: 10, deadline: at(-5) })),
    { id: 'no-clock', state: 'RECONCILIATION_REQUIRED', amount: 10 },
  ];
  const before = structuredClone(holds);
  const result = reviewViewResult(holds, { withinHours: 24 }, now);
  assert.deepEqual(result.summary.holdIds, ['overdue', 'honor', 'pending']);
  assert.equal(result.summary.exposure, 90); assert.equal(result.summary.count, 3);
  assert.equal(operationRow(holds[1], now).nextClock, 'Honor period ends');
  assert.equal(operationRow(holds[2], now).reviewNeeded, true);
  assert.deepEqual(holds, before, 'read-only tool must not change payment data');
});

test('agent view schema rejects settlement instructions, arbitrary filters, and invalid windows', () => {
  for (const withinHours of [0, 73, 1.5, '24']) assert.throws(() => buildReviewView({ withinHours }), /integer/);
  const plan = buildReviewView(); assert.deepEqual(validateReviewView(JSON.parse(JSON.stringify(plan))), plan);
  const malicious = structuredClone(plan); malicious.filterModel = { state: { filter: 'RELEASED' } };
  assert.throws(() => validateReviewView(malicious), /unrecognized/);
  assert.throws(() => validateReviewView({ ...plan, action: 'capture' }), /unrecognized/);
  assert.throws(() => reviewViewResult([], { withinHours: 24, capture: true }), /unknown/);
  assert.equal(plan.reviewUrl, '/operations.html?workflow=expiring&hours=24');
});
