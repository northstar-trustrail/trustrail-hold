// Frozen before the evaluation sets that test them. Do not tune on a held-out set.
// 2026-10-16.v1: retrieval thresholds, frozen before eval/heldout-v1.json (now a dev set).
// 2026-10-17.v2: claim-level source check, designed on eval/cases.json + eval/heldout-v1.json,
//   frozen before the first run on eval/heldout-v2.json (committed earlier, in fe0ce15).
//   support 0.55 -> 0.50 after correct paraphrases in heldout-v1 scored 0.51-0.548.
export const VERIFIER_CONFIG = Object.freeze({
  version: '2026-10-17.v2',
  retrieval: Object.freeze({ pass: 0.45, fail: 0.30, echo: 0.85 }),
  source: Object.freeze({ support: 0.5, numberWindow: 3, timeoutMs: 5000, maxBytes: 262144, maxSources: 20, maxClaims: 40, maxPassages: 400 }),
});
