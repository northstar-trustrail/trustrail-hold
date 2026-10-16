# Trustrail

**Trustrail lets AI agents buy digital work within approved budgets. PayPal authorization holds and evidence-based delivery checks decide whether to capture the payment, cancel the hold, or ask a human.**

It does one job: **agents buying research briefs** that have required sections, sources and questions.

▶ **Live demo** (runs in your browser, no install; mock PayPal plus a real MiniLM model in-browser): https://northstar-trustrail.github.io/trustrail-hold/
▶ **Real PayPal sandbox run:** [`docs/sandbox-run.json`](docs/sandbox-run.json). It records real sandbox order, authorization, capture and refund IDs, each re-read from the PayPal API.
▶ **Verifier evaluation:** [`EVAL.md`](EVAL.md), including the false-approval rate on a labeled normal + adversarial set.

![Trustrail dashboard](docs/screenshot.png)

## The problem
An agent that buys research for you is stuck between two bad options. It can pay up front and hope the seller delivers, or it can ask you to approve and check every purchase by hand. Trustrail adds a third: **the money is reserved but not taken until the delivery provably matches what was ordered.**

## What "hold" means here (not escrow)
Trustrail is **not custodial escrow**, and nobody holds the money in an account.
- The buyer approves a PayPal **authorization** (Orders v2 `intent=AUTHORIZE`). The funds stay in the buyer's account, reserved.
- PayPal authorizations are valid for **29 days**. Capture is guaranteed only during the first **3 days (the "honor period")**, so Trustrail caps delivery deadlines at 72 h and shows both clocks in the grid.
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

The small local LLM we could run for free did **not** discriminate (see [EVAL.md](EVAL.md)), so it's off by default. We did not test a larger hosted model, and **no LLM output anywhere in this project is simulated.** The default verifier is MiniLM plus deterministic checks: 0/18 false approvals on our (small, self-written) set, and 4/7 good briefs auto-captured, compared with 0/7 for the non-AI lexical baseline.

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

We didn't use AG Studio.

## MCP (buyer agent)
```jsonc
{ "mcpServers": { "trustrail": { "command": "node", "args": ["/path/to/trustrail-hold/src/mcp.js"],
  "env": { "TRUSTRAIL_URL": "http://localhost:8787", "TRUSTRAIL_TOKEN": "<buyer_agent token>" } } } }
```
Tools: `propose_research_brief` (strict JSON schema), `get_hold`, `list_holds`, `get_proof`. The server enforces permissions by token, so a modified MCP client gains nothing.

## Run
Requires Node 20+.
```bash
npm install            # optional dep: @huggingface/transformers (MiniLM); without it the lexical fallback is used and labeled
npm test               # 26 tests
npm run eval           # labeled eval -> false-approval rate
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
- State is in memory: no database yet, and no PayPal webhooks yet.
- The eval set is small and self-authored (see EVAL.md).
- Semantic checks confirm a question is *addressed with the right kind of answer*. They don't check that the facts are *true*.
- The demo tokens are public; this is a hackathon prototype on the PayPal sandbox only.

MIT © Northstar Trustrail

## Demo video

[demo.mp4](https://northstar-trustrail.github.io/trustrail-hold/demo.mp4) (2:44, real PayPal sandbox IDs)
