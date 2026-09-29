import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { cloudDeliveryFixture } from './testFixtures/cloudDeliveryFixture';
import { canonicalize } from './snapshot';

const root = resolve(__dirname, '../../..');
const bundle = resolve(root, 'infra/cloud-gitops/dist/validate.cjs');
let scratch: string;
let repo: string;
let targetFile: string;
let base: string;
const proposal = cloudDeliveryFixture();
const target = proposal.snapshot.envelope.target;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
beforeAll(() =>
  execFileSync('node', [resolve(root, 'infra/cloud-gitops/build.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'rizz-policy-fixture-'));
  repo = join(scratch, 'gitops');
  mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'Synthetic test repository.\n');
  git('add', '.');
  git('commit', '-m', 'fixture base');
  base = git('rev-parse', 'HEAD');
  targetFile = join(scratch, 'target.json');
  writeFileSync(targetFile, JSON.stringify(target));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));
function files() {
  for (const file of proposal.snapshot.files) {
    const path = join(repo, file.path);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, file.content);
  }
}
function run() {
  git('add', '.');
  git('commit', '-m', 'fixture candidate');
  const result = spawnSync(
    'node',
    [bundle, repo, targetFile, base, git('rev-parse', 'HEAD')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Rizz manifest policy failed');
    throw new Error('Policy rejected');
  }
  return `${result.stdout}${result.stderr}`;
}
it('accepts the exact nine-file recipe using the real standalone trusted bundle', () => {
  files();
  expect(run()).toContain('policy: valid');
});
it('passes an unrelated-only PR without pretending it deploys the app', () => {
  writeFileSync(join(repo, 'README.md'), 'Changed documentation.\n');
  expect(run()).toContain('not_applicable');
});
it.each([
  'extraFile',
  'missingFile',
  'replicas',
  'publicBackend',
  'tagImage',
  'runtime',
  'namespace',
  'ingress',
  'secret',
  'unrelatedChange',
  'symlink',
  'noncanonical',
])('fails forbidden cloud changes: %s', issue => {
  files();
  const change = (name: string, modify: (data: any) => void) => {
    const file = proposal.snapshot.files.find(f =>
      f.path.endsWith(`/${name}`),
    )!;
    const data = JSON.parse(file.content);
    modify(data);
    // Even canonicalizing the mutation cannot evade exact recipe comparison.
    writeFileSync(join(repo, file.path), `${canonicalize(data)}\n`);
  };
  const app = join(repo, target.gitopsPath);
  if (issue === 'extraFile') writeFileSync(join(app, 'extra.yaml'), '{}\n');
  if (issue === 'missingFile') rmSync(join(app, 'runtime.yaml'));
  if (issue === 'replicas')
    change('backend-deployment.yaml', data => {
      data.spec.replicas = 3;
    });
  if (issue === 'publicBackend')
    change('backend-service.yaml', data => {
      data.spec.type = 'LoadBalancer';
    });
  if (issue === 'tagImage')
    change('frontend-deployment.yaml', data => {
      data.spec.template.spec.containers[0].image = 'example/frontend:latest';
    });
  if (issue === 'runtime')
    change('runtime.yaml', data => {
      data.data.MAX_PROVIDER_CALLS = '99999';
    });
  if (issue === 'namespace')
    change('runtime.yaml', data => {
      data.metadata.namespace = 'default';
    });
  if (issue === 'ingress')
    change('ingress.yaml', data => {
      data.metadata.annotations['alb.ingress.kubernetes.io/inbound-cidrs'] =
        '0.0.0.0/0';
    });
  if (issue === 'secret')
    change('external-secret.yaml', data => {
      data.spec.target.template = { data: { key: 'plaintext' } };
    });
  if (issue === 'unrelatedChange')
    writeFileSync(join(repo, 'README.md'), 'Unexpected combined change.\n');
  if (issue === 'symlink') {
    rmSync(join(app, 'runtime.yaml'));
    symlinkSync('frontend-service.yaml', join(app, 'runtime.yaml'));
  }
  if (issue === 'noncanonical')
    writeFileSync(
      join(app, 'runtime.yaml'),
      `${
        proposal.snapshot.files.find(f => f.path.endsWith('/runtime.yaml'))!
          .content
      } `,
    );
  expect(run).toThrow('Policy rejected');
});
