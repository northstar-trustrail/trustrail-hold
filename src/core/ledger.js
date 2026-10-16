import { sha256Hex, canon } from './hash.js';
// Append-only, hash-chained receipt log. Each entry commits to the previous one,
// so any edit to history breaks verification (proof-of-payment trail).
export class Ledger {
  constructor() { this.entries = []; }
  get head() { return this.entries.length ? this.entries[this.entries.length - 1].hash : 'GENESIS'; }
  async append(event) {
    const body = { seq: this.entries.length, prev: this.head, at: event.at || new Date().toISOString(), ...event };
    const hash = await sha256Hex(canon(body));
    const entry = { ...body, hash };
    this.entries.push(entry);
    return entry;
  }
  forHold(holdId) { return this.entries.filter(e => e.holdId === holdId); }
  static async verify(entries) {
    let prev = 'GENESIS';
    for (const [i, e] of entries.entries()) {
      const { hash, ...body } = e;
      if (body.seq !== i || body.prev !== prev) return { ok: false, at: i, reason: 'chain broken' };
      if (await sha256Hex(canon(body)) !== hash) return { ok: false, at: i, reason: 'hash mismatch' };
      prev = hash;
    }
    return { ok: true, length: entries.length, head: prev };
  }
}
/** True if a signed checkpoint's head is present at its claimed position in this chain. */
export function chainMatchesCheckpoint(entries, cp) { return entries.length >= cp.length && entries[cp.length - 1]?.hash === cp.head; }
