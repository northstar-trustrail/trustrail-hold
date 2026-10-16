// Frozen before authoring eval/heldout-v1.json. Do not tune on the held-out set.
export const VERIFIER_CONFIG = Object.freeze({
  version: '2026-10-16.v1',
  retrieval: Object.freeze({ pass: 0.45, fail: 0.30, echo: 0.85 }),
  source: Object.freeze({ support: 0.55, timeoutMs: 5000, maxBytes: 262144, maxSources: 20, maxClaims: 40 }),
});
