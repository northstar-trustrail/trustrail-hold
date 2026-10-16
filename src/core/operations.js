// Read-only view tool shared by MCP and the operations workspace. No settlement imports.
import { canon } from './hash.js';
export const REVIEW_WORKFLOW = 'expiring-unresolved-holds';
const FINAL = new Set(['RELEASED', 'REFUNDED', 'VOIDED', 'DENIED']);
export function operationRow(h, now = Date.now()) {
  const clocks = [['Delivery deadline', h.deadline], ['Honor period ends', h.paypal?.honorEndsAt], ['Authorization expires', h.paypal?.authExpiresAt]]
    .map(([label, at]) => ({ label, at, ms: Date.parse(at) })).filter(c => Number.isFinite(c.ms)).sort((a, b) => a.ms - b.ms);
  const unresolved = !FINAL.has(h.state);
  const next = unresolved ? clocks[0] : null;
  return { ...h, unresolved: unresolved ? 'yes' : 'no', exposure: unresolved ? h.amount : 0,
    nextClock: next?.label || 'No pending clock', nextAt: next?.at || null,
    hoursRemaining: next ? (next.ms - now) / 36e5 : null,
    reviewNeeded: ['ESCALATED', 'AWAITING_HUMAN', 'RECONCILIATION_REQUIRED', 'CAPTURE_PENDING', 'REFUND_PENDING'].includes(h.state) || (next && next.ms <= now),
    criteriaPassed: h.verdict?.results.filter(r => r.verdict === 'pass').length ?? null,
    criteriaTotal: h.criteria?.length || 0 };
}
export function buildReviewView({ withinHours = 24 } = {}) {
  if (!Number.isInteger(withinHours) || withinHours < 1 || withinHours > 72) throw Object.assign(new Error('withinHours must be an integer from 1 to 72'), { status: 400 });
  return { version: 1, workflow: REVIEW_WORKFLOW, withinHours,
    filterModel: { unresolved: { filterType: 'text', type: 'equals', filter: 'yes' }, hoursRemaining: { filterType: 'number', type: 'lessThanOrEqual', filter: withinHours } },
    sortState: [{ colId: 'hoursRemaining', sort: 'asc' }],
    reviewUrl: `/operations.html?workflow=expiring&hours=${withinHours}`,
    explanation: `Unresolved holds due within ${withinHours} hours or overdue, sorted by the earliest delivery, honor-period, or authorization clock. This view cannot settle payments.` };
}
export function validateReviewView(plan) {
  const expected = buildReviewView({ withinHours: plan?.withinHours });
  if (canon(plan) !== canon(expected)) throw new Error('unrecognized review view; only the read-only workflow is allowed');
  return expected;
}
export function matchesReviewView(row, plan) {
  validateReviewView(plan);
  return row.unresolved === 'yes' && Number.isFinite(row.hoursRemaining) && row.hoursRemaining <= plan.withinHours;
}
export function reviewViewResult(holds, input = {}, now = Date.now()) {
  if (Object.keys(input).some(k => k !== 'withinHours')) throw new Error('unknown review tool argument');
  const plan = buildReviewView(input);
  const rows = holds.map(h => operationRow(h, now)).filter(r => matchesReviewView(r, plan)).sort((a, b) => a.hoursRemaining - b.hoursRemaining);
  return { plan, summary: { count: rows.length, exposure: rows.reduce((s, h) => s + h.exposure, 0), currency: 'USD', holdIds: rows.map(h => h.id) } };
}
