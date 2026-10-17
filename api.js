// One client, two backends: the Node server (PayPal sandbox REST or mock) with per-role bearer tokens,
// or the same HoldService running in the browser (GitHub Pages: mock PayPal + MiniLM in-browser).
export const ROLES = { agent: 'demo-agent', buyer: 'demo-buyer', seller: 'demo-seller', reviewer: 'demo-reviewer', auditor: 'demo-auditor' };
const json = async url => (await fetch(url)).json();
/** Browser source check reads bundled snapshots (the browser cannot fetch arbitrary sites); any other URL is unresolved. */
export async function snapshotFetcher() {
  const { sources } = await json('source-snapshots.json');
  return async url => { const s = sources[url]; if (!s) throw new Error('no bundled snapshot for this URL (browser demo cannot fetch live pages)'); return { status: s.status, text: s.text }; };
}
// Same vectors, computed once: the source passages are re-embedded for every delivery otherwise.
const memoEmbedder = e => { const cache = new Map(); return { name: e.name, load: () => e.load?.(), embed: async texts => {
  const miss = texts.filter(t => !cache.has(t)); if (miss.length) (await e.embed(miss)).forEach((v, i) => cache.set(miss[i], v)); return texts.map(t => cache.get(t)); } }; };

export async function connect(onStatus = () => {}, { seed = false } = {}) {
  const cases = await json('eval/cases.json');
  try { cases.cases.push(...(await json('demo-deliveries.json')).cases); } catch { /* optional */ }
  try {
    const r = await fetch('api/config'); if (!r.ok) throw 0; const cfg = await r.json();
    const call = (role, method, path, body) => fetch('api/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ROLES[role]}` }, body: body ? JSON.stringify(body) : undefined })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
    return { cases, cfg: { ...cfg, backend: 'server' },
      list: () => call('auditor', 'GET', 'holds'), checkpoints: () => call('auditor', 'GET', 'checkpoints'),
      propose: intent => call('agent', 'POST', 'holds', { intent }), policyApprove: (id, approve) => call('buyer', 'POST', `holds/${id}/policy-approval`, { approve }),
      payerApprove: id => call('buyer', 'POST', `holds/${id}/simulate-payer-approval`),
      deliver: (id, ev) => call('seller', 'POST', `holds/${id}/deliver`, ev), resolve: (id, decision, note) => call('reviewer', 'POST', `holds/${id}/resolve`, { decision, note }),
      refund: id => call('buyer', 'POST', `holds/${id}/refund`, { reason: 'buyer dispute' }), proof: id => call('auditor', 'GET', `holds/${id}/proof`),
      ledger: () => call('auditor', 'GET', 'ledger') };
  } catch {
    const [{ HoldService }, { MockPayPal }, emb, { DEMO }, { SourceChecker }] = await Promise.all([import('./src/core/holds.js'), import('./src/paypal/mock.js'), import('./src/ai/embed.js'), import('./roles.js'), import('./src/ai/source-check.js')]);
    let embedder;
    try { onStatus('Loading MiniLM sentence-embedding model in your browser (~23 MB, once)…'); embedder = memoEmbedder(await new emb.MiniLMEmbedder({ moduleUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5' }).load()); }
    catch (e) { console.warn(e); embedder = new emb.LexicalEmbedder(); }
    // Source checking is ON by default; ?sourceCheck=off turns it off for comparison.
    const sourceCheckOn = new URLSearchParams(location.search).get('sourceCheck') !== 'off';
    const fetchSource = sourceCheckOn ? await snapshotFetcher() : null;
    const A = DEMO; const c = x => structuredClone(x);
    let s, pp, samples = new Set();
    const fresh = async () => { pp = new MockPayPal(); s = await HoldService.create({ paypal: pp, embedder, baseUrl: location.origin, sourceChecker: sourceCheckOn ? new SourceChecker({ fetchSource }) : null }); samples = new Set(); };
    await fresh();
    const api = { cases, cfg: null,
      list: async () => c(s.list(A.auditor)).map(h => ({ ...h, sample: samples.has(h.id) })), checkpoints: async () => c({ publicKey: s.checkpoints.signer.pubJwk, checkpoints: s.checkpoints.list }),
      propose: async intent => c(await s.propose(A.agent, { intent })), policyApprove: async (id, approve) => c(await s.approvePolicy(A.buyer, id, { approve })),
      payerApprove: async id => { pp.approve(s.get(A.buyer, id).paypal.orderId); return c(await s.authorize(A.buyer, id)); },
      deliver: async (id, ev) => c(await s.deliver(A.seller, id, ev)), resolve: async (id, decision, note) => c(await s.resolve(A.reviewer, id, { decision, note })),
      refund: async id => c(await s.refund(A.buyer, id)), proof: async id => c(await s.proof(A.auditor, id)), ledger: async () => c(s.ledger.entries) };
    const setCfg = () => { api.cfg = { paypal: 'mock', embedder: embedder.name, judge: null, policy: s.policy, backend: 'browser', publicKey: s.checkpoints.signer.pubJwk,
      sourceCheck: sourceCheckOn ? 'on (bundled source snapshots)' : 'off (?sourceCheck=off)', samples: samples.size }; };
    /** Clearly labeled sample holds, created through the real flow (mock PayPal, real verifier) so the grids are not empty. */
    api.seedSamples = async () => {
      const ev = id => cases.cases.find(x => x.id === id).evidence; const A0 = cases.specs.A, B0 = cases.specs.B;
      const held = async (intent) => { const h = await s.propose(A.agent, { intent }); pp.approve(h.paypal.orderId); await s.authorize(A.buyer, h.id); samples.add(h.id); return h; };
      onStatus('Creating sample holds (mock PayPal, real verifier)…');
      const r = await held(A0); await s.deliver(A.seller, r.id, ev('DEMO-A-source-faithful'));
      const e = await held(A0); await s.deliver(A.seller, e.id, ev('A-good-1'));
      const v = await held(A0); await s.deliver(A.seller, v.id, ev('A-adv-empty-sections'));
      const i = await held({ ...A0, deliverWithinHours: 12 }); await s.deliver(A.seller, i.id, ev('A-adv-injection'));
      await held({ ...B0, deliverWithinHours: 6 });
      const big = await s.propose(A.agent, { intent: { ...A0, amount: 150 } }); samples.add(big.id);
      onStatus(''); setCfg();
    };
    api.reset = async () => { await fresh(); if (seed) await api.seedSamples(); setCfg(); };
    setCfg(); if (seed) await api.seedSamples(); onStatus('');
    return api;
  }
}
