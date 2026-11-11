import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const equal = (a, b) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

// This optional bridge keeps the inference server and its existing checks on loopback.
export function createMobileBridge({
  key,
  cert,
  address,
  publicOrigin,
  upstreamPort = 4317,
  pairingKey = randomBytes(32).toString('hex'),
  pairingCode = randomBytes(6).toString('hex').toUpperCase(),
  session = randomBytes(32).toString('hex')
}) {
  const root = new URL('../public/', import.meta.url);
  const publicAssets = {
    '/manifest.webmanifest': 'application/manifest+json',
    '/icon.svg': 'image/svg+xml',
    '/apple-touch-icon.png': 'image/png',
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
    '/mobile.css': 'text/css'
  };
  let failures = 0,
    failureWindow = 0;
  // A tunnel terminates HTTPS externally. Its bridge accepts loopback traffic
  // only and pins the public origin explicitly, never from forwarded headers.
  const listener = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
    );
    const deny = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    };
    const connectPage = async (status = 200, message = '') => {
      // Native form POSTs can send Origin:null under no-referrer. Keep the
      // real origin for this same-origin form while still hiding cross-site refs.
      // Pairing-link redirects retain the stricter no-referrer policy above.
      res.setHeader('Referrer-Policy', 'same-origin');
      const html = (await readFile(new URL('mobile-connect.html', root), 'utf8')).replace(
        '<!--PAIR_ERROR-->',
        message ? `<p class="error" role="alert">${message}</p>` : ''
      );
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    try {
      const origin = publicOrigin ? publicOrigin() : `https://${address}:${server.address().port}`;
      if (!origin)
        return deny(503, 'Подключение запускается.');
      const endpoint = new URL(origin);
      if (endpoint.protocol !== 'https:' || endpoint.origin !== origin)
        return deny(503, 'Адрес подключения не настроен.');
      const host = endpoint.host;
      if (
        publicOrigin &&
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      )
        return deny(403, 'Недопустимое подключение.');
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin))
        return deny(403, 'Недопустимый источник.');
      const url = new URL(req.url, `https://${host}`);
      if (['GET', 'POST'].includes(req.method) && url.pathname === '/pair') {
        if (Date.now() - failureWindow > 60000) {
          failures = 0;
          failureWindow = Date.now();
        }
        if (failures >= 8) {
          res.setHeader('Retry-After', '60');
          return deny(429, 'Слишком много попыток. Подожди минуту.');
        }
        let valid;
        if (req.method === 'GET')
          valid = equal(url.searchParams.get('key'), pairingKey);
        else {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024)
              return deny(413, 'Код слишком длинный.');
          }
          const code = (new URLSearchParams(body).get('code') || '')
            .replace(/[\s-]/g, '')
            .toUpperCase();
          valid = equal(code, pairingCode);
        }
        if (!valid) {
          failures++;
          return req.method === 'POST'
            ? await connectPage(403, 'Код не подошёл. Проверь код на Mac и попробуй снова.')
            : deny(403, 'Нужна персональная ссылка Claro.');
        }
        failures = 0;
        res.writeHead(303, {
          Location: '/mobile',
          'Set-Cookie': `__Host-claro=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`
        });
        return res.end();
      }
      if (req.method === 'GET' && publicAssets[url.pathname]) {
        let data = await readFile(new URL(url.pathname.slice(1), root));
        if (url.pathname === '/manifest.webmanifest') {
          // The phone app opens the pairing-aware entry point.
          const manifest = JSON.parse(data);
          manifest.start_url = '/mobile';
          data = JSON.stringify(manifest);
        }
        res.writeHead(200, { 'Content-Type': publicAssets[url.pathname] });
        return res.end(data);
      }
      const cookie = (req.headers.cookie || '')
        .split(';')
        .map(x => x.trim())
        .find(x => x.startsWith('__Host-claro='))
        ?.slice('__Host-claro='.length);
      if (!equal(cookie, session)) {
        if (req.method === 'GET' && ['/', '/mobile'].includes(url.pathname))
          return await connectPage();
        return deny(401, 'Подключи Claro к Mac по персональному коду.');
      }
      // Do not forward caller-supplied proxy headers, cookies, or host names.
      const headers = { host: `127.0.0.1:${upstreamPort}` };
      for (const name of [
        'content-type',
        'content-length',
        'x-session-token',
        'accept',
        'last-event-id'
      ])
        if (req.headers[name])
          headers[name] = req.headers[name];
      if (req.headers.origin)
        headers.origin = `http://127.0.0.1:${upstreamPort}`;
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: url.pathname === '/mobile' ? '/' : req.url,
          method: req.method,
          headers
        },
        response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent)
          deny(502, 'Claro на Mac недоступен. Запусти npm start.');
        else
          res.end();
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      if (!res.headersSent)
        deny(500, 'Не удалось открыть Claro. Проверь запуск на Mac.');
      else
        res.end();
    }
  };
  const server = publicOrigin
    ? http.createServer(listener)
    : https.createServer({ key, cert, minVersion: 'TLSv1.2' }, listener);
  return { server, pairingKey, pairingCode, session };
}
