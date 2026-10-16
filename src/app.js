import { HoldService } from './core/holds.js';
import { MockPayPal } from './paypal/mock.js';
import { RestPayPal } from './paypal/rest.js';
import { MiniLMEmbedder, LexicalEmbedder } from './ai/embed.js';
import { OpenAICompatJudge, LocalQwenJudge } from './ai/judge.js';
import { Signer } from './core/checkpoint.js';
import fs from 'node:fs';
import { FileStore } from './core/store.js';

export function paypalFromEnv(env) {
  return env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
    ? new RestPayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com' })
    : new MockPayPal();
}
/** TRUSTRAIL_JUDGE: none | local (Qwen2.5-0.5B, free) | openai (needs AI_BASE_URL/AI_MODEL[/AI_API_KEY]). */
export function judgeFromEnv(env) {
  const j = env.TRUSTRAIL_JUDGE || (env.AI_BASE_URL && env.AI_MODEL ? 'openai' : 'none');
  if (j === 'openai') return new OpenAICompatJudge({ baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model: env.AI_MODEL });
  if (j === 'local') return new LocalQwenJudge();
  return null;
}
export async function buildService(env = process.env) {
  let embedder = env.TRUSTRAIL_EMBEDDER === 'lexical' ? new LexicalEmbedder() : new MiniLMEmbedder();
  if (embedder instanceof MiniLMEmbedder) { try { await embedder.load(); } catch (e) { console.error('MiniLM unavailable, using lexical fallback:', e.message); embedder = new LexicalEmbedder(); } }
  const signer = env.TRUSTRAIL_SIGNING_JWK ? await Signer.create(JSON.parse(env.TRUSTRAIL_SIGNING_JWK)) : undefined;
  const file = env.TRUSTRAIL_CHECKPOINT_FILE; const hook = env.TRUSTRAIL_CHECKPOINT_WEBHOOK;
  const checkpointSink = async cp => {
    if (file) fs.appendFileSync(file, JSON.stringify(cp) + '\n');
    if (hook) { const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cp) }); if (!r.ok) throw new Error(`webhook ${r.status}`); }
  };
  const judge = judgeFromEnv(env);
  return HoldService.create({ paypal: paypalFromEnv(env), embedder, judge, intentLlm: judge?.complete ? judge : null, signer, checkpointSink,
    store: new FileStore(env.TRUSTRAIL_STORE || './data/trustrail.json'),
    sandboxCard: env.TRUSTRAIL_SANDBOX_CARD ? { number: env.TRUSTRAIL_SANDBOX_CARD, expiry: env.TRUSTRAIL_SANDBOX_CARD_EXPIRY || '2030-12', cvv: '123' } : null,
    policy: env.TRUSTRAIL_POLICY ? JSON.parse(env.TRUSTRAIL_POLICY) : {}, baseUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 8787}` });
}
/** Bearer token -> principal. Override with TRUSTRAIL_TOKENS='{"tok":{"id":"..","role":"..","org":".."}}'. Demo tokens are for local use only. */
export const DEMO_TOKENS = {
  'demo-agent': { id: 'research-agent', role: 'buyer_agent', org: 'acme-labs' },
  'demo-buyer': { id: 'acme-buyer', role: 'buyer', org: 'acme-labs' },
  'demo-seller': { id: 'briefsmith', role: 'seller' },
  'demo-seller-2': { id: 'quickbriefs', role: 'seller' },
  'demo-reviewer': { id: 'acme-reviewer', role: 'reviewer' },
  'demo-auditor': { id: 'auditor', role: 'auditor' },
};
export const tokensFromEnv = env => env.TRUSTRAIL_TOKENS ? JSON.parse(env.TRUSTRAIL_TOKENS) : DEMO_TOKENS;
