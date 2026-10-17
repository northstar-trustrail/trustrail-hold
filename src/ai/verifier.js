// Delivery verifier. Pure function of (frozen criteria, evidence, models). Has no PayPal access.
import { parseBrief, runDeterministic } from '../core/brief.js';
import { scanInjection } from './guard.js';
import { cosine } from './embed.js';
import { sha256Hex, canon } from '../core/hash.js';

import { VERIFIER_CONFIG } from './verifier-config.js';
export const THRESHOLDS = VERIFIER_CONFIG.retrieval;

// Expected answer type (classic QA heuristic): a real answer to "when / how long / how much" contains a date, duration or amount.
const ANSWER_TYPES = [
  [/^\s*when\b|\bwhat date\b|\bdeadline\b/i, /\b(19|20)\d\d\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, 'a date'],
  [/\bhow long\b|\bduration\b|\bperiod\b/i, /\b\d+\s*(-|to|–)?\s*\d*\s*(day|week|month|year)s?\b|\b(three|six|twelve|one)\s*(-\s*)?(day|week|month|year)s?\b/i, 'a duration'],
  [/\bcost|price|fees?\b|\bfines?\b|\bhow much\b|\bpenalt/i, /[$€£]\s?\d|\b\d[\d,.]*\s*(k|m|million|billion)?\s*(usd|eur|euros?|dollars?|gbp)\b|\b(usd|eur)\s?\d|\d+(\.\d+)?\s*(%|percent)/i, 'an amount'],
];
export function expectedAnswerType(q) { const t = ANSWER_TYPES.find(([qre]) => qre.test(q)); return t ? { re: t[1], label: t[2] } : null; }

export async function verifyDelivery({ criteria, criteriaHash, evidence, embedder, judge = null, sourceChecker = null, thresholds = THRESHOLDS }) {
  const parsed = parseBrief(evidence.body);
  const injection = scanInjection(evidence.body + '\n' + (evidence.sources || []).map(s => s.title).join('\n'));
  const units = parsed.units.filter(u => !/^(sources|references|bibliography)$/i.test(u.section.trim()));
  const results = [];
  const sem = criteria.filter(c => c.kind === 'semantic');
  let qv = [], uv = [];
  if (sem.length && units.length) { const v = await embedder.embed([...sem.map(c => c.params.question), ...units.map(u => u.text.slice(0, 1500))]); qv = v.slice(0, sem.length); uv = v.slice(sem.length); }
  for (const c of criteria) {
    if (c.kind === 'deterministic') { results.push({ id: c.id, text: c.text, method: 'deterministic', ...runDeterministic(c, evidence, parsed) }); continue; }
    const qi = sem.indexOf(c);
    const ranked = units.map((u, i) => ({ u, s: cosine(qv[qi], uv[i]) })).sort((a, b) => b.s - a.s).slice(0, 3);
    const top = ranked[0]?.s ?? 0; const refs = ranked.slice(0, 2).map(r => ({ ref: r.u.ref, quote: r.u.text.slice(0, 160), score: +r.s.toFixed(3) }));
    let verdict = top >= thresholds.pass ? 'pass' : top < thresholds.fail ? 'fail' : 'uncertain';
    let rationale = `best passage similarity ${top.toFixed(2)} (pass >= ${thresholds.pass}, fail < ${thresholds.fail})`;
    // Genuine answers add information, so they land well below a near-copy of the question. A passage that is
    // almost the question itself ("echo") is the classic keyword-stuffing attack: never auto-pass it.
    if (top >= thresholds.echo) { verdict = 'uncertain'; rationale += `; passage nearly restates the question (>= ${thresholds.echo}), possible keyword stuffing`; } let method = `semantic:${embedder.name}`;
    const at = expectedAnswerType(c.params.question);
    if (verdict === 'pass' && at && !ranked.some(r => at.re.test(r.u.text))) { verdict = 'fail'; rationale += `; question expects ${at.label} but the matching passages contain none`; }
    if (judge && verdict !== 'fail' && ranked.length) {
      const j = await judge.judge({ criterion: c, passages: ranked.map(r => ({ ref: r.u.ref, text: r.u.text })) });
      method += `+${judge.name}`;
      // Conservative combination: the judge can veto or downgrade, but cannot approve what retrieval did not find.
      if (j.verdict === 'fail') { verdict = 'fail'; rationale += `; judge: ${j.rationale}`; }
      else if (j.verdict === 'uncertain') { verdict = 'uncertain'; rationale += `; judge uncertain: ${j.rationale}`; }
      else { rationale += `; judge confirms (${j.refs.join(', ')}): ${j.rationale}`; if (j.refs.length) refs.sort((a, b) => j.refs.includes(b.ref) - j.refs.includes(a.ref)); }
    }
    results.push({ id: c.id, text: c.text, method, verdict, evidenceRefs: refs, rationale, score: +top.toFixed(3) });
  }
  const pass = results.filter(r => r.verdict === 'pass').length, unc = results.filter(r => r.verdict === 'uncertain').length;
  const semRes = results.filter(r => r.method !== 'deterministic'), semTotal = semRes.length, semFail = semRes.filter(r => r.verdict === 'fail').length;
  let decision, decisionReason;
  if (injection.suspicious) { decision = 'escalate'; decisionReason = `possible prompt injection: "${injection.hits[0]}"`; }
  else if (pass === results.length) { decision = 'capture'; decisionReason = `all ${results.length} frozen criteria passed`; }
  else if (pass / results.length < 0.5 || semFail * 2 > semTotal) { decision = 'void'; decisionReason = `${results.length - pass}/${results.length} criteria not met${semFail * 2 > semTotal ? ` (${semFail}/${semTotal} questions unanswered)` : ''}`; }
  else { decision = 'escalate'; decisionReason = unc ? `${unc} criteria uncertain` : 'partial delivery'; }
  let sourceCheck = null;
  if (sourceChecker) {
    try { sourceCheck = await sourceChecker.check(evidence, { embedder, keyRefs: [...new Set(results.filter(r => r.id.startsWith('Q-')).flatMap(r => r.evidenceRefs.map(e => e.ref)))],
      orderText: criteria.map(c => [c.params?.question, ...(c.params?.anchors || [])].filter(Boolean).join(' ')).join(' ') }); }
    catch (e) { sourceCheck = { enabled: true, ok: false, issues: [`source checker unavailable: ${e.message}`] }; }
    if (!sourceCheck.ok && decision !== 'void') { decision = 'escalate'; decisionReason += '; source support unverified: ' + sourceCheck.issues[0]; }
  }
  return { sourceCheck, criteriaHash, evidenceHash: await sha256Hex(canon(evidence)), results, injection, decision, decisionReason, models: { embedder: embedder.name, judge: judge?.name || null } };
}
