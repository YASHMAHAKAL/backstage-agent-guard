import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { ConfigReader } from '@backstage/config';
import {
  GitHubEcrReleaseSource,
  createReleaseCatalog,
  parseReleaseArchive,
} from './releaseSource';
import {
  ReleaseCatalog,
  ReleasePolicy,
  ReleaseRecord,
  releaseDigest,
} from './releases';

const policy: ReleasePolicy = {
  repository: 'example-owner/Rizz.AI',
  ref: 'refs/heads/master',
  workflowPath: '.github/workflows/publish.yml',
  frontendRepository:
    '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-frontend',
  backendRepository:
    '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend',
};
const hash = (bytes: Buffer | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const now = Date.parse('2026-09-26T12:00:00Z');
function zipFile(body: string, name = 'release.json', compress = false) {
  const bytes = Buffer.from(body);
  const filename = Buffer.from(name);
  const packed = compress ? deflateRawSync(bytes) : bytes;
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(compress ? 8 : 0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(compress ? 8 : 0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}
function fixture() {
  const manifests = {
    frontend: JSON.stringify({
      schemaVersion: 2,
      config: { digest: `sha256:${'b'.repeat(64)}` },
    }),
    backend: JSON.stringify({
      schemaVersion: 2,
      config: { digest: `sha256:${'c'.repeat(64)}` },
    }),
  };
  const record: ReleaseRecord = {
    schemaVersion: 1,
    releaseId: `rizz-${'a'.repeat(40)}-100-1`,
    source: {
      repository: policy.repository,
      ref: policy.ref,
      commit: 'a'.repeat(40),
    },
    workflow: { path: policy.workflowPath, runId: 100, runAttempt: 1 },
    createdAt: '2026-09-26T10:00:00Z',
    expiresAt: '2026-10-03T10:00:00Z',
    checks: {
      tests: 'passed',
      scan: 'passed',
      policyVersion: 'rizz-build-v1-high-critical',
    },
    images: {
      frontend: {
        repository: policy.frontendRepository,
        digest: hash(manifests.frontend),
        sourceCommit: 'a'.repeat(40),
      },
      backend: {
        repository: policy.backendRepository,
        digest: hash(manifests.backend),
        sourceCommit: 'a'.repeat(40),
      },
    },
  };
  const archive = zipFile(JSON.stringify(record), 'release.json', true);
  const run = {
    id: 100,
    run_attempt: 1,
    head_sha: record.source.commit,
    head_branch: 'master',
    path: policy.workflowPath,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: policy.repository, id: 1 },
    head_repository: { full_name: policy.repository, id: 1 },
  };
  const artifact = {
    id: 42,
    name: 'rizz-release-100-1',
    expired: false,
    size_in_bytes: archive.length,
    digest: hash(archive),
    expires_at: record.expiresAt,
    workflow_run: {
      id: 100,
      repository_id: 1,
      head_repository_id: 1,
      head_sha: record.source.commit,
    },
  };
  const job = {
    name: 'Publish verified release',
    conclusion: 'success',
    steps: [
      'Backend tests and dependency gate',
      'Frontend tests, build and dependency gate',
      'Build both images and run explicit mock-only integration',
      'Scan both local images (fail on HIGH or CRITICAL)',
      'Push scanned images and create release record',
      'Upload paired release record',
    ].map(name => ({ name, conclusion: 'success' })),
  };
  const downloadUrl =
    'https://productionresultssa0.blob.core.windows.net/fixture/release.zip?signed=fixture-only';
  const fetcher = jest.fn(async (url: string, _options?: RequestInit) => {
    if (url.includes('/workflows/publish.yml/runs?'))
      return Response.json({ workflow_runs: [run] });
    if (url.includes('/runs/100/artifacts?'))
      return Response.json({ artifacts: [artifact] });
    if (url.endsWith('/runs/100/attempts/1')) return Response.json(run);
    if (url.includes('/attempts/')) return Response.json({ jobs: [job] });
    if (url.endsWith('/artifacts/42/zip'))
      return new Response(null, {
        status: 302,
        headers: { location: downloadUrl },
      });
    if (url === downloadUrl) return new Response(new Uint8Array(archive));
    throw new Error('Unexpected URL');
  });
  const awsReader = jest.fn(async (args: string[]) => {
    if (args[0] === 'sts')
      return {
        Account: '000000000000',
        Arn: 'arn:aws:sts::000000000000:assumed-role/rizz-staging-release-reader/test-only',
      };
    const component = args.includes('rizz-staging-frontend')
      ? 'frontend'
      : 'backend';
    return {
      failures: [],
      images: [
        {
          registryId: '000000000000',
          repositoryName: `rizz-staging-${component}`,
          imageId: { imageDigest: record.images[component].digest },
          imageManifest: manifests[component],
        },
      ],
    };
  });
  const source = new GitHubEcrReleaseSource({
    policy,
    githubToken: 'test-token-not-real',
    awsProfile: 'rizz-release-reader',
    fetcher: fetcher as unknown as typeof fetch,
    awsReader,
  });
  return { record, archive, run, artifact, job, source, fetcher, awsReader };
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  jest.restoreAllMocks();
});
describe('authenticated release adapter using only local transport fixtures', () => {
  it('resolves an exact retained attempt without relying on the recent-release list', async () => {
    const f = fixture();
    const result = await new ReleaseCatalog({
      policy,
      source: f.source,
    }).resolve(f.record.releaseId, hash(JSON.stringify({})));
    expect(result).toMatchObject({ reason: 'release_selection_changed' });
    expect(f.fetcher.mock.calls.some(c => c[0].includes('/workflows/'))).toBe(
      false,
    );
    expect(f.fetcher.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/${policy.repository}/actions/runs/100/attempts/1`,
    );
    // A changed digest does not prevent checking the independent artifact and
    // registry evidence, but cannot be returned as the selected release.
    expect(f.awsReader).toHaveBeenCalledTimes(3);
    expect(
      await new ReleaseCatalog({ policy, source: f.source }).resolve(
        f.record.releaseId,
        releaseDigest(f.record),
      ),
    ).toEqual({
      state: 'verified',
      record: f.record,
      recordDigest: releaseDigest(f.record),
    });
    expect(f.awsReader).toHaveBeenCalledTimes(6);
  });
  it.each(['commit', 'run', 'attempt'] as const)(
    'rejects the wrong exact run identity: %s',
    async key => {
      const f = fixture();
      if (key === 'commit') f.run.head_sha = 'd'.repeat(40);
      if (key === 'run') f.run.id = 101;
      if (key === 'attempt') f.run.run_attempt = 2;
      await expect(f.source.resolve(f.record.releaseId)).rejects.toThrow(
        'Selected run identity mismatch',
      );
      expect(f.awsReader).toHaveBeenCalledTimes(1);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects malformed exact IDs before any external read', () => {
    const f = fixture();
    expect(() => f.source.resolve('100/../../other')).toThrow();
    expect(() =>
      f.source.resolve(`rizz-${'a'.repeat(40)}-9007199254740992-1`),
    ).toThrow();
    expect(f.awsReader).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('resolves trusted run, exact artifact checksum and both real-transport-shaped ECR manifests', async () => {
    const f = fixture();
    expect(
      await new ReleaseCatalog({ policy, source: f.source }).list(),
    ).toMatchObject({
      state: 'available',
      items: [{ releaseId: f.record.releaseId, eligibleForProposal: true }],
    });
    expect(f.awsReader.mock.calls.map(c => c[0].slice(0, 2))).toEqual([
      ['sts', 'get-caller-identity'],
      ['ecr', 'batch-get-image'],
      ['ecr', 'batch-get-image'],
    ]);
    const download = f.fetcher.mock.calls.find(c =>
      c[0].includes('blob.core.windows.net'),
    )!;
    expect(download[1]?.headers).toBeUndefined();
    expect(download[1]?.redirect).toBe('error');
  });
  it.each([
    'expired',
    'digest',
    'repository_id',
    'run_attempt',
    'step',
    'manifest',
  ] as const)(
    'fails closed for altered independent evidence: %s',
    async key => {
      const f = fixture();
      if (key === 'expired') f.artifact.expired = true;
      if (key === 'digest') f.artifact.digest = `sha256:${'f'.repeat(64)}`;
      if (key === 'repository_id') f.artifact.workflow_run.repository_id = 99;
      if (key === 'run_attempt') {
        f.run.run_attempt = 2;
        f.artifact.name = 'rizz-release-100-2';
      }
      if (key === 'step') f.job.steps[3].conclusion = 'skipped';
      if (key === 'manifest')
        f.awsReader.mockImplementation(async args =>
          args[0] === 'sts'
            ? {
                Account: '000000000000',
                Arn: 'arn:aws:sts::000000000000:assumed-role/rizz-staging-release-reader/test-only',
              }
            : {
                failures: [],
                images: [
                  {
                    registryId: '000000000000',
                    repositoryName: 'rizz-staging-frontend',
                    imageId: { imageDigest: f.record.images.frontend.digest },
                    imageManifest: '{}',
                  },
                ],
              },
        );
      expect(
        await new ReleaseCatalog({ policy, source: f.source }).list(),
      ).toMatchObject({ state: 'unavailable', items: [] });
    },
  );
  it('does not follow arbitrary redirects or forward a GitHub token', async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) =>
      url.endsWith('/zip')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://127.0.0.1/credentials' },
          })
        : original(url, options),
    );
    expect(
      await new ReleaseCatalog({ policy, source: f.source }).list(),
    ).toMatchObject({ state: 'unavailable', items: [] });
    expect(f.fetcher.mock.calls.some(c => c[0].includes('127.0.0.1'))).toBe(
      false,
    );
  });
  it('rejects fork/PR workflow candidates without downloading an artifact', async () => {
    const f = fixture();
    f.run.head_repository.full_name = 'untrusted/fork';
    expect(await f.source.read()).toEqual([]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects root/wrong reader credentials before any GitHub request', async () => {
    const f = fixture();
    f.awsReader.mockResolvedValueOnce({
      Account: '000000000000',
      Arn: 'arn:aws:iam::000000000000:root',
    } as never);
    await expect(f.source.read()).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(
      () =>
        new GitHubEcrReleaseSource({
          policy,
          githubToken: 'test-only',
          awsProfile: 'default',
        }),
    ).toThrow();
  });
  it('coalesces in-flight refreshes but never caches an earlier green observation', async () => {
    const f = fixture();
    const first = f.source.read();
    expect(f.source.read()).toBe(first);
    await first;
    f.fetcher.mockRejectedValue(new Error('sanitized upstream outage'));
    expect(
      await new ReleaseCatalog({ policy, source: f.source }).list(),
    ).toMatchObject({ state: 'unavailable', items: [] });
  });
  it('keeps disabled configuration inert and rejects incomplete opt-in', async () => {
    expect(
      await createReleaseCatalog(new ConfigReader({})).list(),
    ).toMatchObject({ state: 'not_configured', items: [] });
    expect(() =>
      createReleaseCatalog(
        new ConfigReader({ agentGuard: { rizzReleases: { enabled: true } } }),
      ),
    ).toThrow();
  });
});
describe('bounded artifact parser', () => {
  it('parses stored and deflated JSON without writing files', async () => {
    for (const compress of [false, true])
      expect(
        await parseReleaseArchive(
          zipFile('{"test":true}', 'release.json', compress),
        ),
      ).toEqual({ test: true });
  });
  it('rejects path traversal, invalid archives and decompression bombs', async () => {
    for (const bytes of [
      Buffer.from('not-zip'),
      zipFile('{}', '../release.json'),
      zipFile('x'.repeat(65537), 'release.json', true),
      Buffer.alloc(131073),
    ])
      await expect(parseReleaseArchive(bytes)).rejects.toThrow();
  });
});
