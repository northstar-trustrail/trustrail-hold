import { extractSources, parseBrief } from '../core/brief.js';
import { cosine } from './embed.js';
import { VERIFIER_CONFIG } from './verifier-config.js';

export function readableText(html) {
  return html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}
const splitSentences = text => text.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/).map(s => s.trim()).filter(Boolean);
// Strip URLs, citation markers and "Source:" labels so they are not mistaken for claims, numbers or entities.
const clean = s => s.replace(/https?:\/\/[^\s)\]]+/g, ' ').replace(/\[\d+\]/g, ' ').replace(/\b(Sources?|References?):\s*$/i, ' ').replace(/\s+/g, ' ').trim();
// Typographic dashes/quotes and accents normalized so "Torrijos–Carter" matches "Torrijos-Carter".
export const normText = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').toLowerCase();

const STOP = new Set(['The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'Its', 'In', 'On', 'At', 'For', 'By', 'Of', 'And', 'But', 'Or', 'If', 'As', 'After', 'Before', 'During', 'Since', 'When', 'While', 'Although', 'Because', 'Following', 'Under', 'With', 'Without', 'Soon', 'Early', 'Later', 'Today', 'Anyone', 'Readers', 'Writers', 'Teams', 'Some', 'Many', 'Most', 'Each', 'Every', 'All', 'Both', 'Such', 'There', 'Their', 'They', 'We', 'Our', 'You', 'Your', 'He', 'She', 'His', 'Her', 'I', 'Note', 'For example', 'Source', 'Sources', 'Findings', 'Implications', 'However', 'Also', 'Then', 'Thus', 'Therefore']);
/** Numbers as written facts: "3,600" -> "3600", "2.4" stays, years, ids like STS-31 -> "31". */
// Scale words and space-grouped thousands are normalized: "EUR 7.5 million" == "EUR 7 500 000", "35m" == "35 000 000".
const SCALE = { thousand: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };
const scaled = (n, unit) => String(Math.round(Number(n) * SCALE[unit.toLowerCase()]));
export function numbersIn(s) {
  const t = clean(s).replace(/(?<![\w.])(\d{1,3})((?:[ \u00a0\u202f]\d{3})+)(?![\d])/g, (_, a, b) => a + b.replace(/\D/g, ''))
    .replace(/(?<![\w.])(\d+(?:\.\d+)?)(?:\s?(thousand|million|billion)|(m|bn))\b/gi, (_, n, word, glued) => scaled(n, word || glued)); // "2.4 m" (metres) is left alone
  return [...t.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,(?=\d{3}\b)/g, '').replace(/[.,]$/, ''));
}
/** Named entities: capitalized sequences (not a lone sentence-initial word), acronyms and identifiers. */
export function entitiesIn(s) {
  const text = clean(s); const out = new Set();
  for (const m of text.matchAll(/\b[A-Z][\w'-]*(?:\s+(?:of|de|du|von|van|the)?\s*[A-Z][\w'-]*)*/g)) {
    const words = m[0].split(/\s+/).filter(w => !/^(of|de|du|von|van|the)$/.test(w));
    const initial = m.index === 0 || /[.!?:"“]\s*$/.test(text.slice(0, m.index));
    const kept = words.filter((w, i) => !(i === 0 && STOP.has(w)));
    if (!kept.length) continue;
    if (initial && kept.length === 1 && words.length === 1 && !/[A-Z].*[A-Z]|\d/.test(kept[0])) continue; // lone capitalized first word
    for (const w of kept) if (w.length > 1 && !STOP.has(w)) out.add(w.replace(/'s$/, ''));
  }
  return [...out];
}
const quotesIn = s => [...s.matchAll(/["“]([^"”]{12,})["”]/g)].map(m => m[1]);
/**
 * A factual claim states a number, date, quotation or a named entity that the order itself did not supply.
 * Restating the ordered topic ("DNS TTL cache behavior.") is not a fact. Other sentences are opinion/implication
 * and need no citation.
 */
export function isFactual(s, orderText = '') {
  const given = normText(orderText);
  return numbersIn(s).length > 0 || quotesIn(s).length > 0 || entitiesIn(s).some(e => !given.includes(normText(e)));
}

// Similarity is evidence retrieval, not logical entailment. Numbers and named entities are cross-checked
// literally against the cited source; this catches changed figures and swapped names, not every contradiction.
export class SourceChecker {
  constructor({ fetchSource, config = VERIFIER_CONFIG.source } = {}) { Object.assign(this, { fetchSource, config }); }
  async check(evidence, { embedder, keyRefs = [], orderText = '' } = {}) {
    const cfg = this.config;
    const sources = extractSources(evidence.body, evidence.sources);
    const issues = [], documents = [], claims = [];
    if (!sources.length) issues.push('no cited URLs to check');
    if (sources.length > cfg.maxSources) issues.push('citation count exceeds source-check limit');
    for (const s of sources.slice(0, cfg.maxSources)) {
      try {
        if (!this.fetchSource) throw new Error('source transport unavailable offline');
        const doc = await this.fetchSource(s.url, cfg);
        if (doc.status !== 200) throw new Error(`HTTP ${doc.status}`);
        if (new TextEncoder().encode(doc.text).length > cfg.maxBytes) throw new Error('citation size cap');
        const text = readableText(doc.text);
        const passages = splitSentences(text).filter(t => t.length > 20).slice(0, cfg.maxPassages);
        if (!passages.length) throw new Error('no readable supporting passages');
        documents.push({ ...s, resolved: true, passages, norm: normText(text) });
      } catch (e) { documents.push({ ...s, resolved: false, error: e.message }); issues.push(`${s.ref}: ${e.message}`); }
    }
    const semantic = embedder?.name.startsWith('minilm:');
    if (!semantic) issues.push('MiniLM unavailable: citation support unverified');
    const units = parseBrief(evidence.body).units.filter(u => !/^(sources|references|bibliography)$/i.test(u.section));
    const candidates = units.flatMap(u => splitSentences(u.text).map(raw => ({ ref: u.ref, key: keyRefs.includes(u.ref), raw, text: clean(raw) })))
      .filter(c => c.text.split(/\s+/).length >= 4 && isFactual(c.text, orderText));
    if (candidates.length > cfg.maxClaims) issues.push('factual claims exceed source-check limit');
    const resolved = documents.filter(d => d.resolved);
    const passages = resolved.flatMap(d => d.passages.map(text => ({ ref: d.ref, url: d.url, text, norm: normText(text), doc: d })));
    let pv = null;
    if (semantic && passages.length && candidates.length) {
      try { pv = await embedder.embed(passages.map(p => p.text.slice(0, 1500))); } catch (e) { issues.push(`source embeddings unavailable: ${e.message}`); }
    }
    for (const claim of candidates.slice(0, cfg.maxClaims)) {
      const problems = []; let ranked = [];
      if (pv) {
        const [cv] = await embedder.embed([claim.text]);
        ranked = passages.map((p, i) => ({ ...p, score: cosine(cv, pv[i]) })).sort((a, b) => b.score - a.score);
      }
      const best = ranked[0];
      if (!best || best.score < cfg.support) problems.push(best ? `best passage similarity ${best.score.toFixed(2)} < ${cfg.support}` : 'no source passage');
      if (best) {
        const window = ranked.slice(0, cfg.numberWindow).map(p => p.norm).join(' ');
        const windowNums = new Set(numbersIn(window));
        const missingNums = numbersIn(claim.text).filter(n => !windowNums.has(n));
        if (missingNums.length) problems.push(`number ${missingNums.join(', ')} not in the matching source passages`);
        const docText = resolved.map(d => d.norm).join(' '), given = normText(orderText);
        // Terms the buyer's own order supplied (topic anchors, question wording) are context, not seller claims.
        const missingEnts = entitiesIn(claim.text).filter(e => !docText.includes(normText(e)) && !given.includes(normText(e)));
        if (missingEnts.length) problems.push(`entity ${missingEnts.join(', ')} not found in cited sources`);
      }
      const supported = !problems.length;
      claims.push({ ref: claim.ref, text: claim.text, key: claim.key, supported, problems, sourceRef: best?.ref, url: best?.url, score: best ? +best.score.toFixed(3) : null, passage: best?.text.slice(0, 400) });
      if (!supported) issues.push(`${claim.ref}: ${problems.join('; ')} ("${claim.text.slice(0, 80)}")`);
    }
    // Padding has no checkable facts. Require at least one supported factual claim in a question-answering paragraph.
    const keyed = claims.filter(c => c.supported && (c.key || !keyRefs.length));
    if (!keyed.length) issues.push('no supported factual claim in the paragraphs that answer the questions');
    return { enabled: true, ok: !issues.length, method: semantic ? 'claim-level: MiniLM passage retrieval + literal number/entity cross-check' : 'unverified (MiniLM unavailable)',
      threshold: cfg.support, documents: documents.map(({ passages, norm, ...d }) => d), claims, issues };
  }
}
