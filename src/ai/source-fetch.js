// Bounded, public-network-only source transport. Never send app credentials to a citation.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { VERIFIER_CONFIG } from './verifier-config.js';

export function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Accept global unicast only; exclude documentation, Teredo, and 6to4 ranges.
  return isIP(ip) === 6 && /^[23]/i.test(ip) && !/^2001:(?:db8|0{0,4})(?::|$)/i.test(ip) && !/^2002:/i.test(ip);
}
export function validateSourceUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && !['80', '443'].includes(url.port)) || /(^|\.)(localhost|local|internal|invalid|test)$/.test(host) ||
    (isIP(host) && !isPublicAddress(host))) throw new Error('citation URL is not public HTTP(S)');
  return url;
}
export function publicLookup(host, opts, cb, lookup = dns.lookup) {
  lookup(host, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return cb(new Error('citation DNS resolves to a non-public address'));
    cb(null, opts.all ? addresses : addresses[0].address, addresses[0].family);
  });
}
export async function fetchPublicSource(value, { timeoutMs = VERIFIER_CONFIG.source.timeoutMs, maxBytes = VERIFIER_CONFIG.source.maxBytes, requestImpl = null } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  async function read(value, redirects = 0) {
    const url = validateSourceUrl(value);
    return new Promise((resolve, reject) => {
      const req = (requestImpl || (url.protocol === 'https:' ? https : http).get)(url, {
        signal, agent: false, headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'Trustrail-source-check/1' },
        // Pin the validated DNS result to this connection, including each redirect.
        lookup: publicLookup,
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (++redirects > 3 || !res.headers.location) return reject(new Error('citation redirect limit'));
          try { resolve(read(new URL(res.headers.location, url), redirects)); } catch (e) { reject(e); } return;
        }
        if (res.statusCode !== 200) { res.destroy(); return reject(new Error(`citation HTTP ${res.statusCode}`)); }
        if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(res.headers['content-type'] || '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { res.destroy(); return reject(new Error('unsupported citation content type or encoding')); }
        if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); return reject(new Error('citation size cap')); }
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(new Error('citation size cap')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ url: url.href, status: 200, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
    });
  }
  return read(value);
}
