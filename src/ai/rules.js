import { scanInjection } from './guard.js';
// Deterministic offline "model": used in tests, the static demo, and as the fallback when no LLM is configured.
const STOP = new Set('a an the and or of to in on for with must should be is are it its that this has have include includes including contain contains containing at least most no more than per each as by from into'.split(' '));
const words = s => (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) || []);
const keyTerms = s => [...new Set(words(s).filter(w => !STOP.has(w) && w.length > 2 && !/^\d+$/.test(w)))];

export function parseIntentRules(text) {
  const amt = text.match(/\$\s?(\d+(?:\.\d{1,2})?)/) || text.match(/(\d+(?:\.\d{1,2})?)\s?(usd|dollars)/i);
  const merchant = text.match(/\bfrom\s+([a-z0-9][\w.-]*)/i);
  const cat = /gift ?card/i.test(text) ? 'gift_cards' : /crypto|bitcoin|token sale/i.test(text) ? 'crypto' : /bet|casino/i.test(text) ? 'gambling' : 'services';
  const [head, ...rest] = text.split(/\b(?:it must|must|requirements?:|criteria:|acceptance:)\b/i);
  const criteria = rest.join(' ').split(/;|\n|,\s*(?=(?:and\s+)?(?:at least|include|in |be |no |under|with|contain|mention|cover))|\band\b(?=\s+(?:at least|include|be |no |under|contain|mention|cover))/i)
    .map(s => s.replace(/^[\s.:-]+|[\s.]+$/g, '')).filter(s => s.length > 3);
  const item = head.replace(/\$\s?\d+(\.\d+)?/, '').replace(/\bfrom\s+[\w.-]+/i, '').replace(/^(please\s+)?(buy|order|get|purchase|hire)\s+(me\s+)?/i, '').replace(/\b(for|up to|max)\s*$/i, '').trim().replace(/[\s,.]+$/, '');
  return { item: item || 'unspecified item', amount: amt ? Number(amt[1]) : null, currency: 'USD', merchantId: merchant ? merchant[1].toLowerCase().replace(/[.-]+$/, '') : 'unknown', category: cat, criteria };
}

function checkOne(criterion, ev) {
  const text = ev.text || ''; const lw = words(text); const c = criterion.toLowerCase();
  const min = c.match(/at least (\d+)\s*([a-z]+)/);
  if (min) {
    const nNeed = +min[1]; const unit = min[2];
    const have = unit === 'words' ? lw.length : /^(files?|images?|attachments?|artifacts?)$/.test(unit) ? (ev.artifacts || []).length : (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
    return { pass: have >= nNeed, reason: `${have} ${unit} found, need ${nNeed}` };
  }
  const max = c.match(/(?:no more than|under|at most) (\d+)\s*words/);
  if (max) return { pass: lw.length <= +max[1], reason: `${lw.length} words, limit ${max[1]}` };
  const fmt = c.match(/\b(?:in|as)\s+(pdf|csv|json|markdown|png|svg|mp4)\b/);
  if (fmt) { const ok = (ev.artifacts || []).some(a => a.name?.toLowerCase().endsWith('.' + (fmt[1] === 'markdown' ? 'md' : fmt[1]))); return { pass: ok, reason: ok ? `${fmt[1]} artifact present` : `no .${fmt[1]} artifact delivered` }; }
  const terms = keyTerms(criterion); const set = new Set(lw.concat((ev.artifacts || []).flatMap(a => words(a.name || ''))));
  const hit = terms.filter(t => set.has(t) || [...set].some(w => w.startsWith(t.slice(0, Math.max(4, t.length - 2)))));
  const ratio = terms.length ? hit.length / terms.length : 0;
  return { pass: ratio >= 0.6, reason: `covers ${hit.length}/${terms.length} key terms${terms.length - hit.length ? ' (missing: ' + terms.filter(t => !hit.includes(t)).join(', ') + ')' : ''}` };
}

export function verifyRules(criteria, evidence) {
  const inj = scanInjection([evidence.text, ...(evidence.artifacts || []).map(a => a.name)].join('\n'));
  const results = criteria.map(c => ({ criterion: c, ...checkOne(c, evidence) }));
  const passed = results.filter(r => r.pass).length;
  let verdict = passed === results.length ? 'release' : passed === 0 ? 'refund' : 'escalate';
  if (inj.suspicious) verdict = 'escalate';
  return { verdict, confidence: results.length ? +(passed / results.length).toFixed(2) : 0, results, injection: inj, model: 'rules-v1' };
}
