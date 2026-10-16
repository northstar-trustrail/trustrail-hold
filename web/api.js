// One client, two backends: the Node server (PayPal sandbox REST or mock) with per-role bearer tokens,
// or the same HoldService running in the browser (GitHub Pages: mock PayPal + MiniLM in-browser).
export const ROLES = { agent: 'demo-agent', buyer: 'demo-buyer', seller: 'demo-seller', reviewer: 'demo-reviewer', auditor: 'demo-auditor' };
export async function connect(onStatus = () => {}) {
  const cases = await (await fetch('eval/cases.json')).json();
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
    const [{ HoldService }, { MockPayPal }, emb, { DEMO }] = await Promise.all([import('./src/core/holds.js'), import('./src/paypal/mock.js'), import('./src/ai/embed.js'), import('./roles.js')]);
    let embedder;
    try { onStatus('Loading MiniLM sentence-embedding model in your browser (~23 MB, once)…'); embedder = await new emb.MiniLMEmbedder({ moduleUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5' }).load(); }
    catch (e) { console.warn(e); embedder = new emb.LexicalEmbedder(); }
    onStatus('');
    const pp = new MockPayPal(); const s = await HoldService.create({ paypal: pp, embedder, baseUrl: location.origin }); const c = x => structuredClone(x);
    const A = DEMO;
    return { cases, cfg: { paypal: 'mock', embedder: embedder.name, judge: null, policy: s.policy, backend: 'browser', publicKey: s.checkpoints.signer.pubJwk },
      list: async () => c(s.list(A.auditor)), checkpoints: async () => c({ publicKey: s.checkpoints.signer.pubJwk, checkpoints: s.checkpoints.list }),
      propose: async intent => c(await s.propose(A.agent, { intent })), policyApprove: async (id, approve) => c(await s.approvePolicy(A.buyer, id, { approve })),
      payerApprove: async id => { pp.approve(s.get(A.buyer, id).paypal.orderId); return c(await s.authorize(A.buyer, id)); },
      deliver: async (id, ev) => c(await s.deliver(A.seller, id, ev)), resolve: async (id, decision, note) => c(await s.resolve(A.reviewer, id, { decision, note })),
      refund: async id => c(await s.refund(A.buyer, id)), proof: async id => c(await s.proof(A.auditor, id)), ledger: async () => c(s.ledger.entries) };
  }
}
