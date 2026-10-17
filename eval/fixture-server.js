// Local eval-only source server. Serves a dataset's sourceFixtures on 127.0.0.1, keyed by Host + path,
// so the real fetchPublicSource transport (size caps, content type, status, redirects) is exercised offline.
// The box resolves every hostname to a non-public address, which the production SSRF guard refuses.
import http from 'node:http';
import { evalFixtureRoutes } from '../src/ai/source-fetch.js';
export async function startFixtureServer(fixtures) {
  const byKey = new Map(Object.entries(fixtures).map(([u, f]) => { const x = new URL(u); return [`${x.host.toLowerCase()}${x.pathname}${x.search}`, f]; }));
  const server = http.createServer((req, res) => {
    const f = byKey.get(`${String(req.headers.host).toLowerCase()}${req.url}`);
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('Not found'); }
    const body = f.status === 200 ? `<html><head><title>${f.title || ''}</title></head><body>${f.text.split(/\n+/).map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n')}</body></html>` : f.text;
    res.writeHead(f.status, { 'Content-Type': f.contentType || 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const hosts = [...new Set(Object.keys(fixtures).map(u => new URL(u).hostname))];
  return { routes: evalFixtureRoutes(hosts, server.address().port), hosts, close: () => new Promise(r => server.close(r)) };
}
