// Guardrails an operator sets for an agent. Pure function: returns a decision, never throws.
export const DEFAULT_POLICY = {
  currency: 'USD',
  perPurchaseLimit: 200,        // hard cap per hold
  dailyLimit: 500,              // rolling total of open + captured holds today
  humanApprovalAbove: 100,      // holds above this need a human click before authorization
  allowedMerchants: null,       // null = any; else array of merchant ids
  blockedCategories: ['gift_cards', 'crypto', 'gambling'],
};
export function evaluatePolicy(policy, intent, spentToday = 0) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const reasons = []; const amt = Number(intent.amount);
  if (!(amt > 0)) reasons.push('amount must be positive');
  if (intent.currency && intent.currency !== p.currency) reasons.push(`currency ${intent.currency} not allowed (policy: ${p.currency})`);
  if (amt > p.perPurchaseLimit) reasons.push(`amount ${amt} exceeds per-purchase limit ${p.perPurchaseLimit}`);
  if (spentToday + amt > p.dailyLimit) reasons.push(`daily limit ${p.dailyLimit} would be exceeded (already ${spentToday})`);
  if (p.allowedMerchants && !p.allowedMerchants.includes(intent.merchantId)) reasons.push(`merchant ${intent.merchantId} not on allowlist`);
  if (intent.category && p.blockedCategories.includes(intent.category)) reasons.push(`category ${intent.category} is blocked`);
  if (!intent.criteria || !intent.criteria.length) reasons.push('purchase must carry at least one acceptance criterion');
  if (reasons.length) return { decision: 'deny', reasons };
  if (amt > p.humanApprovalAbove) return { decision: 'needs_human', reasons: [`amount ${amt} above human-approval threshold ${p.humanApprovalAbove}`] };
  return { decision: 'allow', reasons: ['within policy'] };
}
