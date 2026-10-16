# Verifier evaluation

`npm run eval` evaluates the frozen verifier against `eval/heldout-v1.json`, writes `eval/results-heldout-v1.json`, and compares MiniLM with the lexical baseline when the model is available. Set `EVAL_REQUIRE_MINILM=1` to make an unavailable model fail the run. The script never labels fallback scores as MiniLM. `npm run eval:dev` runs the old development set; `EVAL_OUT` selects the output file.

The retrieval thresholds (pass 0.45, fail below 0.30, echo 0.85) and source-check limits are frozen in `src/ai/verifier-config.js`, version `2026-10-16.v1`. They were frozen before this new challenge set was authored and were not adjusted after seeing its results. Each report records the dataset SHA-256 and config.

The new held-out set has 20 cases across DNS TTL caching, lunar phases, Gregorian leap years, and PNG compression. These topics did not appear in the old EU AI Act or SOC 2 tuning set. Each topic has one compliant good brief, one fabricated citation on a legitimate host, one plausible factual error, one off-topic brief, and one padded non-answer. All four good briefs pass the deterministic section, length, topic, and citation-format checks. Tests enforce that property.

## Measured results (2026-10-16)

| System | False-approval rate | Good-work auto-approval rate | Escalation rate | Good work wrongly voided |
| --- | --- | --- | --- | --- |
| Lexical baseline, source checking off | 0/16 (0%) | 0/4 (0%) | 13/20 (65%) | 0/4 (0%) |
| MiniLM, source checking off | Not measured | Not measured | Not measured | Not measured |

MiniLM could not run in this environment: the optional `@huggingface/transformers` package was unavailable and installation requests failed under network restrictions. The comparison to MiniLM is therefore unmeasured. The five existing MiniLM-dependent unit tests also skipped. The older checked-in MiniLM results are historical development evidence, not results for this new set.

A false approval means `decision=capture` on a case labeled `reject`, divided by all reject cases. Good-work auto-approval divides good captures by all good cases. Escalation divides all escalations by all cases. A verifier decision requests an action; only confirmed PayPal completion establishes a payment.

## Failures and limits

The measured baseline approves no good work. All four compliant briefs need human review; none is wrongly voided. Zero false approvals in this run therefore does not demonstrate useful discrimination or factual safety. The report contains every criterion verdict and rationale so these failures are inspectable.

Citation-format checks cannot distinguish a fabricated document path on a legitimate domain from a real document. Retrieval similarity measures relatedness and does not establish truth. The plausible factual-error cases deliberately preserve formatting and source URLs while changing a key assertion. A conservative verifier can avoid approving them by rejecting everything, which is why both safety and good-work approval must be reported together.

The set is self-authored, small, and structured as related variants of four briefs. It is held out from threshold tuning, but it is not independent external validation and does not estimate production error rates. Do not tune on these cases and continue to call them held out. The original 25-case set in `eval/cases.json` is development data: thresholds and heuristics were changed after its failures were observed. Its previous headline of 0/18 false approvals and 4/7 good approvals must not be presented as generalization evidence.

The optional LLM judge remains veto-only. Previous local Qwen2.5-0.5B experiments did not reliably separate correct answers from echoes and adjacent topics. No new hosted-judge results are claimed here. Source-check experiments and their limitations are reported separately when enabled.
