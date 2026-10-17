import { connect } from './api.js';
import { operationRow, reviewViewResult, validateReviewView, matchesReviewView } from './src/core/operations.js';
import { parseBrief } from './src/core/brief.js';
const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const reviewDrafts = new Map();
let api, holds = [], rows = [], selectedId, selectedCriterion, plan = null, grids = {}, refreshing = false, actionBusy = false;
const state = p => el('span', (p.value || '').replaceAll('_', ' '), 'ops-state ' + (['ESCALATED', 'AWAITING_HUMAN', 'RECONCILIATION_REQUIRED', 'CAPTURE_PENDING', 'REFUND_PENDING'].includes(p.value) ? 'warning' : p.value === 'RELEASED' ? 'success' : p.data?.unresolved === 'no' ? 'final' : ''));
class ExposureRenderer {
  init(p) {
    this.node = el('div', null, 'exposure-cell'); this.node.append(el('span', money(p.value)));
    const track = el('span', null, 'exposure-track'), fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, 100 * p.value / (api.cfg.policy.perPurchaseLimit || 200)))}%`; track.append(fill); this.node.append(track);
  }
  getGui() { return this.node; } refresh() { return false; }
}
class CountdownRenderer {
  init(p) { this.node = el('div'); this.data = p.data; this.paint(); this.timer = setInterval(() => this.paint(), 1000); }
  paint() {
    const seconds = Math.floor((Date.parse(this.data.nextAt) - Date.now()) / 1000);
    this.node.className = 'ops-countdown' + (seconds < 0 ? ' overdue' : ''); this.node.replaceChildren();
    const value = Number.isFinite(seconds) ? `${seconds < 0 ? 'Overdue ' : ''}${Math.floor(Math.abs(seconds) / 3600)}h ${Math.floor(Math.abs(seconds) % 3600 / 60)}m ${Math.abs(seconds) % 60}s` : 'No pending clock';
    this.node.append(el('strong', value), el('small', this.data.nextClock));
  }
  getGui() { return this.node; } refresh() { return false; } destroy() { clearInterval(this.timer); }
}
class EvidenceRefsRenderer {
  init(p) {
    this.node = el('div', null, 'ops-refs');
    for (const ref of p.value || []) {
      const b = el('button', ref.ref, 'ref-button'); b.title = ref.quote || 'Inspect linked evidence';
      b.onclick = e => { e.stopPropagation(); selectedCriterion = p.data; renderEvidence(ref.ref); $('evidenceTitle').scrollIntoView({ behavior: 'instant', block: 'start' }); };
      this.node.append(b);
    }
  }
  getGui() { return this.node; } refresh() { return false; }
}
function updateLocation(values) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(values)) { if (value == null) params.delete(key); else params.set(key, String(value)); }
  history.replaceState(null, '', `${location.pathname}${params.size ? '?' + params.toString() : ''}`);
}
function notify(message, error = false) { $('status').hidden = !message; $('status').textContent = message; $('status').classList.toggle('error', error); }
function theme() {
  const dark = document.body.dataset.theme === 'dark';
  return agGrid.themeQuartz.withParams({ backgroundColor: dark ? '#192d39' : '#ffffff', foregroundColor: dark ? '#e3edf2' : '#142b37',
    headerBackgroundColor: dark ? '#223c4b' : '#edf3f5', headerTextColor: dark ? '#d6e7ee' : '#244453', borderColor: dark ? '#3b505c' : '#d8e2e7',
    accentColor: dark ? '#89c9b2' : '#247561', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, rowHoverColor: dark ? '#284454' : '#eef7f3', wrapperBorderRadius: 8 });
}
function visibleRows() { return plan ? rows.filter(r => matchesReviewView(r, plan)) : rows; }
function updateRows() {
  rows = holds.map(h => ({ ...operationRow(h), sample: !!h.sample }));
  grids.operations.setGridOption('rowData', rows);
  grids.review.setGridOption('rowData', visibleRows().filter(r => r.reviewNeeded));
  const unresolved = rows.filter(r => r.unresolved === 'yes');
  const pending = rows.filter(r => ['CAPTURE_PENDING', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'].includes(r.state));
  const near = rows.filter(r => r.unresolved === 'yes' && Number.isFinite(r.hoursRemaining) && r.hoursRemaining <= 24);
  $('exposure').replaceChildren();
  for (const [value, label, detail] of [[money(unresolved.reduce((s, r) => s + r.exposure, 0)), 'Budget still reserved', `${unresolved.length} unresolved holds`],
    [money(rows.filter(r => r.paypal?.captureStatus === 'COMPLETED' && r.paypal?.refundStatus !== 'COMPLETED').reduce((s, r) => s + r.amount, 0)), 'Captured, not refunded', 'PayPal capture COMPLETED'],
    [String(near.length), 'Due within 24 hours', 'Includes overdue holds'], [String(pending.length), 'Payment status unresolved', 'Pending or needs reconciliation']]) {
    const card = el('div', null, 'stat'); card.append(el('b', value), el('span', label), el('br'), el('small', detail)); $('exposure').append(card);
  }
  $('queueCount').textContent = `${visibleRows().filter(r => r.reviewNeeded).length} holds${plan ? ' in agent view' : ''}`;
  updateViewCount(); if (selectedId) renderSelection();
}
function updateViewCount() { $('viewCount').textContent = `${grids.operations?.getDisplayedRowCount() || 0} of ${rows.length} holds`; }
async function refresh() {
  if (refreshing || actionBusy) return; refreshing = true; $('refresh').disabled = true;
  try { holds = await api.list(); updateRows(); }
  catch (e) { notify(e.message, true); }
  finally { refreshing = false; $('refresh').disabled = false; }
}
function selectHold(h) { if (!h) return; selectedId = h.id; selectedCriterion = null; renderSelection(); }
function renderSelection() {
  const h = holds.find(h => h.id === selectedId); if (!h) return;
  $('selectionTitle').textContent = `${h.id} | ${h.topic}`;
  const detail = $('selectionDetail'); detail.replaceChildren();
  const dl = el('dl', null, 'kv');
  for (const [key, value] of [['State', h.state], ['Amount', `${money(h.amount)} ${h.currency}`], ['Deliverer', h.sellerId], ['PayPal capture', h.paypal?.captureId || 'None'], ['Capture status', h.paypal?.captureStatus || 'Unconfirmed'], ['Criteria hash', h.criteriaHash?.slice(0, 20) || 'None'], ['Evidence hash', h.evidenceHash?.slice(0, 20) || 'No delivery']]) dl.append(el('dt', key), el('dd', value));
  detail.append(dl);
  const criteria = h.verdict?.results || (h.criteria || []).map(c => ({ ...c, verdict: 'pending', method: c.kind, evidenceRefs: [], rationale: 'Awaiting delivery' }));
  grids.criteria.setGridOption('rowData', criteria);
  const controls = $('reviewActions'); controls.replaceChildren();
  const addAction = (label, cls, fn) => {
    const button = el('button', label, cls); button.disabled = actionBusy;
    button.onclick = async () => {
      if (actionBusy) return; actionBusy = true; renderSelection();
      try { await fn(); notify('Action recorded. Payment state follows PayPal confirmation.'); }
      catch (e) { notify(e.message, true); }
      finally { actionBusy = false; await refresh(); }
    }; controls.append(button);
  };
  if (h.state === 'ESCALATED') {
    const label = el('label', 'Review note'); label.htmlFor = 'reviewNote'; const note = el('input'); note.id = 'reviewNote'; note.value = reviewDrafts.get(h.id) || ''; note.oninput = () => reviewDrafts.set(h.id, note.value); note.placeholder = 'Evidence reviewed and decision reason';
    controls.append(label, note);
    addAction('Capture authorization', 'primary', () => api.resolve(h.id, 'capture', $('reviewNote')?.value || 'Reviewed in operations workspace'));
    addAction('Void authorization', 'bad', () => api.resolve(h.id, 'void', $('reviewNote')?.value || 'Evidence rejected in operations workspace'));
  } else if (h.state === 'AWAITING_HUMAN') {
    addAction('Approve budget', 'primary', () => api.policyApprove(h.id, true)); addAction('Reject order', 'bad', () => api.policyApprove(h.id, false));
  } else controls.append(el('p', ['CAPTURE_PENDING', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'].includes(h.state) ? 'PayPal status is unresolved. Reconciliation retains the guard and reservation.' : 'This hold has no review action available.', 'hint'));
  renderEvidence();
}
function sourceLink(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return el('span', 'Unsupported source URL');
    const link = el('a', url.href); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  } catch { return el('span', 'Invalid source URL'); }
}
function renderEvidence(focusRef) {
  const h = holds.find(h => h.id === selectedId); if (!h) return;
  $('evidenceContext').textContent = `${h.id}${selectedCriterion ? ` / ${selectedCriterion.id}: ${selectedCriterion.rationale}` : ' / full delivery'}`;
  const inspector = $('evidenceInspector'); inspector.replaceChildren();
  const passages = el('div'), sources = el('div'); passages.append(el('h3', 'Delivery passages')); sources.append(el('h3', 'Citation support'));
  const refs = new Set(selectedCriterion?.evidenceRefs?.map(r => r.ref) || []);
  for (const unit of parseBrief(h.evidence?.body || '').units) {
    const linked = refs.has(unit.ref); const p = el('article', null, 'evidence-passage' + (linked ? ' linked' : ''));
    p.id = `passage-${unit.ref.replaceAll('.', '-')}`; p.append(el('h3', `${unit.ref} | ${unit.section}${linked ? ' | linked evidence' : ''}`), el('p', unit.text)); passages.append(p);
  }
  if (!h.evidence) passages.append(el('p', 'No delivery has been submitted.', 'hint'));
  const check = h.verdict?.sourceCheck;
  sources.append(el('p', check ? `${check.method || 'Source check'}: ${check.ok ? 'support found' : 'unverified, requires review'}` : 'Optional source checking was off for this delivery.', 'hint'));
  for (const claim of check?.claims || []) {
    const block = el('article', null, 'source-support'); block.append(el('strong', `${claim.ref} | ${claim.supported ? 'Supporting passage' : 'Unsupported claim'}`), el('p', claim.text));
    if (claim.passage) block.append(el('p', claim.passage)); if (claim.url) block.append(sourceLink(claim.url));
    if (claim.score != null) block.append(el('small', `Similarity ${claim.score.toFixed(3)}; relatedness does not prove truth.`)); sources.append(block);
  }
  for (const issue of check?.issues || []) sources.append(el('p', issue, 'hint'));
  for (const source of h.evidence?.sources || []) { const item = el('div', null, 'source-support'); item.append(el('strong', source.title || 'Declared source'), sourceLink(source.url)); sources.append(item); }
  inspector.append(passages, sources);
  if (focusRef) document.getElementById(`passage-${focusRef.replaceAll('.', '-')}`)?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
}
function applyAgentView(input) {
  const result = reviewViewResult(holds, input); plan = validateReviewView(result.plan);
  grids.operations.setFilterModel(plan.filterModel); grids.operations.applyColumnState({ state: plan.sortState, defaultState: { sort: null } });
  $('workflowResult').textContent = `${result.summary.count} holds | ${money(result.summary.exposure)} exposure. ${plan.explanation}`;
  updateLocation({ workflow: 'expiring', hours: plan.withinHours }); updateRows();
}
(async () => {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('theme') === 'dark') { document.body.dataset.theme = 'dark'; $('themeToggle').textContent = 'Light theme'; }
    api = await connect(message => notify(message), { seed: params.get('samples') !== 'off' });
    if (api.reset && api.cfg.samples) {
      $('sampleBanner').hidden = false;
      $('sampleText').textContent = `${api.cfg.samples} holds were generated in this browser tab through the real flow (mock PayPal, in-browser MiniLM, source check ${api.cfg.sourceCheck}). Nothing here is a real payment.`;
      $('resetSamples').onclick = async () => { $('resetSamples').disabled = true; try { await api.reset(); selectedId = null; selectedCriterion = null; plan = null; grids.operations.setFilterModel(null); holds = []; await refresh(); if (holds[0]) selectHold(holds[0]); notify('Sample data reset.'); } catch (e) { notify(e.message, true); } finally { $('resetSamples').disabled = false; } };
    }
    $('connection').textContent = `${api.cfg.backend === 'server' ? 'Durable server' : 'Ephemeral browser demo'} | PayPal ${api.cfg.paypal} | ${api.cfg.embedder} | source check ${api.cfg.sourceCheck ?? 'off'}`;
    const common = { rowData: [], theme: theme(), defaultColDef: { sortable: true, resizable: true, filter: true, minWidth: 90 }, rowHeight: 47,
      getRowId: p => p.data.id, onRowClicked: e => selectHold(e.data), overlayNoRowsTemplate: '<span>No matching holds. Change the view or create holds in the purchase demo.</span>' };
    grids.operations = agGrid.createGrid($('operationsGrid'), { ...common, onFilterChanged: updateViewCount,
      columnDefs: [{ field: 'id', headerName: 'Hold', width: 150, pinned: 'left', cellRenderer: p => p.data?.sample ? `${p.value} <span class="sample-tag">Sample</span>` : p.value }, { field: 'state', headerName: 'State', width: 200, cellRenderer: state },
        { field: 'exposure', headerName: 'Reserved', width: 145, cellRenderer: ExposureRenderer, filter: 'agNumberColumnFilter' },
        { field: 'hoursRemaining', headerName: 'Next deadline', width: 220, cellRenderer: CountdownRenderer, filter: 'agNumberColumnFilter', sort: 'asc' },
        { field: 'topic', headerName: 'Research brief', flex: 2, minWidth: 240 }, { field: 'sellerId', headerName: 'Deliverer', width: 120 },
        { field: 'criteriaPassed', headerName: 'Criteria', width: 105, valueFormatter: p => p.value == null ? 'Awaiting' : `${p.value}/${p.data.criteriaTotal}` },
        { field: 'unresolved', hide: true, filter: 'agTextColumnFilter' }],
    });
    grids.review = agGrid.createGrid($('reviewGrid'), { ...common, columnDefs: [{ field: 'id', headerName: 'Hold', width: 95 }, { field: 'state', width: 195, cellRenderer: state },
      { field: 'exposure', headerName: 'Reserved', width: 105, valueFormatter: p => money(p.value) }, { field: 'hoursRemaining', headerName: 'Next deadline', width: 210, cellRenderer: CountdownRenderer, sort: 'asc' }] });
    grids.criteria = agGrid.createGrid($('criteriaGrid'), { ...common, getRowId: p => p.data.id, onRowClicked: e => { selectedCriterion = e.data; renderEvidence(); }, columnDefs: [{ field: 'id', headerName: 'Criterion', width: 105 }, { field: 'verdict', width: 110 },
      { field: 'text', headerName: 'Frozen requirement', flex: 2, minWidth: 230 }, { field: 'evidenceRefs', headerName: 'Linked passages', width: 210, cellRenderer: EvidenceRefsRenderer, filter: false, sortable: false }, { field: 'rationale', flex: 2, minWidth: 240, tooltipField: 'rationale' }] });
    $('agentCapability').textContent = 'Community grid filters + read-only MCP tool: build_expiring_review_view. This view tool makes no external LLM calls.';
    $('workflowForm').onsubmit = event => { event.preventDefault(); try { applyAgentView({ withinHours: Number($('withinHours').value) }); } catch (e) { notify(e.message, true); } };
    $('clearView').onclick = () => { plan = null; grids.operations.setFilterModel(null); updateLocation({ workflow: null, hours: null }); $('workflowResult').textContent = 'All holds shown. Settlement requires the app review controls.'; updateRows(); };
    $('refresh').onclick = refresh;
    $('themeToggle').onclick = () => { const dark = document.body.dataset.theme !== 'dark'; document.body.dataset.theme = dark ? 'dark' : 'light'; $('themeToggle').textContent = dark ? 'Light theme' : 'Dark theme'; updateLocation({ theme: dark ? 'dark' : null }); for (const grid of Object.values(grids)) grid.setGridOption('theme', theme()); };
    await refresh();
    if (params.get('workflow') === 'expiring') { const hours = Number(params.get('hours') || 24); $('withinHours').value = String(hours); applyAgentView({ withinHours: hours }); }
    const initialHold = holds.find(h => h.id === params.get('hold')) || holds[0];
    if (initialHold) { selectHold(initialHold); const criterion = initialHold.verdict?.results.find(r => r.id === params.get('criterion')); if (criterion) { selectedCriterion = criterion; renderEvidence(); } }
    setInterval(refresh, 15000);
  } catch (e) { notify(`Workspace unavailable: ${e.message}`, true); }
})();
