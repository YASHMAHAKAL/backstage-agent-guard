import { createServer, Server } from 'node:https';
import { rmSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { readCloudHttpsJson, validateSmokeCertificate } from './cloudHttps';
import { temporaryCertificate } from './testFixtures/cloudRuntimeFixture';

let cert: ReturnType<typeof temporaryCertificate>;
let server: Server;
let port: number;
let requests: string[];
beforeAll(async () => {
  cert = temporaryCertificate('localhost');
  requests = [];
  server = createServer({ key: cert.key, cert: cert.pem }, (req, res) => {
    requests.push(req.url!);
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/healthz' }).end();
      return;
    }
    if (req.url === '/unauthorized') {
      res.writeHead(401).end('private error');
      return;
    }
    if (req.url === '/large') {
      res.end(JSON.stringify({ large: 'x'.repeat(10000) }));
      return;
    }
    if (req.url === '/html') {
      res.end('<html>ok</html>');
      return;
    }
    if (req.url === '/timeout') return;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ status: req.url === '/readyz' ? 'ready' : 'alive' }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  rmSync(cert.directory, { recursive: true, force: true });
});
const read = (path: string, overrides = {}) =>
  readCloudHttpsJson({
    url: new URL(`https://localhost:${port}${path}`),
    ca: cert.pem,
    certificateSha256: cert.fingerprint,
    signal: new AbortController().signal,
    lookup: (_hostname, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }] as any),
    ...overrides,
  });
it('validates the reviewed self-signed leaf and performs a real certificate-pinned TLS GET', async () => {
  validateSmokeCertificate(cert.pem, 'localhost', cert.fingerprint);
  expect(await read('/healthz')).toEqual({ status: 'alive' });
  expect(await read('/readyz')).toEqual({ status: 'ready' });
});
it('rejects a trusted certificate with the wrong fingerprint', async () => {
  await expect(
    read('/healthz', { certificateSha256: `sha256:${'9'.repeat(64)}` }),
  ).rejects.toThrow();
});
it('rejects an untrusted certificate instead of disabling TLS', async () => {
  await expect(read('/healthz', { ca: '' })).rejects.toThrow();
});
it('rejects hostname mismatch', async () => {
  await expect(
    read('/healthz', { url: new URL(`https://wrong.invalid:${port}/healthz`) }),
  ).rejects.toThrow();
});
it('never follows a redirect', async () => {
  const before = requests.length;
  await expect(read('/redirect')).rejects.toThrow();
  expect(requests.slice(before)).toEqual(['/redirect']);
});
it.each(['/unauthorized', '/large', '/html'])(
  'rejects non-200, oversized or non-JSON response: %s',
  async path => {
    await expect(read(path, { maxBytes: 4096 })).rejects.toThrow();
  },
);
it('honors deadline cancellation', async () => {
  const controller = new AbortController();
  const promise = read('/timeout', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await expect(promise).rejects.toThrow();
});
it('rejects HTTP and embedded credentials before connecting', () => {
  expect(() =>
    read('/healthz', { url: new URL('http://localhost/healthz') }),
  ).toThrow();
  expect(() =>
    read('/healthz', {
      url: new URL('https://user:password@localhost/healthz'),
    }),
  ).toThrow();
});
it('rejects expired, wrong-SAN or changed certificates', () => {
  expect(() =>
    validateSmokeCertificate(cert.pem, 'wrong.invalid', cert.fingerprint),
  ).toThrow();
  expect(() =>
    validateSmokeCertificate(
      cert.pem,
      'localhost',
      cert.fingerprint,
      Date.now() + 7 * 86400000,
    ),
  ).toThrow();
  expect(() =>
    validateSmokeCertificate(cert.pem, 'localhost', `sha256:${'9'.repeat(64)}`),
  ).toThrow();
});
