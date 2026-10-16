// Embedder interface: embed(texts: string[]) -> Promise<number[][]> (unit vectors).
export const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/**
 * Real sentence-embedding model: all-MiniLM-L6-v2 (Apache-2.0) via transformers.js,
 * running locally (Node or browser). Free, no API key, no data leaves the machine.
 * Weights (~23 MB, q8) download from the Hugging Face Hub on first use.
 */
export class MiniLMEmbedder {
  constructor({ moduleUrl = '@huggingface/transformers', model = 'Xenova/all-MiniLM-L6-v2' } = {}) { this.moduleUrl = moduleUrl; this.model = model; this.name = `minilm:${model.split('/').pop()}`; }
  async load() { if (!this.pipe) { const t = await import(this.moduleUrl); this.pipe = await t.pipeline('feature-extraction', this.model, { dtype: 'q8', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } }); } return this; }
  // One text per call: no cross-text padding, single-threaded session -> reproducible scores.
  async embed(texts) { await this.load(); const out = []; for (const t of texts) out.push((await this.pipe([t], { pooling: 'mean', normalize: true })).tolist()[0]); return out; }
}

/**
 * NOT a model. Bag-of-words hashing vectors, used only by unit tests and as a
 * last-resort fallback when the model cannot load. The UI labels it as such.
 */
export class LexicalEmbedder {
  constructor(dim = 512) { this.dim = dim; this.name = 'lexical-fallback (not AI)'; }
  vec(t) {
    const v = new Array(this.dim).fill(0);
    for (const w of t.toLowerCase().match(/[a-z0-9]{3,}/g) || []) { let h = 2166136261; for (const ch of w.slice(0, 6)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); v[(h >>> 0) % this.dim] += 1; }
    const n = Math.hypot(...v) || 1; return v.map(x => x / n);
  }
  async embed(texts) { return texts.map(t => this.vec(t)); }
}
