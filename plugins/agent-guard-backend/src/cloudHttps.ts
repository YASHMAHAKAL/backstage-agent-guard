import { createHash, X509Certificate } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import type { LookupFunction } from 'node:net';

// Native HTTPS: explicit TLS verification even if ambient NODE_TLS settings are
// unsafe. No redirects, cookies, automatic retries, response logs or connection
// reuse. A lookup override is an injected test transport, never configuration.
export function readCloudHttpsJson(options: {
  url: URL;
  ca?: string;
  signal: AbortSignal;
  token?: string;
  certificateSha256?: string;
  maxBytes?: number;
  lookup?: LookupFunction;
}): Promise<unknown> {
  if (
    options.url.protocol !== 'https:' ||
    options.url.username ||
    options.url.password ||
    options.url.hash
  )
    throw new Error('HTTPS only');
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      options.url,
      {
        signal: options.signal,
        ca: options.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        ...(options.lookup ? { lookup: options.lookup } : {}),
        headers: {
          Accept: 'application/json',
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
        },
        checkServerIdentity: (hostname, certificate) => {
          const error = checkServerIdentity(hostname, certificate);
          if (error) return error;
          if (
            options.certificateSha256 &&
            (!certificate.raw ||
              `sha256:${createHash('sha256')
                .update(certificate.raw)
                .digest('hex')}` !== options.certificateSha256)
          )
            return new Error('Peer certificate fingerprint mismatch');
          return undefined;
        },
      },
      response => {
        if (response.statusCode !== 200) {
          req.destroy();
          reject(new Error('HTTPS check unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 2 * 1024 * 1024))
            req.destroy(new Error('HTTPS response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid HTTPS response'));
          }
        });
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error('HTTPS check timeout')));
    req.on('error', () => reject(new Error('HTTPS check unavailable')));
  });
}

/** Bounded text reader for the one fixed, private Kubernetes Service proxy.
 * Never expose its raw response to browsers or logs. */
export function readCloudHttpsText(options: {
  url: URL;
  ca: string;
  signal: AbortSignal;
  token: string;
  maxBytes?: number;
  lookup?: LookupFunction;
}): Promise<string> {
  if (
    options.url.protocol !== 'https:' ||
    options.url.username ||
    options.url.password ||
    options.url.hash
  )
    throw new Error('HTTPS only');
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      options.url,
      {
        signal: options.signal,
        ca: options.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        ...(options.lookup ? { lookup: options.lookup } : {}),
        headers: {
          Accept: 'text/plain',
          Authorization: `Bearer ${options.token}`,
        },
      },
      response => {
        if (response.statusCode !== 200) {
          req.destroy();
          reject(new Error('Private metrics unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 65536))
            req.destroy(new Error('Metrics response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf8')),
        );
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error('Metrics timeout')));
    req.on('error', () => reject(new Error('Private metrics unavailable')));
  });
}

export function validateSmokeCertificate(
  pem: string,
  hostname: string,
  fingerprint: string,
  now = Date.now(),
) {
  const cert = new X509Certificate(pem);
  if (
    cert.ca ||
    cert.issuer !== cert.subject ||
    !cert.verify(cert.publicKey) ||
    Date.parse(cert.validFrom) > now ||
    Date.parse(cert.validTo) <= now ||
    cert.subjectAltName !== `DNS:${hostname}` ||
    cert.checkHost(hostname, { wildcards: false, subject: 'never' }) !==
      hostname ||
    `sha256:${createHash('sha256').update(cert.raw).digest('hex')}` !==
      fingerprint
  )
    throw new Error('Reviewed smoke certificate mismatch');
}
