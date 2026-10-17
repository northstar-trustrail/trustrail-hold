import { extractSources, parseBrief } from '../core/brief.js';
import { cosine } from './embed.js';
import { VERIFIER_CONFIG } from './verifier-config.js';

export function readableText(html) {
  return html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}
const sentences = text => text.replace(/https?:\/\/[^\s)]+/g, '').split(/(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 6);

// Similarity is evidence retrieval, not logical entailment or proof of factual truth.
export class SourceChecker {
  constructor({ fetchSource, config = VERIFIER_CONFIG.source } = {}) { Object.assign(this, { fetchSource, config }); }
  async check(evidence, { embedder, keyRefs = [] } = {}) {
    const sources = extractSources(evidence.body, evidence.sources);
    const issues = [], documents = [], claims = [];
    if (!sources.length) issues.push('no cited URLs to check');
    if (sources.length > this.config.maxSources) issues.push('citation count exceeds source-check limit');
    for (const s of sources.slice(0, this.config.maxSources)) {
      try {
        if (!this.fetchSource) throw new Error('source transport unavailable offline');
        const doc = await this.fetchSource(s.url, this.config);
        if (doc.status !== 200) throw new Error(`HTTP ${doc.status}`);
        // Apply the cap even for injected/offline transports.
        if (new TextEncoder().encode(doc.text).length > this.config.maxBytes) throw new Error('citation size cap');
        const text = readableText(doc.text);
        const passages = text.split(/(?<=[.!?])\s+(?=[A-Z])/).map(t => t.trim()).filter(t => t.length > 20).slice(0, 120);
        if (!passages.length) throw new Error('no readable supporting passages');
        documents.push({ ...s, resolved: true, passages });
      } catch (e) { documents.push({ ...s, resolved: false, error: e.message }); issues.push(`${s.ref}: ${e.message}`); }
    }
    const semantic = embedder?.name.startsWith('minilm:');
    if (!semantic) issues.push('MiniLM unavailable: citation support unverified');
    const units = parseBrief(evidence.body).units.filter(u => !/^(sources|references|bibliography)$/i.test(u.section) && (!keyRefs.length || keyRefs.includes(u.ref)));
    const candidates = units.flatMap(u => sentences(u.text).map(text => ({ ref: u.ref, text,
      cited: sources.filter((s, i) => u.text.includes(s.url) || u.text.includes(`[${i + 1}]`)).map(s => s.ref) })));
    if (!candidates.length) issues.push('no key claim sentences to check');
    if (candidates.length > this.config.maxClaims) issues.push('key claims exceed source-check limit');
    for (const claim of candidates.slice(0, this.config.maxClaims)) {
      let best = null;
      const passages = documents.filter(d => d.resolved && claim.cited.includes(d.ref)).flatMap(d => d.passages.map(text => ({ ref: d.ref, url: d.url, text })));
      if (semantic && passages.length) {
        try {
          const vectors = await embedder.embed([claim.text, ...passages.map(p => p.text.slice(0, 1500))]);
          best = passages.map((p, i) => ({ ...p, score: cosine(vectors[0], vectors[i + 1]) })).sort((a, b) => b.score - a.score)[0];
        } catch (e) { issues.push(`source embeddings unavailable: ${e.message}`); }
      }
      const supported = !!best && best.score >= this.config.support;
      claims.push({ ...claim, supported, sourceRef: best?.ref, url: best?.url, score: best?.score, passage: best?.text.slice(0, 400) });
      if (!supported) issues.push(`${claim.ref}: unsupported claim (${claim.cited.length ? 'no matching passage' : 'missing local citation'})`);
    }
    return { enabled: true, ok: !issues.length, method: semantic ? 'MiniLM passage similarity' : 'unverified (MiniLM unavailable)', threshold: this.config.support,
      documents: documents.map(({ passages, ...d }) => d), claims, issues };
  }
}
