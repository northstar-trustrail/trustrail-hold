// Offline verification of a proof bundle downloaded from Trustrail.
import { sha256Hex, canon } from './hash.js';
import { verifyCheckpoint } from './checkpoint.js';
export async function verifyProof(p, trustedPublicKey = p.publicKey) {
  const errs = [];
  for (const [i, c] of p.chain.entries()) if (c.seq !== i || c.prev !== (i ? p.chain[i - 1].hash : 'GENESIS')) errs.push(`chain link broken at ${i}`);
  for (const r of p.receipts) { const { hash, ...body } = r; if (await sha256Hex(canon(body)) !== hash) errs.push(`receipt ${r.seq} body does not match its hash`); if (p.chain[r.seq]?.hash !== hash) errs.push(`receipt ${r.seq} not in chain`); }
  if (!p.checkpoint) errs.push('no signed checkpoint');
  else {
    if (p.chain[p.checkpoint.length - 1]?.hash !== p.checkpoint.head) errs.push('checkpoint head not in chain');
    if (!(await verifyCheckpoint(p.checkpoint, trustedPublicKey))) errs.push('checkpoint signature invalid');
    const last = Math.max(...p.receipts.map(r => r.seq)); if (last >= p.checkpoint.length) errs.push(`receipts after seq ${p.checkpoint.length - 1} are not covered by the checkpoint`);
  }
  return { ok: errs.length === 0, errors: errs };
}
