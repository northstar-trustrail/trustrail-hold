// Parse a markdown research brief into addressable units, and run the deterministic checks.
// Evidence references look like "S2.P1" (section 2, paragraph 1) or "SRC3" (source 3).
const words = s => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g) || []).length;
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseBrief(body) {
  const sections = []; let cur = { idx: 0, heading: '(preamble)', paras: [] };
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
      if (h) { if (cur.paras.length || cur.idx) sections.push(cur); cur = { idx: sections.length + 1, heading: h[1], paras: [] }; continue; }
      const rest = lines.slice(i).join('\n').trim(); if (rest) cur.paras.push(rest); break;
    }
  }
  sections.push(cur);
  const units = [];
  sections.forEach(s => s.paras.forEach((p, j) => units.push({ ref: `S${s.idx}.P${j + 1}`, section: s.heading, text: p })));
  return { sections, units, wordCount: words(body.replace(/^#{1,3}\s+.*$/gm, '').replace(/https?:\/\/\S+/g, '')) };
}

const BAD_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid|local)$/;
export function extractSources(body, declared = []) {
  const found = [...body.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map(m => m[0].replace(/[.,;]+$/, ''));
  const all = [...declared.map(s => s.url), ...found]; const seen = new Map();
  for (const u of all) { try { const url = new URL(u); if (!/^https?:$/.test(url.protocol)) continue; const key = url.host.toLowerCase() + url.pathname.replace(/\/$/, ''); if (!seen.has(key)) seen.set(key, { url: u, host: url.host.toLowerCase().replace(/^www\./, '') }); } catch { /* skip */ } }
  return [...seen.values()].map((s, i) => ({ ...s, ref: `SRC${i + 1}` }));
}

export function runDeterministic(c, ev, parsed) {
  if (c.check === 'section') {
    const want = norm(c.params.heading);
    const s = parsed.sections.find(x => norm(x.heading) === want || norm(x.heading).includes(want));
    if (!s) return { verdict: 'fail', evidenceRefs: [], rationale: `no heading matching "${c.params.heading}"` };
    const w = words(s.paras.join(' ')); const refs = s.paras.length ? [{ ref: `S${s.idx}.P1`, quote: s.paras[0].slice(0, 120) }] : [{ ref: `S${s.idx}`, quote: s.heading }];
    return w >= c.params.minWords ? { verdict: 'pass', evidenceRefs: refs, rationale: `section "${s.heading}" has ${w} words` } : { verdict: 'fail', evidenceRefs: refs, rationale: `section "${s.heading}" has only ${w} words (< ${c.params.minWords})` };
  }
  if (c.check === 'topic') {
    const u = parsed.units.find(x => !/^(sources|references)$/i.test(x.section) && c.params.anchors.some(a => x.text.toLowerCase().includes(a.toLowerCase())));
    return u ? { verdict: 'pass', evidenceRefs: [{ ref: u.ref, quote: u.text.slice(0, 120) }], rationale: `mentions ${c.params.anchors.find(a => u.text.toLowerCase().includes(a.toLowerCase()))}` }
      : { verdict: 'fail', evidenceRefs: [], rationale: `never mentions ${c.params.anchors.join(' / ')} outside the source list` };
  }
  if (c.check === 'length') {
    const n = parsed.wordCount; const ok = n >= c.params.min && n <= c.params.max;
    return { verdict: ok ? 'pass' : 'fail', evidenceRefs: [{ ref: 'BODY', quote: `${n} words` }], rationale: `${n} words, required ${c.params.min}-${c.params.max}` };
  }
  if (c.check === 'sources') {
    const src = extractSources(ev.body, ev.sources); const bad = src.filter(s => BAD_HOSTS.test(s.host)); const good = src.filter(s => !BAD_HOSTS.test(s.host));
    const cited = good.filter(s => ev.body.includes(s.url) || ev.body.includes(s.host)); const domains = new Set(cited.map(s => s.host));
    const ok = cited.length >= c.params.min && domains.size >= c.params.minDomains;
    return { verdict: ok ? 'pass' : 'fail', evidenceRefs: cited.slice(0, 8).map(s => ({ ref: s.ref, quote: s.url })),
      rationale: `${cited.length} cited sources across ${domains.size} domains (need ${c.params.min}/${c.params.minDomains})${bad.length ? `; rejected placeholder hosts: ${bad.map(b => b.host).join(', ')}` : ''}${good.length > cited.length ? `; ${good.length - cited.length} listed but never referenced in text` : ''}` };
  }
  throw new Error(`unknown deterministic check ${c.check}`);
}
