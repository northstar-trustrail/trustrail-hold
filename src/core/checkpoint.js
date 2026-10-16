// Signed checkpoints over the receipt hash chain (ECDSA P-256, WebCrypto: Node + all browsers).
// Publish/retain checkpoints outside this server (e.g. TRUSTRAIL_CHECKPOINT_WEBHOOK or a git repo) so
// the operator cannot silently rewrite history: a rewritten chain no longer matches a signed head.
import { canon } from './hash.js';
const subtle = () => globalThis.crypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export class Signer {
  static async create(privateJwk) {
    const s = new Signer();
    if (privateJwk) { s.priv = await subtle().importKey('jwk', privateJwk, ALG, false, ['sign']); const { d, ...pub } = privateJwk; s.pubJwk = { ...pub, key_ops: ['verify'] }; }
    else { const kp = await subtle().generateKey(ALG, true, ['sign', 'verify']); s.priv = kp.privateKey; s.pubJwk = await subtle().exportKey('jwk', kp.publicKey); }
    s.keyId = (s.pubJwk.x || '').slice(0, 12); return s;
  }
  async sign(payload) { return b64(await subtle().sign(SIG, this.priv, new TextEncoder().encode(canon(payload)))); }
}
export async function verifyCheckpoint(cp, pubJwk) {
  const key = await subtle().importKey('jwk', { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, ALG, false, ['verify']);
  const { sig, ...payload } = cp;
  return subtle().verify(SIG, key, unb64(sig), new TextEncoder().encode(canon(payload)));
}
export class Checkpointer {
  constructor({ signer, every = 5, sink = null }) { Object.assign(this, { signer, every, sink, list: [] }); }
  async maybe(ledger, force = false) {
    const n = ledger.entries.length; const last = this.list.at(-1)?.length || 0;
    if (!force && n - last < this.every) return null;
    if (n === last) return null;
    const payload = { length: n, head: ledger.head, at: ledger.entries.at(-1).at, keyId: this.signer.keyId };
    const cp = { ...payload, sig: await this.signer.sign(payload) }; this.list.push(cp);
    if (this.sink) { try { await this.sink(cp); } catch { /* retention failure must not block settlement; surfaced via /api/checkpoints */ cp.retained = false; } }
    return cp;
  }
}
