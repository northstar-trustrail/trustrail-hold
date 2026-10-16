# Trustrail

**Trustrail lets AI agents buy digital work within approved budgets. PayPal authorization holds and evidence-based delivery checks decide whether to capture the payment, cancel the hold, or ask a human.**

It does one job: **agents buying research briefs** that have required sections, sources and questions.

▶ **Live demo** (runs in your browser, no install; mock PayPal plus a real MiniLM model in-browser): https://northstar-trustrail.github.io/trustrail-hold/
▶ **Real PayPal sandbox run:** [`docs/sandbox-run.json`](docs/sandbox-run.json). It records real sandbox order, authorization, capture and refund IDs, each re-read from the PayPal API.
▶ **Verifier evaluation:** [`EVAL.md`](EVAL.md), including the false-approval rate on a labeled normal + adversarial set.

<img src="docs/screenshot.png" alt="Trustrail dashboard">

## The problem
An agent that buys research for you is stuck between two bad options. It can pay up front and hope the seller delivers, or it can ask you to approve and check every purchase by hand. Trustrail adds a third: **the money is reserved but not taken until the delivery provably matches what was ordered.**

## What "hold" means here (not escrow)
Trustrail is **not custodial escrow**, and nobody holds the money in an account.
- The buyer approves a PayPal **authorization** (Orders v2 `intent=AUTHORIZE`). The funds stay in the buyer's account, reserved.
- PayPal authorizations are valid for **29 days**. Capture has the highest likelihood of success during the first **3 days (the "honor period")**, but is not guaranteed, so Trustrail caps delivery deadlines at 72 h and shows both clocks in the grid.
- **Who controls capture:** the merchant app that created the order, i.e. Trustrail's `Settlement` service, using the operator's PayPal REST credentials. It captures or voids only for a verdict that is bound to the order's frozen criteria hash and the stored evidence hash, and only once per hold. The buyer agent, the seller and the verifier have no PayPal credentials and no way to capture.
- If the delivery fails, the hold is **voided** and the buyer is never charged. After a capture, a buyer dispute triggers a **refund** (Payments v2).

## Flow
```
buyer_agent ──propose(intent JSON)──► schema validation ──► criteria frozen + SHA-256 committed ──► policy (caps, threshold)
                                                                       │ allow / buyer approves
                                                                       ▼
                                   PayPal Orders v2 intent=AUTHORIZE ─► buyer approves ─► authorize  (HELD)
seller ──deliver(markdown brief)──► evidence hash ──► verifier (no PayPal access)
                                     • deterministic: sections, length, topic anchor, cited http(s) sources, placeholder hosts
                                     • semantic: MiniLM retrieval per question + expected-answer-type + "echo" (keyword-stuffing) band
                                     • optional LLM judge (veto/downgrade only, schema-checked)
                                     • prompt-injection tripwire
                                     ▼ per-criterion {verdict, evidenceRefs[S2.P1, SRC3…], rationale}
               capture (all pass) │ void (most fail) │ escalate → reviewer
                                     ▼
              Settlement (only holder of PayPal creds) ─► /authorizations/{id}/capture | /void ─► /captures/{id}/refund
                                     ▼
           hash-chained receipts + ECDSA-signed checkpoints (retained externally via file/webhook)
```

## AI, honestly
| Piece | What it is | Cost |
|---|---|---|
| Semantic verifier | **all-MiniLM-L6-v2** sentence embeddings (Apache-2.0) run locally with transformers.js, in Node and in the browser | free, offline after a ~23 MB download |
| LLM judge (optional) | Pluggable: any OpenAI-compatible endpoint (`AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`), or local Qwen2.5-0.5B (`TRUSTRAIL_JUDGE=local`) | yours |
| Intent parsing | Agents send **structured JSON** (MCP schema). Natural-language parsing via LLM is optional, and its output must pass the same schema. If the amount isn't stated in the request, the order is rejected (anti-hallucination). | |

The small local LLM we could run for free did **not** discriminate (see [EVAL.md](EVAL.md)), so it's off by default. We did not test a larger hosted model, and **no LLM output anywhere in this project is simulated.** The default verifier is MiniLM plus deterministic checks. The old 25-case development results informed tuning and do not establish held-out performance. The new 20-case held-out run measured the lexical baseline at 0/16 false approvals and 0/4 good-work auto-approvals; MiniLM was unavailable in that environment. See [EVAL.md](EVAL.md) for failures and reproduction.

## Optional citation support checks

Set `TRUSTRAIL_SOURCE_CHECK=1` on the Node server to fetch cited public HTTP(S) pages and compare key claim sentences with fetched passages using MiniLM. The check records source URLs, resolution errors, supporting passages, and similarity scores in `verdict.sourceCheck`. Otherwise approvable work escalates when a URL fails, a claim lacks local citation support, the model is unavailable, or a limit is exceeded. A definite void remains a void.

Each request has a 5-second timeout, a 256 KiB cap, at most three redirects, no credentials, and public-address DNS validation pinned to the connection. Only plain text and HTML are supported. The frozen config caps sources at 20 and key claims at 40. The browser-only demo leaves this server transport off. Source checking establishes retrieval support, not truth or logical entailment; contradicting passages may still have high similarity. The evaluation reports source checks with offline authored fixtures separately from live fetching.

## Security model
| Role | Can | Cannot |
|---|---|---|
| `buyer_agent` (MCP) | propose orders, read its own holds and proofs | approve, deliver, resolve, capture, void, refund |
| `buyer` | approve over-threshold orders, approve the PayPal authorization, request a refund | deliver, resolve |
| `seller` | deliver, but only to holds where it is the named seller | read other sellers' holds, settle |
| `reviewer` | resolve escalations (capture or void) | propose, deliver |
| `auditor` | read everything and the ledger | change anything |
| verifier | pure function of (frozen criteria, evidence) | has no PayPal client at all |

Tested in `test/holds.test.js` and `test/mcp.test.js`:
- **Permissions:** every role is blocked outside its own step; another seller can't deliver to your hold; another org can't read it.
- **Settlement:** duplicate settlement (sequential and concurrent) is impossible; a hold whose stored evidence changed after the verdict can't be settled.
- **Tamper evidence:** changing a receipt, a checkpoint or the signing key fails `verifyProof`.

## Durable payment state

The server persists holds, daily budget reservations, operation request IDs, settlement guards, receipts, checkpoints, and mock PayPal resources to `data/trustrail.json` (override with `TRUSTRAIL_STORE`). It writes and fsyncs a temporary file before atomic replacement. A process lock prevents two writers. Startup fails on a corrupt file rather than silently resetting it. Runtime data and keys are gitignored; credentials stay in environment variables.

Money-changing operations persist their intent before the PayPal request. Only capture status `COMPLETED` marks a hold `RELEASED`; only refund status `COMPLETED` marks it `REFUNDED`. `PENDING` becomes `CAPTURE_PENDING` or `REFUND_PENDING`, with the budget reservation retained. Unknown or failed statuses require reconciliation. A timeout retains the guard, even if the operator asks for the opposite settlement action.

Startup and a 60-second timer reconcile operations using GET order, authorization, capture, or refund. A lost capture response is recovered by its invoice ID on the order, then GET capture. A lost create response without an order ID remains unresolved for operator investigation. A lost refund response needs a verified webhook to discover its refund ID before GET refund; GET capture alone cannot prove which refund completed. No recovery path blindly repeats a POST.

Register `POST /api/paypal/webhook` with PayPal and set `PAYPAL_WEBHOOK_ID` to that registration's ID. The endpoint sends PayPal's transmission headers and complete event to `/v1/notifications/verify-webhook-signature`. It rejects failed verification, persists event deduplication, and re-reads known pending payment resources before updating state. Subscribe to capture completed, pending, denied, and refunded events, plus refund pending and failed events. Webhook payload status alone never releases money.

**Single-merchant model:** all PayPal payments go to the merchant that owns the configured REST app credentials. `sellerId` is the internal deliverer identity, not a PayPal merchant ID or payout destination. The adapter deliberately omits `payee`. Multi-seller payouts and marketplace onboarding are outside this prototype.

## PayPal integration
| Step | API |
|---|---|
| OAuth | `POST /v1/oauth2/token` (client credentials, cached) |
| Order | `POST /v2/checkout/orders` with `intent: AUTHORIZE`, `PayPal-Request-Id` idempotency |
| Buyer approval | `payer-action` link → `/paypal/return` → `POST /v2/checkout/orders/{id}/authorize` |
| Capture | `POST /v2/payments/authorizations/{id}/capture` (`final_capture`, unique `invoice_id`) |
| Void | `POST /v2/payments/authorizations/{id}/void` |
| Refund | `POST /v2/payments/captures/{id}/refund` |
| Confirm | `GET` order / authorization / capture / refund (`npm run sandbox:confirm`) |

For unattended sandbox demos, `TRUSTRAIL_SANDBOX_CARD` uses a **PayPal sandbox test card** as the payment source. PayPal authorizes it at order creation, so no buyer login is needed. The adapter refuses to do this against the live API.

## AG Grid
The dashboard uses AG Grid Community (MIT, vendored):
- **Holds grid** with custom cell widgets:
  - **held value** bar against the policy cap;
  - **authorization expiry** bar with the **3-day honor-period** marker;
  - **criteria passed** meter;
  - a pinned totals row;
  - injection rows highlighted.
- **Review queue** grid: escalations and over-threshold orders, with in-cell Capture/Void/Approve actions.
- **Criteria drill-down** grid: per-criterion verdict, evidence-reference chips (hover to see the quote), method and rationale.
- **Receipt ledger** grid: chain verification plus signed-checkpoint verification, and CSV export.
- **“Which holds need review today?”**: a read-only, rule-based query that filters the grids and can't act.

Open `/operations.html` for the operations workspace: all unresolved exposure, live expiry countdowns, a review queue, selectable criteria with a linked evidence inspector, source support passages, and light/dark themes. Deep links accept `hold`, `criterion`, and `theme=dark`.

The `build_expiring_review_view` MCP tool returns a versioned, validated Community filter/sort plan and a URL such as `/operations.html?workflow=expiring&hours=24`. The workspace runs the same read-only tool when you choose **Build review view**. It includes overdue unresolved holds and sorts by the earliest delivery, honor-period, or authorization clock. Agent tools have no settlement capability. Explicit app review controls call the existing permission-checked resolve/approval APIs.

[AG Grid's AI Toolkit](https://www.ag-grid.com/javascript-data-grid/ai-toolkit/) is marked Enterprise and requires `AiToolkitModule`, which the vendored Community bundle does not provide. [AG Studio's Agent Framework](https://www.ag-grid.com/studio/javascript/ai/) belongs to the separate Studio package. This entry uses Community filters, sort state, custom renderers, and the Quartz theming API, with an application-owned MCP view tool. It does not claim a Studio integration or simulate an LLM. The view tool sends no hold data to an external model.

## MCP (buyer agent)
```jsonc
{ "mcpServers": { "trustrail": { "command": "node", "args": ["/path/to/trustrail-hold/src/mcp.js"],
  "env": { "TRUSTRAIL_URL": "http://localhost:8787", "TRUSTRAIL_TOKEN": "<buyer_agent token>" } } } }
```
Tools: `build_expiring_review_view`, `propose_research_brief` (strict JSON schema), `get_hold`, `list_holds`, `get_proof`. The server enforces permissions by token, so a modified MCP client gains nothing.

## Run
Requires Node 20+.
```bash
npm install            # optional dep: @huggingface/transformers (MiniLM); without it the lexical fallback is used and labeled
npm test               # unit, payment recovery, REST, and MCP tests
npm run eval           # frozen held-out eval, metrics, baseline comparison
npm start              # http://localhost:8787 with mock PayPal and demo tokens (demo-agent, demo-buyer, demo-seller, demo-reviewer, demo-auditor)
```
To use the real sandbox, take an app's Client ID and Secret from https://developer.paypal.com/dashboard/applications/sandbox:
```bash
export PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=...
npm run sandbox:lifecycle && npm run sandbox:confirm   # capture, refund, void, escalate→void with real sandbox IDs
npm start                                              # dashboard against the sandbox (buyer approves on PayPal)
TRUSTRAIL_SANDBOX_CARD=4032039317984658 npm start      # sandbox test card: no buyer login
```
Other settings:
- Tokens: `TRUSTRAIL_TOKENS` (JSON). Change them before exposing the server; the demo tokens are public.
- Checkpoint retention: `TRUSTRAIL_CHECKPOINT_FILE`, `TRUSTRAIL_CHECKPOINT_WEBHOOK`.
- Persistent signing key: `TRUSTRAIL_SIGNING_JWK`.
- Policy: `TRUSTRAIL_POLICY`.

## Limitations
- The server uses one file-backed store and one writer process. The browser-only demo remains ephemeral. Back up the store directory and protect its evidence and signing key with OS file permissions.
- The eval set is small and self-authored (see EVAL.md).
- Semantic checks confirm a question is *addressed with the right kind of answer*. They don't check that the facts are *true*.
- The demo tokens are public; this is a hackathon prototype on the PayPal sandbox only.

MIT © Northstar Trustrail

## Demo video

[demo.mp4](https://northstar-trustrail.github.io/trustrail-hold/demo.mp4) (2:44, real PayPal sandbox IDs)
