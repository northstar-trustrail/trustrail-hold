import { Escrow } from './core/escrow.js';
import { MockPayPal } from './paypal/mock.js';
import { RestPayPal } from './paypal/rest.js';
import { brainFromEnv } from './ai/llm.js';
// Builds the escrow engine from environment. Mock PayPal unless sandbox credentials are present.
export function buildEscrow(env = process.env) {
  const paypal = env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
    ? new RestPayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com' })
    : new MockPayPal();
  const policy = env.TRUSTRAIL_POLICY ? JSON.parse(env.TRUSTRAIL_POLICY) : {};
  return new Escrow({ paypal, brain: brainFromEnv(env), policy, baseUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 8787}` });
}
