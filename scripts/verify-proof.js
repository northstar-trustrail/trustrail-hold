// Verify a downloaded proof bundle offline: node scripts/verify-proof.js proof.json [trusted-public-key.json]
import fs from 'node:fs'; import { verifyProof } from '../src/core/proof.js';
const p = JSON.parse(fs.readFileSync(process.argv[2])); const key = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3])) : p.publicKey;
if (!process.argv[3]) console.warn('warning: using the public key embedded in the proof; pass the operator\'s published key to make this meaningful');
const r = await verifyProof(p, key); console.log(r.ok ? `OK: ${p.holdId} ${p.state}, ${p.receipts.length} receipts covered by signed checkpoint #${p.checkpoint.length}` : `FAILED: ${r.errors.join('; ')}`); process.exit(r.ok ? 0 : 1);
