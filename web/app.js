import { connect } from './api.js';
import { verifyProof } from './src/core/proof.js';
import { Ledger } from './src/core/ledger.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = n => '$' + Number(n || 0).toFixed(2);
const DAY = 864e5;
let api, holds = [], current = null, grids = {};

const DELIVERIES = [['DEMO-A-source-faithful', 'Complete brief (figures as in sources)', 'ok'], ['A-good-1', 'Complete brief (paraphrased figures)'], ['A-adv-empty-sections', 'Empty sections'], ['A-adv-injection', 'Prompt injection'], ['A-adv-stuffing', 'Keyword stuffing'], ['A-adv-adjacent', 'Wrong topic (GDPR)']];
const presets = specs => ({
  'AI Act brief · $45': specs.A, 'SOC 2 brief · $60': specs.B,
  'Big order · $150 (needs human)': { ...specs.A, amount: 150 }, 'Over cap · $900': { ...specs.A, amount: 900 },
  'Malformed (extra payTo field)': { ...specs.A, payTo: 'attacker@example' },
});
const FLOW = ['Intent + policy', 'Authorization hold', 'Delivered', 'Verdict', 'Settled'];
function steps(h) {
  const s = h.state; const i = { DENIED: 0, AWAITING_HUMAN: 0, PROPOSED: 0, AWAITING_PAYER: 1, HELD: 2, VERIFYING: 3, ESCALATED: 3, CAPTURE_PENDING: 4, REFUND_PENDING: 4, RECONCILIATION_REQUIRED: 4, RELEASED: 5, REFUNDED: 5, VOIDED: h.verdict ? 5 : 2 }[s];
  const fail = ['DENIED', 'VOIDED', 'REFUNDED'].includes(s);
  return FLOW.map((n, k) => `<div class="${k < i ? 'done' : k === i ? (fail ? 'fail' : 'cur') : ''}">${n}${k === 4 && i === 5 ? (s === 'RELEASED' ? ' ✓ captured' : s === 'REFUNDED' ? ' ↺ refunded' : ' ✕ voided') : ''}</div>`).join('');
}
const pill = p => p.value ? `<span class="pill s-${p.value}">${String(p.value).replace('_', ' ')}</span>` : '';
// --- AG Grid custom cell widgets ---------------------------------------------------------
class HeldValueRenderer { // amount as a bar against the per-purchase cap; green when captured, red when returned
  init(p) { const cap = api.cfg.policy.perPurchaseLimit; const v = p.value || 0; const col = p.data?.state === 'RELEASED' ? '#9fe0c3' : ['VOIDED', 'REFUNDED', 'DENIED'].includes(p.data?.state) ? '#f6c3bc' : '#b9d2f7';
    this.e = document.createElement('div'); this.e.className = 'bar'; this.e.innerHTML = `<i style="width:${Math.min(100, v / cap * 100)}%;background:${col}"></i><b>${money(v)}</b>`; }
  getGui() { return this.e; } refresh() { return false; }
}
class AuthExpiryRenderer { // PayPal auth validity (29 d) with the 3-day honor period marked
  init(p) { this.e = document.createElement('div'); const h = p.data; const a = h?.paypal || {};
    if (!a.authExpiresAt || !['HELD', 'ESCALATED', 'VERIFYING'].includes(h.state)) { this.e.textContent = a.authorizationId ? (h.state === 'RELEASED' ? 'captured' : h.state === 'REFUNDED' ? 'refunded' : 'voided') : '—'; return; }
    const now = Date.now(), left = (Date.parse(a.authExpiresAt) - now) / DAY, honor = (Date.parse(a.honorEndsAt) - now) / DAY;
    const col = honor > 1 ? '#9fe0c3' : honor > 0 ? '#ffd98a' : '#f6c3bc';
    this.e.className = 'bar'; this.e.title = `authorization valid until ${a.authExpiresAt.slice(0, 10)}; honor period ends ${a.honorEndsAt.slice(0, 16).replace('T', ' ')}Z`;
    this.e.innerHTML = `<i style="width:${Math.max(2, left / 29 * 100)}%;background:${col}"></i><span class="honor" style="left:${3 / 29 * 100}%"></span><b style="padding-left:32px">${left.toFixed(1)} d left · honor ${honor > 0 ? honor.toFixed(1) + ' d' : 'over'}</b>`; }
  getGui() { return this.e; } refresh() { return false; }
}
class CriteriaRenderer { init(p) { const r = p.data?.verdict?.results; this.e = document.createElement('div'); if (!r) { this.e.textContent = p.data?.criteria ? `${p.data.criteria.length} frozen` : ''; return; }
  const ok = r.filter(x => x.verdict === 'pass').length; this.e.className = 'bar'; this.e.innerHTML = `<i style="width:${ok / r.length * 100}%;background:${ok === r.length ? '#9fe0c3' : '#ffd98a'}"></i><b>${ok}/${r.length} pass</b>`; } getGui() { return this.e; } refresh() { return false; } }
class ActionRenderer { init(p) { const h = p.data; this.e = document.createElement('div');
  const b = (t, cls, fn) => { const x = document.createElement('button'); x.className = 'cell-btn ' + cls; x.textContent = t; x.onclick = ev => { ev.stopPropagation(); run(fn); }; this.e.append(x); };
  if (h.state === 'ESCALATED') { b('Capture', 'ok', () => api.resolve(h.id, 'capture', 'reviewed')); b('Void', 'bad', () => api.resolve(h.id, 'void', 'evidence rejected')); }
  if (h.state === 'AWAITING_HUMAN') { b('Approve', 'ok', () => api.policyApprove(h.id, true)); b('Reject', 'bad', () => api.policyApprove(h.id, false)); } }
  getGui() { return this.e; } refresh() { return false; } }
class RefsRenderer { init(p) { this.e = document.createElement('span'); this.e.innerHTML = (p.value || []).map(r => `<span class="chip" title="${esc(r.quote)}">${esc(r.ref)}</span>`).join(''); } getGui() { return this.e; } refresh() { return false; } }

async function run(fn) { try { const h = await fn(); await refresh(h?.id || current); } catch (e) { alert(e.message); } }
const waitingFor = h => h.state === 'ESCALATED' ? `reviewer: ${h.verdict?.decisionReason || 'verifier error'}` : `buyer: ${h.policy?.reasons?.join('; ')}`;
async function refresh(openId) {
  holds = await api.list(); const ledger = await api.ledger();
  grids.holds.setGridOption('rowData', holds);
  const totals = { id: 'Total', topic: `${holds.length} holds`, amount: holds.filter(h => ['HELD', 'ESCALATED', 'AWAITING_PAYER'].includes(h.state)).reduce((s, h) => s + h.amount, 0) };
  grids.holds.setGridOption('pinnedBottomRowData', [totals]);
  grids.queue.setGridOption('rowData', holds.filter(h => ['ESCALATED', 'AWAITING_HUMAN'].includes(h.state)).map(h => ({ ...h, waiting: waitingFor(h), since: h.escalatedAt || h.createdAt })));
  grids.ledger.setGridOption('rowData', ledger.map(e => ({ ...e, ref: e.captureId || e.refundId || e.authorizationId || e.orderId || e.decision || e.evidenceHash?.slice(0, 16) || (e.reasons || e.errors || []).join('; ') || e.criteriaHash?.slice(0, 16) || '' })));
  $('#chain').textContent = `${ledger.length} receipts · head ${ledger.length ? ledger.at(-1).hash.slice(0, 16) + '…' : 'GENESIS'}`;
  const sum = st => holds.filter(h => st.includes(h.state)).reduce((s, h) => s + h.amount, 0);
  $('#stats').innerHTML = [[money(sum(['HELD', 'ESCALATED', 'AWAITING_PAYER'])), 'authorized, not captured'], [money(sum(['RELEASED'])), 'captured to merchant'], [money(sum(['VOIDED', 'REFUNDED'])), 'released back to buyers'],
    [holds.filter(h => ['ESCALATED', 'AWAITING_HUMAN'].includes(h.state)).length, 'waiting on a human'], [holds.filter(h => h.verdict?.injection?.suspicious).length, 'injection attempts caught']].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  if (openId) current = openId; if (current) renderHold(holds.find(h => h.id === current));
}
function act(label, cls, fn) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = async () => { b.disabled = true; await run(fn); b.disabled = false; }; return b; }
function renderHold(h) {
  const v = $('#holdview'); if (!h) return;
  v.className = '';
  grids.crit.setGridOption('rowData', h.verdict ? h.verdict.results : (h.criteria || []).map(c => ({ id: c.id, text: c.text, method: c.kind, verdict: 'pending', evidenceRefs: [] })));
  $('#drillTitle').textContent = `${h.id} · criteria hash ${h.criteriaHash ? h.criteriaHash.slice(0, 16) + '…' : '—'}${h.evidenceHash ? ` · evidence hash ${h.evidenceHash.slice(0, 16)}…` : ''}`;
  const pol = h.policy?.reasons?.length ? `<div class="alert ${h.state === 'DENIED' ? 'bad' : h.policy.decision === 'allow' ? 'good' : ''}">${h.state === 'DENIED' ? 'Blocked: ' : 'Policy: '}${esc(h.policy.reasons.join('; '))}</div>` : '';
  const inj = h.verdict?.injection?.suspicious ? `<div class="alert bad">⚠ The seller's delivery tried to instruct the verifier (“${esc(h.verdict.injection.hits[0])}”). Auto-capture is disabled; a reviewer decides.</div>` : '';
  const dec = h.verdict ? `<div class="alert ${h.verdict.decision === 'capture' ? 'good' : h.verdict.decision === 'void' ? 'bad' : ''}">Verdict: <b>${h.verdict.decision}</b> · ${esc(h.verdict.decisionReason)} · models: ${esc(h.verdict.models.embedder)}${h.verdict.models.judge ? ' + ' + esc(h.verdict.models.judge) : ''}</div>` : '';
  v.innerHTML = `<div class="steps">${steps(h)}</div>
   <dl class="kv"><dt>Hold</dt><dd>${h.id} ${pill({ value: h.state })}</dd><dt>Brief</dt><dd>${esc(h.topic)}</dd><dt>Amount</dt><dd>${money(h.amount)} ${h.currency} → seller <b>${esc(h.sellerId || '—')}</b></dd>
   <dt>PayPal order</dt><dd>${h.paypal?.orderId || '—'}</dd><dt>Authorization</dt><dd>${h.paypal?.authorizationId || '—'}${h.paypal?.authExpiresAt ? ` <small>(valid to ${h.paypal.authExpiresAt.slice(0, 10)}, honor period to ${h.paypal.honorEndsAt.slice(0, 10)})</small>` : ''}</dd>
   <dt>Capture</dt><dd>${h.paypal?.captureId || '—'}${h.paypal?.refundId ? ` · refund ${h.paypal.refundId}` : ''}</dd></dl>${pol}${dec}${inj}<div id="actions" class="box"></div>`;
  const a = $('#actions');
  if (h.state === 'AWAITING_HUMAN') a.append('Above the auto-approve threshold. Buyer: ', act('Approve order', 'ok', () => api.policyApprove(h.id, true)), act('Reject', 'bad', () => api.policyApprove(h.id, false)));
  else if (h.state === 'AWAITING_PAYER') {
    if (api.cfg.paypal === 'mock') a.append('Buyer approves the authorization on PayPal (simulated in mock mode). ', act('Approve with PayPal (sandbox sim)', 'pp', () => api.payerApprove(h.id)));
    else { const l = document.createElement('a'); l.href = h.paypal.approveUrl; l.innerHTML = '<button class="pp">Approve on PayPal sandbox →</button>'; a.append('Buyer approves on PayPal, then returns here. ', l); }
  } else if (h.state === 'HELD') { a.append('Funds are authorized on the buyer\'s PayPal. Seller (briefsmith) delivers: '); for (const [id, label, cls] of DELIVERIES) a.append(act(label, cls || '', () => api.deliver(h.id, api.cases.cases.find(c => c.id === id).evidence))); }
  else if (h.state === 'ESCALATED') a.append('Reviewer: ', act('Capture', 'ok', () => api.resolve(h.id, 'capture', 'reviewed manually')), act('Void hold', 'bad', () => api.resolve(h.id, 'void', 'evidence rejected')));
  else if (h.state === 'RELEASED') a.append('Captured. Buyer dispute: ', act('Refund', '', () => api.refund(h.id)));
  else a.append(['CAPTURE_PENDING', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'].includes(h.state) ? 'Payment status unconfirmed. Reconciliation retains the reservation and blocks duplicate settlement. ' : 'Final state. ');
  if (h.receipts?.length) a.append(act('Download signed proof', '', async () => { const p = await api.proof(h.id); const u = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); Object.assign(document.createElement('a'), { href: u, download: `trustrail-proof-${h.id}.json` }).click(); return h; }));
}
(async () => {
  api = await connect(m => { $('#status').hidden = !m; $('#status').textContent = m; });
  $('#badges').innerHTML = `<span>PayPal: ${api.cfg.paypal === 'mock' ? 'sandbox twin (mock)' : 'sandbox REST (live sandbox)'}</span><span>AI: ${esc(api.cfg.embedder)}${api.cfg.judge ? ' + ' + esc(api.cfg.judge) : ''}</span><span>Runs: ${api.cfg.backend}</span><span>Source check: ${esc(api.cfg.sourceCheck ?? 'off')}</span>`;
  const P = presets(api.cases.specs); let chosen = P['AI Act brief · $45'];
  const show = () => { $('#intentview').innerHTML = `<pre class="intent">${esc(JSON.stringify(chosen, null, 1))}</pre>`; };
  for (const [k, it] of Object.entries(P)) { const b = document.createElement('button'); b.textContent = k; b.onclick = () => { chosen = it; show(); }; $('#presets').append(b); }
  show(); $('#propose').onclick = () => run(() => api.propose(chosen));
  const dc = { sortable: true, filter: true, resizable: true };
  grids.holds = agGrid.createGrid($('#holdsGrid'), { rowData: [], defaultColDef: dc, rowHeight: 40, onRowClicked: e => { if (e.data?.criteria || e.data?.policy) { current = e.data.id; renderHold(e.data); } },
    columnDefs: [{ field: 'id', headerName: 'Hold', width: 90 }, { field: 'state', cellRenderer: pill, width: 145 }, { field: 'topic', headerName: 'Brief', flex: 2, minWidth: 200 }, { field: 'sellerId', headerName: 'Seller', width: 105 },
      { field: 'amount', headerName: 'Held value', width: 140, cellRenderer: HeldValueRenderer }, { headerName: 'Auth expiry / honor period', width: 230, cellRenderer: AuthExpiryRenderer, sortable: false, filter: false },
      { headerName: 'Criteria', width: 115, cellRenderer: CriteriaRenderer, sortable: false, filter: false }, { field: 'verdict.decision', headerName: 'Decision', width: 105 },
      { field: 'paypal.orderId', headerName: 'PayPal order', width: 175 }, { field: 'paypal.authorizationId', headerName: 'Authorization', width: 175 }, { field: 'paypal.captureId', headerName: 'Capture', width: 175 }],
    getRowStyle: p => p.node.rowPinned ? { fontWeight: 700, background: '#f4f6fb' } : p.data?.verdict?.injection?.suspicious ? { background: '#fff5f3' } : undefined });
  grids.queue = agGrid.createGrid($('#queueGrid'), { rowData: [], defaultColDef: dc, rowHeight: 38, overlayNoRowsTemplate: 'Nothing waiting on a human 🎉', onRowClicked: e => { current = e.data.id; renderHold(holds.find(h => h.id === current)); },
    columnDefs: [{ field: 'id', headerName: 'Hold', width: 90 }, { field: 'state', cellRenderer: pill, width: 145 }, { field: 'amount', width: 140, cellRenderer: HeldValueRenderer }, { field: 'waiting', headerName: 'Waiting on', flex: 2 },
      { field: 'since', headerName: 'Since (UTC)', width: 120, valueFormatter: p => p.value?.slice(11, 19) }, { headerName: 'Act', width: 160, cellRenderer: ActionRenderer, sortable: false, filter: false }] });
  grids.crit = agGrid.createGrid($('#critGrid'), { rowData: [], defaultColDef: dc, rowHeight: 36, columnDefs: [{ field: 'id', width: 85 }, { field: 'text', headerName: 'Frozen criterion', flex: 2, tooltipField: 'text' },
    { field: 'verdict', width: 105, cellRenderer: p => `<span class="v-${p.value}">${String(p.value).toUpperCase()}</span>` }, { field: 'evidenceRefs', headerName: 'Evidence refs', width: 170, cellRenderer: RefsRenderer, sortable: false, filter: false },
    { field: 'method', width: 200 }, { field: 'rationale', flex: 3, tooltipField: 'rationale' }] });
  grids.ledger = agGrid.createGrid($('#ledgerGrid'), { rowData: [], defaultColDef: dc, columnDefs: [
    { field: 'seq', width: 75, sort: 'desc' }, { field: 'at', headerName: 'Time (UTC)', width: 110, valueFormatter: p => p.value?.slice(11, 19) }, { field: 'holdId', headerName: 'Hold', width: 90 },
    { field: 'type', width: 175, cellStyle: p => ({ fontWeight: 600, color: /captured/.test(p.value) ? '#14895f' : /void|denied|refund|rejected/.test(p.value) ? '#c0392b' : /verdict|frozen/.test(p.value) ? '#1f5fbf' : '#0b1f3a' }) },
    { field: 'state', width: 140, cellRenderer: pill }, { field: 'ref', headerName: 'Detail / PayPal id', flex: 2 },
    { field: 'prev', headerName: 'Prev hash', width: 140, valueFormatter: p => p.value?.slice(0, 12) + '…' }, { field: 'hash', width: 140, valueFormatter: p => p.value?.slice(0, 12) + '…' }] });
  $('#csv').onclick = () => grids.ledger.exportDataAsCsv({ fileName: 'trustrail-ledger.csv' });
  $('#verifyChain').onclick = async () => {
    const entries = await api.ledger(); const c = await Ledger.verify(entries);
    let sig = ''; const anyHold = holds.find(h => h.receipts?.length);
    if (anyHold) { const p = await api.proof(anyHold.id); const r = await verifyProof(p, api.cfg.publicKey); sig = r.ok ? ` · ✓ ECDSA-signed checkpoint #${p.checkpoint.length} verifies` : ` · ✕ ${r.errors[0]}`; }
    $('#chain').textContent = c.ok ? `✓ chain valid · ${c.length} receipts${sig}` : `✕ chain broken at #${c.at}: ${c.reason}`;
  };
  $('#askReview').onclick = () => { // read-only: filters the grids, never acts
    const today = new Date().toISOString().slice(0, 10);
    const need = holds.filter(h => ['ESCALATED', 'AWAITING_HUMAN'].includes(h.state) && (h.escalatedAt || h.createdAt).slice(0, 10) === today);
    const honor = holds.filter(h => h.state === 'HELD' && h.paypal?.honorEndsAt && Date.parse(h.paypal.honorEndsAt) - Date.now() < DAY);
    grids.holds.setFilterModel({ id: { filterType: 'text', type: 'equals', filter: '' } }); grids.holds.setFilterModel(null);
    grids.holds.setGridOption('isExternalFilterPresent', () => true); grids.holds.setGridOption('doesExternalFilterPass', n => need.concat(honor).some(h => h.id === n.data.id)); grids.holds.onFilterChanged();
    $('#answer').hidden = false;
    $('#answer').innerHTML = `<b>${need.length} hold${need.length === 1 ? '' : 's'} need review today</b>${need.length ? ': ' + need.map(h => `${h.id} (${money(h.amount)}, ${esc(waitingFor(h))})`).join('; ') : ''}.${honor.length ? ` ${honor.length} more leave the PayPal honor period within 24 h.` : ''} <button id="clearAsk">Show all holds</button> <small>Read-only, rule-based query over grid data; it cannot approve or settle.</small>`;
    $('#clearAsk').onclick = () => { grids.holds.setGridOption('isExternalFilterPresent', () => false); grids.holds.onFilterChanged(); $('#answer').hidden = true; };
  };
  await refresh(location.hash.slice(1) || undefined);
})();
