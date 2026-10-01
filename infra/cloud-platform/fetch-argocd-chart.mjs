import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Public package download only: no AWS, Kubernetes, credentials or installation.
const lock = JSON.parse(
  await readFile(new URL('./charts.lock.json', import.meta.url), 'utf8'),
).charts['argo-cd'];
const archive = new URL(
  `../aws/argocd/.terraform/charts/argo-cd-${lock.version}.tgz`,
  import.meta.url,
);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let bytes = await readFile(archive).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (!bytes || digest(bytes) !== lock.sha256) {
  const response = await fetch(lock.url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Argo chart download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== lock.sha256)
    throw new Error('Argo chart checksum mismatch');
  await mkdir(new URL('.', archive), { recursive: true });
  await writeFile(archive, bytes, { mode: 0o600 });
}
console.log(`Verified Argo CD ${lock.version} archive cached for Terraform.`);
