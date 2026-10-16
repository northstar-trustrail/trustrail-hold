export function summarize(rows) {
  const good = rows.filter(r => r.label === 'capture'), bad = rows.filter(r => r.label === 'reject');
  const rate = (n, d) => ({ count: n, total: d, rate: d ? n / d : null });
  return {
    cases: rows.length,
    falseApproval: rate(bad.filter(r => r.decision === 'capture').length, bad.length),
    goodAutoApproval: rate(good.filter(r => r.decision === 'capture').length, good.length),
    escalation: rate(rows.filter(r => r.decision === 'escalate').length, rows.length),
    goodWronglyVoided: rate(good.filter(r => r.decision === 'void').length, good.length),
    falseApprovalIds: bad.filter(r => r.decision === 'capture').map(r => r.id),
  };
}
