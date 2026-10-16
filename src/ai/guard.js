// Delivery evidence is written by the *seller*, the party who gets paid on release.
// Treat it as hostile input: detect attempts to instruct the verifier.
const PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|rules|criteria)/i,
  /(you are|act as) (now )?(the|an?) (verifier|judge|assistant|system)/i,
  /\b(approve|release|capture) (the )?(payment|funds|escrow|hold)\b/i,
  /mark (this|all|every) (criteri(on|a)|check)s? (as )?(pass|met|passed)/i,
  /<\/?(system|instructions?)>/i,
  /\bsystem prompt\b/i,
];
export function scanInjection(text = '') {
  const hits = PATTERNS.filter(p => p.test(text)).map(p => text.match(p)[0]);
  return { suspicious: hits.length > 0, hits };
}
