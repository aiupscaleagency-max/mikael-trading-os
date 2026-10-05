import http from 'node:http';
import https from 'node:https';

// Dator2 använder samma Trading-OS som dator1 genom befintlig Tailscale-TLS.
const upstream = new URL('https://aiupscale-dator1.tail64d627.ts.net:9443');
const port = Number(process.env.TRADING_FORWARD_PORT || 3939);
const localHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const localOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const frameOrigins = new Set(['https://agentic-os.tail64d627.ts.net', 'https://aiupscale-dator1.tail64d627.ts.net']);
function allowed(req) {
  if (!localHosts.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !localOrigins.has(origin)) return false;
  if ((!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) && !origin) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    try {
      if (!['GET', 'HEAD'].includes(req.method) || req.headers['sec-fetch-mode'] !== 'navigate' || !frameOrigins.has(new URL(req.headers.referer).origin)) return false;
    } catch { return false; }
  }
  return true;
}
const headers = (incoming) => {
  const result = { ...incoming, host: upstream.host, origin: upstream.origin };
  // Bara verifierade lokala anrop får den befintliga Tailscale-identiteten.
  delete result['x-forwarded-host']; delete result['x-forwarded-for'];
  delete result['x-forwarded-proto'];
  if (result.referer) result.referer = upstream.origin + '/';
  return result;
};
const options = (req) => ({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: headers(req.headers) });
const server = http.createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end('Otillåten lokal källa.'); return; }
  const outgoing = https.request(options(req), (response) => {
    outgoing.setTimeout(0);
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('Tidsgräns för uppströmsanslutning')));
  outgoing.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Trading-OS på dator1 kan inte nås.'); }
    else res.destroy();
  });
  req.on('aborted', () => outgoing.destroy());
  res.on('close', () => outgoing.destroy());
  req.pipe(outgoing);
});
server.on('error', (err) => { console.error(`Vidarekopplingen kunde inte starta (${err.code || 'okänt fel'}).`); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(`Trading-OS vidarekopplad på localhost:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
