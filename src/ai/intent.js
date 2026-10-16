// Natural language -> research-brief intent. The LLM (if any) proposes JSON; the schema decides.
import { validateIntent } from '../core/schema.js';
const PROMPT = 'Convert the purchase request into JSON for a research-brief order: {"kind":"research_brief","topic":string,"questions":[string],"requiredSections":[string],"minSources":int,"minDistinctDomains":int,"minWords":int,"maxWords":int,"amount":number,"currency":"USD","sellerId":string,"deliverWithinHours":int}. Use only numbers stated in the request. JSON only.';

export function intentFromTextRules(text) {
  const num = (re, d) => { const m = text.match(re); return m ? Number(m[1]) : d; };
  const list = re => { const m = text.match(re); return m ? m[1].split(/;|,(?![^(]*\))/).map(s => s.trim().replace(/[.]$/, '')).filter(Boolean) : []; };
  return {
    kind: 'research_brief',
    topic: (text.match(/brief (?:on|about)\s+(.+?)(?:\s+for\s+\$|\s+from\s|[.;\n]|$)/i)?.[1] || '').trim(),
    questions: list(/answer(?:s|ing)?:\s*([^\n]+?)(?:\.\s+(?=[A-Z])|\n|$)/i),
    requiredSections: list(/sections?:\s*([^\n.]+)/i),
    minSources: num(/(\d+)\+?\s*sources/i, 0), minDistinctDomains: num(/(\d+)\s*(?:distinct\s*)?domains/i, 0),
    minWords: num(/(\d+)\s*[-–to]+\s*\d+\s*words/i, 300), maxWords: num(/\d+\s*[-–to]+\s*(\d+)\s*words/i, 1500),
    amount: num(/\$\s?(\d+(?:\.\d{1,2})?)/, NaN), currency: 'USD', sellerId: (text.match(/\bfrom\s+([a-z0-9][a-z0-9-]*)/i)?.[1] || '').toLowerCase(),
    deliverWithinHours: num(/within\s+(\d+)\s*h/i, 48),
  };
}

/** Returns { ok, value|errors, parser }. An amount that does not literally appear in the request is rejected. */
export async function parseIntent(input, { llm = null } = {}) {
  if (typeof input === 'object') return { ...validateIntent(input), parser: 'structured' };
  let cand, parser = 'rules';
  if (llm?.complete) { try { const t = await llm.complete(PROMPT, input, 300); cand = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); parser = llm.name; } catch { cand = null; } }
  if (!cand) cand = intentFromTextRules(input);
  const r = validateIntent(cand);
  if (r.ok && !new RegExp(`\\$\\s?${String(r.value.amount).replace('.', '\\.')}(\\.00?)?\\b`).test(input)) return { ok: false, errors: ['amount not stated in the request (possible hallucination)'], parser };
  return { ...r, parser };
}
