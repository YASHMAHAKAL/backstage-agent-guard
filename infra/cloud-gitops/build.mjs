import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Local build only; no install, GitHub calls or generated identity configuration.
await build({
  entryPoints: [resolve(root, 'infra/cloud-gitops/cli.ts')],
  outfile: resolve(root, 'infra/cloud-gitops/dist/validate.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  treeShaking: true,
  legalComments: 'eof',
});
