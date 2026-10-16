// One client interface, two backends: the Node server (real PayPal sandbox or mock),
// or a fully in-browser engine (GitHub Pages demo; mock PayPal + rule verifier).
export async function connect() {
  try {
    const r = await fetch('api/config'); if (!r.ok) throw 0;
    const cfg = await r.json();
    const call = async (method, path, body) => { const r = await fetch('api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
    return { cfg: { ...cfg, backend: 'server' },
      list: () => call('GET', 'holds'), ledger: () => call('GET', 'ledger'), propose: b => call('POST', 'holds', b), human: (id, b) => call('POST', `holds/${id}/human`, b),
      payerApprove: id => cfg.paypal === 'mock' ? call('POST', `holds/${id}/simulate-approval`) : null,
      deliver: (id, ev) => call('POST', `holds/${id}/deliver`, ev), resolve: (id, b) => call('POST', `holds/${id}/resolve`, b), refund: (id, b) => call('POST', `holds/${id}/refund`, b), proof: id => call('GET', `holds/${id}/proof`) };
  } catch {
    const [{ Escrow }, { MockPayPal }, { RuleBrain }] = await Promise.all([import('./src/core/escrow.js'), import('./src/paypal/mock.js'), import('./src/ai/llm.js')]);
    const pp = new MockPayPal(); const e = new Escrow({ paypal: pp, brain: RuleBrain, baseUrl: location.origin });
    const c = x => structuredClone(x);
    return { cfg: { paypal: 'mock', ai: RuleBrain.name, policy: e.policy, backend: 'browser' },
      list: async () => c(e.list()), ledger: async () => c(e.ledger.entries), propose: async b => c(await e.propose(b)), human: async (id, b) => c(await e.approveByHuman(id, b)),
      payerApprove: async id => { pp.approve(e.get(id).paypal.orderId); return c(await e.authorize(id)); },
      deliver: async (id, ev) => c(await e.deliver(id, ev)), resolve: async (id, b) => c(await e.resolve(id, b)), refund: async (id, b) => c(await e.refund(id, b)), proof: async id => c(await e.proof(id)) };
  }
}
