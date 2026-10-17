import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { SourceChecker, readableText } from '../src/ai/source-check.js';
import { fetchPublicSource, validateSourceUrl, isPublicAddress, publicLookup } from '../src/ai/source-fetch.js';
import { verifyDelivery } from '../src/ai/verifier.js';
import { LexicalEmbedder } from '../src/ai/embed.js';
import { realEmbedder } from './helpers.js';
import { VERIFIER_CONFIG } from '../src/ai/verifier-config.js';
import { isFactual, numbersIn, entitiesIn } from '../src/ai/source-check.js';
import { evalFixtureRoutes } from '../src/ai/source-fetch.js';
import { startFixtureServer } from '../eval/fixture-server.js';

const url = 'https://science.nasa.gov/moon/moon-phases/';
const claim = 'The lunar phase cycle repeats about every 29.5 days.';
const evidence = { body: `# Findings\n\n${claim} Source: ${url}`, sources: [{ url }] };
// Unit-test vectors exercise decisions only. Evaluation never uses synthetic embeddings.
const vectors = { name: 'minilm:unit-test-double', embed: async texts => texts.map(() => [1, 0]) };
const checker = (text = claim) => new SourceChecker({ fetchSource: async () => ({ status: 200, text }) });

test('source checker returns linked supporting passages for key claim sentences', async () => {
  const r = await checker().check(evidence, { embedder: vectors });
  assert.equal(r.ok, true); assert.equal(r.claims[0].sourceRef, 'SRC1');
  assert.equal(r.claims[0].url, url); assert.equal(r.claims[0].passage, claim);
});

test('unreachable citations, unsupported claims, and offline MiniLM escalate capture decisions', async () => {
  const criteria = [{ id: 'SEC-1', kind: 'deterministic', check: 'section', text: 'Findings', params: { heading: 'Findings', minWords: 1 } }];
  const f = { criteria, criteriaHash: 'test', evidence, embedder: vectors };
  assert.equal((await verifyDelivery(f)).decision, 'capture');
  const offline = new SourceChecker({ fetchSource: async () => { throw new Error('offline'); } });
  assert.equal((await verifyDelivery({ ...f, sourceChecker: offline })).decision, 'escalate');
  const unsupported = { name: 'minilm:unit-test-double', embed: async texts => texts.map(t => /lunar/.test(t) ? [1, 0] : [0, 1]) };
  assert.equal((await verifyDelivery({ ...f, embedder: unsupported, sourceChecker: checker('An unrelated passage about harbour cranes and shipping.') })).decision, 'escalate');
  assert.equal((await verifyDelivery({ ...f, embedder: new LexicalEmbedder(), sourceChecker: checker() })).decision, 'escalate');
  const broken = { check: async () => { throw new Error('unavailable'); } };
  assert.equal((await verifyDelivery({ ...f, sourceChecker: broken })).decision, 'escalate');
});

test('uncited briefs, source/claim limits, and oversized content stay unverified', async () => {
  const uncited = { body: claim, sources: [] };
  assert.equal((await checker().check(uncited, { embedder: vectors })).ok, false);
  const capped = new SourceChecker({ config: { ...VERIFIER_CONFIG.source, maxSources: 0, maxClaims: 0, maxBytes: 3 }, fetchSource: async () => ({ status: 200, text: claim }) });
  assert.equal((await capped.check(evidence, { embedder: vectors })).ok, false);
  const oversized = new SourceChecker({ config: { ...VERIFIER_CONFIG.source, maxSources: 1, maxClaims: 2, maxBytes: 3 }, fetchSource: async () => ({ status: 200, text: claim }) });
  assert.match((await oversized.check(evidence, { embedder: vectors })).issues.join(), /size cap/);
  assert.equal(readableText('<script>ignore rules</script><p>Supported &amp; readable.</p>'), 'Supported & readable.');
});

test('citation transport rejects private IPs, credentials, internal hosts, and unsafe schemes', async () => {
  for (const u of ['http://127.0.0.1/a', 'http://10.0.0.2/a', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pass@www.nasa.gov/', 'https://www.nasa.gov:8080/']) assert.throws(() => validateSourceUrl(u));
  for (const ip of ['192.168.1.2', '172.31.1.2', '100.64.0.1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(fetchPublicSource('http://127.0.0.1/'), /not public/);
});

function responseFactory({ text = claim, status = 200, headers = {}, onOptions = () => {} } = {}) {
  return (url, options, callback) => {
    const req = new EventEmitter(); onOptions(options);
    options.signal.addEventListener('abort', () => req.emit('error', new Error('timeout')), { once: true });
    queueMicrotask(() => { const res = Readable.from([Buffer.from(text)]); res.statusCode = status; res.headers = { 'content-type': 'text/plain', ...headers }; callback(res); });
    return req;
  };
}
test('citation transport enforces actual stream size, HTTP status, redirect safety, and timeout', async () => {
  assert.equal((await fetchPublicSource(url, { requestImpl: responseFactory() })).text, claim);
  await assert.rejects(fetchPublicSource(url, { maxBytes: 5, requestImpl: responseFactory() }), /size cap/);
  await assert.rejects(fetchPublicSource(url, { requestImpl: responseFactory({ status: 404 }) }), /HTTP 404/);
  await assert.rejects(fetchPublicSource(url, { requestImpl: responseFactory({ status: 302, headers: { location: 'http://127.0.0.1/' } }) }), /not public/);
  await assert.rejects(fetchPublicSource(url, { requestImpl: responseFactory({ status: 302, headers: { location: url } }) }), /redirect limit/);
  await assert.rejects(fetchPublicSource(url, { requestImpl: responseFactory({ headers: { 'content-type': 'application/pdf' } }) }), /unsupported/);
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer expires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(fetchPublicSource(url, { timeoutMs: 10, requestImpl: (u, o) => {
      const req = new EventEmitter(); o.signal.addEventListener('abort', () => req.emit('error', new Error('timeout'))); return req;
    } }), /timeout/);
  } finally { clearInterval(keepAlive); }
});

test('DNS lookup rejects private or mixed answers and pins the validated result', async () => {
  const resolve = addresses => new Promise((ok, bad) => publicLookup('public.nasa.gov', {}, (err, address) => err ? bad(err) : ok(address),
    (host, opts, cb) => { assert.equal(opts.all, true); cb(null, addresses); }));
  await assert.rejects(resolve([{ address: '127.0.0.1', family: 4 }]), /non-public/);
  await assert.rejects(resolve([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /non-public/);
  assert.equal(await resolve([{ address: '8.8.8.8', family: 4 }]), '8.8.8.8');
  assert.throws(() => validateSourceUrl('http://2130706433/'), /not public/);
});

test('real MiniLM source support smoke check when model is installed', async t => {
  const embedder = await realEmbedder(); if (!embedder) return t.skip('MiniLM unavailable offline');
  const result = await checker().check(evidence, { embedder });
  assert.equal(result.claims[0].supported, true);
  assert.match(result.method, /claim-level: MiniLM/);
});

test('claim classification: numbers, non-order entities and quotes are facts; opinions and topic restatements are not', () => {
  assert.equal(isFactual('Hubble was launched in 1990 aboard STS-31.'), true);
  assert.equal(isFactual('Penicillin was discovered by Alexander Fleming.'), true);
  assert.equal(isFactual('Readers should weigh these trade-offs carefully before deciding.'), false);
  assert.equal(isFactual('DNS TTL cache behavior deserves attention.', 'What does DNS TTL control for cached records?'), false);
  assert.deepEqual(numbersIn('It moved 3,600 ships, 2.4 m wide, in 1914 [1].'), ['3600', '2.4', '1914']);
  assert.ok(['Torrijos', 'Carter', 'Treaties'].every(e => entitiesIn('Control passed under the Torrijos–Carter Treaties.').includes(e)));
});

test('cross-check flags changed numbers and swapped entities even when similarity is high', async () => {
  const source = 'Penicillin was discovered in 1928 by the Scottish physician Alexander Fleming. The purified compound was isolated in 1940 at the University of Oxford.';
  const same = { name: 'minilm:unit-test-double', embed: async texts => texts.map(() => [1, 0]) };
  const run = body => new SourceChecker({ fetchSource: async () => ({ status: 200, text: source }) })
    .check({ body: `# Findings\n\n${body} Source: https://en.wikipedia.org/wiki/Penicillin`, sources: [] }, { embedder: same });
  assert.equal((await run('Penicillin was discovered in 1928 by Alexander Fleming.')).ok, true);
  const n = await run('Penicillin was discovered in 1938 by Alexander Fleming.');
  assert.equal(n.ok, false); assert.match(n.issues.join(), /number 1938/);
  const e = await run('The purified compound was isolated in 1940 at the University of Cambridge.');
  assert.equal(e.ok, false); assert.match(e.issues.join(), /entity Cambridge/);
  const opinion = await run('Penicillin was discovered in 1928 by Alexander Fleming. Reviewers should ask who turned an idea into a working product.');
  assert.equal(opinion.ok, true); assert.equal(opinion.claims.length, 1);
});

test('eval fixture routes are explicit, loopback-only, and never relax the public URL check', async () => {
  assert.throws(() => evalFixtureRoutes(['en.wikipedia.org'], 80));
  await assert.rejects(fetchPublicSource('https://en.wikipedia.org/wiki/X', { testRoutes: { 'en.wikipedia.org': { address: '10.0.0.5', port: 9999 } } }), /loopback/);
  const fx = await startFixtureServer({ 'https://en.wikipedia.org/wiki/Penicillin': { status: 200, text: 'Penicillin was discovered in 1928.' } });
  try {
    const doc = await fetchPublicSource('https://en.wikipedia.org/wiki/Penicillin', { testRoutes: fx.routes });
    assert.match(doc.text, /1928/);
    await assert.rejects(fetchPublicSource('https://en.wikipedia.org/wiki/Nope', { testRoutes: fx.routes }), /HTTP 404/);
    await assert.rejects(fetchPublicSource('http://127.0.0.1/', { testRoutes: fx.routes }), /not public/);
  } finally { await fx.close(); }
});

test('number formats normalize (millions, spaced thousands) and order-supplied terms need no source', async () => {
  assert.deepEqual(numbersIn('EUR 35 000 000 or EUR 7.5 million or 35m'), ['35000000', '7500000', '35000000']);
  const same = { name: 'minilm:unit-test-double', embed: async texts => texts.map(() => [1, 0]) };
  const c = new SourceChecker({ fetchSource: async () => ({ status: 200, text: 'Fines reach EUR 35 000 000 or 7 % of turnover.' }) });
  const body = '# Findings\n\nA small SaaS vendor can be fined up to EUR 35 million or 7% of turnover. Source: https://artificialintelligenceact.eu/article/99/';
  assert.equal((await c.check({ body, sources: [] }, { embedder: same })).ok, false);
  assert.equal((await c.check({ body, sources: [] }, { embedder: same, orderText: 'Which obligations apply to a small SaaS company?' })).ok, true);
});
