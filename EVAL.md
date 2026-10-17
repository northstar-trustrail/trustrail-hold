# Verifier evaluation

`npm run eval` evaluates the frozen verifier against `eval/heldout-v1.json`, writes `eval/results-heldout-v1.json`, and compares MiniLM with the lexical baseline when the model is available. Set `EVAL_REQUIRE_MINILM=1` to make an unavailable model fail the run. The script never labels fallback scores as MiniLM. `npm run eval:dev` runs the old development set; `EVAL_OUT` selects the output file.

The retrieval thresholds (pass 0.45, fail below 0.30, echo 0.85) and source-check limits are frozen in `src/ai/verifier-config.js`, version `2026-10-16.v1`. They were frozen before this new challenge set was authored and were not adjusted after seeing its results. Each report records the dataset SHA-256 and config.

The new held-out set has 20 cases across DNS TTL caching, lunar phases, Gregorian leap years, and PNG compression. These topics did not appear in the old EU AI Act or SOC 2 tuning set. Each topic has one compliant good brief, one fabricated citation on a legitimate host, one plausible factual error, one off-topic brief, and one padded non-answer. All four good briefs pass the deterministic section, length, topic, and citation-format checks. Tests enforce that property.

## Measured results with MiniLM (2026-10-17, v0.3)

Run on Linux with `@huggingface/transformers` 3.x and `Xenova/all-MiniLM-L6-v2` (q8, single-threaded) loaded: `EVAL_REQUIRE_MINILM=1 npm run eval`. Dataset SHA-256 `104352abd8c610c8d2af28324389d9c5a1ae02908b2295230c800283f32b778a`, config `2026-10-16.v1`, source mode `offline-authored-fixtures`. Nothing in the dataset, thresholds, or verifier was changed between the earlier fallback run and this run.

| System | False-approval rate | Good-work auto-approval rate | Escalation rate | Good work wrongly voided |
| --- | --- | --- | --- | --- |
| Lexical baseline, source checking off | 0/16 (0%) | 0/4 (0%) | 13/20 (65%) | 0/4 (0%) |
| Lexical fallback, source checking on | 0/16 (0%) | 0/4 (0%) | 13/20 (65%) | 0/4 (0%) |
| **MiniLM, source checking off** | **11/16 (69%)** | 4/4 (100%) | 2/20 (10%) | 0/4 (0%) |
| **MiniLM, source checking on** | 0/16 (0%) | **0/4 (0%)** | 17/20 (85%) | 0/4 (0%) |

MiniLM vs the lexical baseline (source off): +69 points false approvals, +100 points good auto-approval, -55 points escalation. The development set (`npm run eval:dev`) still reproduces its old numbers (0/18 false approvals, 4/7 good captured); that set was used for tuning and is not evidence of generalization.

### What the held-out run shows

- **Retrieval alone is not a safe auto-capture rule.** With source checking off, MiniLM approved every fabricated-citation case (4/4), every plausible factual-error case (4/4) and 3/4 padded non-answers. Their question-retrieval scores are within 0.01-0.03 of the matching good brief (for example DNS Q-1: good 0.730, fabricated 0.718, factual error 0.718). Only off-topic briefs are separated (3 voided, 1 escalated). Embedding similarity measures relatedness, not correctness, and the frozen thresholds cannot fix that.
- **Source checking removes the false approvals but approves no good work.** All four good briefs escalate. The good briefs are contract-compliant (sections, 100-600 words, one cited source referenced in the text; enforced by `test/eval.test.js`), so the cases are valid. The checker is stricter than the purchase contract: it treats every sentence in a question-matching paragraph as a key claim that needs a local URL or `[n]` citation. Every good brief cites its source once in Findings and states its recommendations in Implications without a citation, so 3 sentences per brief are "missing local citation". Three of the four good briefs also have one cited Findings sentence below the 0.55 support threshold (0.485-0.548).
- **Source checking catches fabricated citations and padding, not factual errors.** Fabricated citations escalate because the cited page is a 404; padding escalates because no key sentence is supported. The factual-error briefs have the same issue profile as the good briefs once the uncited-paragraph issues are set aside (Lunar: zero support issues in both). A looser citation rule would therefore auto-approve factual errors as often as good work. Nothing here demonstrates factual verification.

These are measured results, not a tuned outcome. The thresholds and checker rules were **not** changed after seeing them; doing so would turn this set into development data. Any redesign (for example scoping source support to the Findings paragraph or adding a contradiction/numeric check) must be evaluated on a new held-out set authored after the change.

Live-network source mode (`EVAL_LIVE_SOURCES=1`) was attempted on the build box but cannot be measured there: the box egress resolves every hostname to `198.18.0.1` (a benchmarking range), which the SSRF guard correctly refuses, so every citation was unresolved and every non-void case escalated. That run is not reported as a result.

### Earlier fallback-only run (2026-10-16)

The first run of this set had no MiniLM available and measured only the two lexical rows above (identical numbers). It is superseded by the table above, not contradicted by it.

A false approval means `decision=capture` on a case labeled `reject`, divided by all reject cases. Good-work auto-approval divides good captures by all good cases. Escalation divides all escalations by all cases. A verifier decision requests an action; only confirmed PayPal completion establishes a payment.

## Failures and limits

The lexical baseline and MiniLM with source checking approve no good work: all four compliant briefs need human review; none is wrongly voided. Their zero false approvals therefore do not demonstrate useful discrimination or factual safety. MiniLM without source checking approves good work but also 69% of bad work. The report contains every criterion verdict and rationale so these failures are inspectable.

Citation-format checks cannot distinguish a fabricated document path on a legitimate domain from a real document. Retrieval similarity measures relatedness and does not establish truth. The plausible factual-error cases deliberately preserve formatting and source URLs while changing a key assertion. A conservative verifier can avoid approving them by rejecting everything, which is why both safety and good-work approval must be reported together.

The set is self-authored, small, and structured as related variants of four briefs. It is held out from threshold tuning, but it is not independent external validation and does not estimate production error rates. Do not tune on these cases and continue to call them held out. The original 25-case set in `eval/cases.json` is development data: thresholds and heuristics were changed after its failures were observed. Its previous headline of 0/18 false approvals and 4/7 good approvals must not be presented as generalization evidence.

The optional LLM judge remains veto-only. Previous local Qwen2.5-0.5B experiments did not reliably separate correct answers from echoes and adjacent topics. No new hosted-judge results are claimed here. Source-check experiments and their limitations are reported separately when enabled.

## Source-check experiment

The default held-out run uses authored offline source summaries and synthetic 404 responses in `heldout-v1.json`, not cached copies of live pages. This makes transport behavior reproducible and avoids changing labels when a website changes. It does not measure live citation resolution quality. `EVAL_LIVE_SOURCES=1 npm run eval` uses actual public URL requests instead; this network mode could not be measured on the build box (see above).

Source checking runs both off and on for each available embedder. The source-on fallback run has the same decisions as the baseline because the baseline already escalates or voids every case; with the fallback, citation-support results explicitly say MiniLM is unavailable and no lexical similarity score substitutes for semantic source support. Unit tests exercise bounded transport, redirects, private-address blocking, unsupported passages, and fail-closed downgrade behavior using test fixtures and test vectors. Those test vectors are not evaluation results.

When MiniLM is installed, the checker retrieves supporting passages for the key claim sentences in the question-matching paragraphs. Claims need a local URL or numbered citation. Any unresolved source or unsupported key claim blocks automatic approval and escalates otherwise approvable work. Existing void decisions remain void. This check is conservative: recommendations without cited support may escalate good work. It is also incomplete: embedding similarity does not recognize every contradiction, negation, numeric change, or fabricated fact. A source discussing the same subject can score highly while contradicting the delivery. The plausible factual-error cases remain essential failure probes. The measured MiniLM run confirms the checker does not solve them: it escalates them only for the same reasons it escalates good work.
