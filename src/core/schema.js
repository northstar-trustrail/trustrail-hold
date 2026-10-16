// Strict schemas for the one use case Trustrail supports: AI agents buying research briefs.
// Anything an LLM produces is validated here before it can influence money.
import { sha256Hex, canon } from './hash.js';

const isStr = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isStrArr = (v, minN, maxN, minL, maxL) => Array.isArray(v) && v.length >= minN && v.length <= maxN && v.every(s => isStr(s, minL, maxL));

export const INTENT_FIELDS = ['kind', 'topic', 'questions', 'requiredSections', 'minSources', 'minDistinctDomains', 'minWords', 'maxWords', 'amount', 'currency', 'sellerId', 'deliverWithinHours'];

/** Returns { ok, errors, value } — value is a normalized copy (never the input object). */
export function validateIntent(x) {
  const e = [];
  if (!x || typeof x !== 'object') return { ok: false, errors: ['intent must be an object'] };
  const extra = Object.keys(x).filter(k => !INTENT_FIELDS.includes(k));
  if (extra.length) e.push(`unknown fields: ${extra.join(', ')}`);
  if (x.kind !== 'research_brief') e.push('kind must be "research_brief"');
  if (!isStr(x.topic, 5, 200)) e.push('topic: 5-200 chars');
  if (!isStrArr(x.questions, 1, 6, 8, 200)) e.push('questions: 1-6 strings of 8-200 chars');
  if (!isStrArr(x.requiredSections ?? [], 0, 8, 3, 60)) e.push('requiredSections: 0-8 strings of 3-60 chars');
  if (!isInt(x.minSources, 0, 20)) e.push('minSources: integer 0-20');
  if (!isInt(x.minDistinctDomains ?? 0, 0, 20) || (x.minDistinctDomains ?? 0) > x.minSources) e.push('minDistinctDomains: integer 0..minSources');
  if (!isInt(x.minWords, 50, 20000)) e.push('minWords: integer 50-20000');
  if (!isInt(x.maxWords, 50, 20000) || x.maxWords < x.minWords) e.push('maxWords: integer >= minWords');
  if (typeof x.amount !== 'number' || !(x.amount >= 0.01 && x.amount <= 10000) || Math.round(x.amount * 100) !== x.amount * 100) e.push('amount: 0.01-10000 with at most 2 decimals');
  if (x.currency !== 'USD') e.push('currency must be USD');
  if (!(typeof x.sellerId === 'string' && /^[a-z0-9][a-z0-9-]{1,31}$/.test(x.sellerId))) e.push('sellerId: lowercase slug');
  if (!isInt(x.deliverWithinHours, 1, 72)) e.push('deliverWithinHours: 1-72 (must fit the PayPal 3-day honor period)');
  if (e.length) return { ok: false, errors: e };
  return { ok: true, errors: [], value: { ...x, requiredSections: x.requiredSections ?? [], minDistinctDomains: x.minDistinctDomains ?? 0, topic: x.topic.trim(), questions: x.questions.map(s => s.trim()) } };
}

const deepFreeze = o => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

// Topic anchors: distinctive names in the topic (acronyms, names with digits: "EU AI Act", "SOC 2 Type II").
export function topicAnchors(topic) {
  const base = [...topic.matchAll(/\b(?:[A-Z][A-Za-z0-9]*\s?){1,4}/g)].map(m => m[0].trim()).filter(a => /[A-Z]{2,}|\d/.test(a) && a.length >= 3);
  const out = new Set(base); for (const a of base) { const w = a.split(' '); if (w.length >= 3) out.add(w.slice(1).join(' ')); } // "EU AI Act" also matches "AI Act"
  return [...out];
}

/** Criteria are derived once from the validated intent, frozen, and committed by hash. */
export async function freezeCriteria(intent) {
  const c = [];
  intent.requiredSections.forEach((s, i) => c.push({ id: `SEC-${i + 1}`, kind: 'deterministic', check: 'section', params: { heading: s, minWords: 25 }, text: `Has a non-empty "${s}" section (>= 25 words)` }));
  const anchors = topicAnchors(intent.topic);
  if (anchors.length) c.push({ id: 'TOPIC', kind: 'deterministic', check: 'topic', params: { anchors }, text: `Brief is about the ordered topic (mentions ${anchors.map(a => `"${a}"`).join(' or ')})` });
  c.push({ id: 'LEN', kind: 'deterministic', check: 'length', params: { min: intent.minWords, max: intent.maxWords }, text: `Body is ${intent.minWords}-${intent.maxWords} words` });
  if (intent.minSources > 0) c.push({ id: 'SRC', kind: 'deterministic', check: 'sources', params: { min: intent.minSources, minDomains: intent.minDistinctDomains }, text: `Cites >= ${intent.minSources} distinct http(s) sources from >= ${intent.minDistinctDomains} domains, each referenced in the text` });
  intent.questions.forEach((q, i) => c.push({ id: `Q-${i + 1}`, kind: 'semantic', check: 'answers', params: { question: q }, text: `Answers: ${q}` }));
  const criteriaHash = await sha256Hex(canon(c));
  return { criteria: deepFreeze(c), criteriaHash };
}

export function validateEvidence(ev) {
  const e = [];
  if (!ev || typeof ev !== 'object') return { ok: false, errors: ['evidence must be an object'] };
  if (!isStr(ev.body, 1, 60000)) e.push('body: markdown string up to 60k chars');
  if (ev.sources !== undefined && !(Array.isArray(ev.sources) && ev.sources.length <= 50 && ev.sources.every(s => s && isStr(s.url, 8, 500)))) e.push('sources: array of {url,title}');
  return e.length ? { ok: false, errors: e } : { ok: true, errors: [], value: { body: ev.body, sources: (ev.sources || []).map(s => ({ url: s.url, title: String(s.title || '').slice(0, 200) })) } };
}
