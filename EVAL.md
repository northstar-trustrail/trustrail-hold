# Verifier evaluation (v0.3.1)

`npm run eval` runs the held-out set **v2** (`eval/heldout-v2.json`) and writes `eval/results-heldout-v2.json`. `EVAL_SET=v1 npm run eval` runs v1, which is now a development set. `EVAL_REQUIRE_MINILM=1` fails the run if the model is unavailable; fallback scores are never labeled MiniLM. `npm run eval:dev` runs the original 25-case development set.

All numbers below were measured on 2026-10-17 with `Xenova/all-MiniLM-L6-v2` (q8, single-threaded) loaded through `@huggingface/transformers`.

## Protocol and what history proves

| Commit | What it froze |
| --- | --- |
| `fe0ce15` | `heldout-v2.json` (32 cases, sha256 `3494e164f5c5458d52aa63d4d8296b8967d5e6c6362ed24312a79e77c50879fe`), its generator and the real source snapshots. The claim-level checker did not exist yet. |
| `8886152` | The claim-level source check and config `2026-10-17.v2` (retrieval pass 0.45 / fail 0.30 / echo 0.85, unchanged since v1; source support 0.50, number window 3 passages). Designed on `eval/cases.json` and heldout-v1 only. |
| `da9e075` | The first v2 run, unchanged from the table below. |
| `6daff8b`, `b0c2ef0` | Three checker fixes found on the browser-demo dev briefs (figures written as "35 million" vs "35 000 000", terms the buyer's own order supplied, list markers). Re-running v2 after each changed **0 of 128** decisions. |

Caveats that history cannot remove: the same team wrote v2 and the checker on the same day, so the checker author knew what kinds of errors v2 contains (changed numbers, swapped names). v2 is self-authored, small (8 good, 24 bad), and built from variants of 8 briefs. It is not independent validation and does not estimate production error rates.

## Held-out v2 (32 cases)

Four topics never used for design: Hubble Space Telescope launch and mirror repair, Panama Canal route and history, discovery of penicillin, invention of the transistor. Per topic: two compliant good briefs (one with a single inline citation, one with numbered citations), a fabricated citation (an invented page on the real host, which answers 404), a wrong number and a wrong named entity (each a one-word edit against the real source text), padding, an accurate brief about a different topic, and a good brief with an embedded prompt injection.

Sources are the **real lead sections of the cited English Wikipedia pages** (revision IDs recorded, CC BY-SA 4.0), fetched once and served by a local fixture server (`eval/fixture-server.js`). The build box resolves every hostname to `198.18.0.1`, which the production SSRF guard correctly refuses, so the eval passes an explicit, loopback-only route map (`evalFixtureRoutes`) into the real `fetchPublicSource` transport. Production code never passes it, and URL validation is unchanged (unit-tested).

| System | False approvals | Good work auto-approved | Escalated | Good work wrongly voided |
| --- | --- | --- | --- | --- |
| Lexical baseline, source check off | 0/24 (0%) | 0/8 (0%) | 29/32 (91%) | 1/8 (12%) |
| Lexical fallback, source check on | 0/24 (0%) | 0/8 (0%) | 29/32 (91%) | 1/8 (12%) |
| MiniLM, source check off | 16/24 (67%) | 8/8 (100%) | 4/32 (12%) | 0/8 (0%) |
| MiniLM + claim-level source check (default) | 0/24 (0%) | 5/8 (62%) | 23/32 (72%) | 0/8 (0%) |

What happened, case by case (`eval/results-heldout-v2.json` has every verdict, claim and issue):
- **MiniLM without source check approved 16/24 bad briefs**: all 4 fabricated citations, all 4 wrong numbers, all 4 wrong entities and all 4 padded briefs. Only off-topic briefs (voided) and injections (tripwire) were stopped.
- **With the source check, 0/24 bad briefs were approved.** Fabricated citations: 404. Wrong numbers: "number 1992 / 64 / 1938 / 1949 not in the matching source passages". Wrong entities: "Soyuz", "Gulf, Mexico", "Cambridge", "RCA, Laboratories" not found in the cited source. Off-topic: voided by retrieval. Injection: tripwire.
- **Padding was stopped, two of four times for a fragile reason.** In the Hubble and Transistor padded briefs, sentences that only restate the ordered topic ("This brief addresses Invention of the transistor.") counted as supported factual claims, because words like "Telescope" and "Invention" come from the topic string, which is not passed to the checker (only the questions are). The only issue that stopped them was a spurious "entity", the sentence-initial capitalized word "Understanding", which is absent from the source. Slightly different padding wording would probably be approved. The Canal and Penicillin padded briefs had no factual claims apart from such spurious ones, so the "at least one supported factual claim" rule would have stopped them anyway. Not fixed here: fixing it after seeing v2 would turn v2 into a development set.
- **5/8 good briefs were auto-approved; 3 escalated, none voided.** Penicillin (numbered): one sentence combines a 1942 fact and the 1945 Nobel Prize, and 1945 was not in the top 3 matching passages. Transistor (both): the short sentence "The three shared the 1956 Nobel Prize in Physics" scored 0.45 and 0.49 against the source, just below the 0.50 support threshold.
- The lexical baseline approved nothing and wrongly voided one good brief.

## v1 (20 cases, development set since v0.3.1)

v1 was held out for v0.3 and is now development data: the claim-level checker was designed after seeing its v0.3 results. Its source fixtures are one- or two-sentence authored summaries, so good v1 briefs state many facts the fixtures do not contain (e.g. "3600 seconds", "27.3 days", "February", "Julian").

| System | False approvals | Good work auto-approved | Escalated | Good work wrongly voided |
| --- | --- | --- | --- | --- |
| Lexical baseline, source check off | 0/16 (0%) | 0/4 (0%) | 13/20 (65%) | 0/4 (0%) |
| Lexical fallback, source check on | 0/16 (0%) | 0/4 (0%) | 13/20 (65%) | 0/4 (0%) |
| MiniLM, source check off | 11/16 (69%) | 4/4 (100%) | 2/20 (10%) | 0/4 (0%) |
| MiniLM + claim-level source check (default) | 0/16 (0%) | 0/4 (0%) | 17/20 (85%) | 0/4 (0%) |

v0.3 numbers for comparison (old paragraph-citation source check): MiniLM without source check 11/16 false approvals, 4/4 good; with the old source check 0/16 and 0/4 (85% escalation). The new checker does not change the v1 headline: every good v1 brief still escalates, now because its numbers and names are absent from the thin fixtures, not because a paragraph lacks a citation. The PNG factual error (a negation, "decoding discards some encoded sample values") has no number or name to cross-check; it escalates only because the brief has no checkable facts at all. Negations and relation errors between correct entities are not detected.

## Definitions

A false approval is `decision=capture` on a case labeled `reject`, divided by all reject cases. Good-work auto-approval divides good captures by all good cases. Escalation divides all escalations by all cases. A verifier decision only requests an action; only a confirmed PayPal `COMPLETED` status establishes a payment.

## Other limits

- Retrieval similarity measures relatedness, not truth. The number/entity cross-check is literal: it catches changed figures and invented names, not negations, swapped relations between names the source does mention, or a wrong figure that appears elsewhere in the matching passages.
- Factual-claim detection is a heuristic (digits, capitalized names not supplied by the order, quotations). Conceptual briefs with no numbers or names have no checkable facts and are escalated.
- Live-network source mode (`EVAL_LIVE_SOURCES=1`) cannot be measured on the build box (all DNS answers are non-public). The browser demo uses bundled snapshots of its three cited pages.
- The optional LLM judge remains veto-only. Local Qwen2.5-0.5B did not separate correct answers from echoes and adjacent topics. No hosted-judge results are claimed.
- The original 25-case set (`eval/cases.json`) was used for tuning; its 0/18 false approvals and 4/7 good approvals are not generalization evidence.
