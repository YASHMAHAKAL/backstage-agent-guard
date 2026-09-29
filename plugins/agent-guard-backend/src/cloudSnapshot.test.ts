import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudTargetSchema, CloudTarget } from './cloudTarget';
import {
  cloudSnapshotHasIntegrity,
  createCloudFrozenSnapshot,
  revalidateCloudSnapshot,
  inspectCloudGitopsFiles,
} from './cloudSnapshot';
import {
  ReleaseCatalog,
  ReleaseEvidence,
  ReleasePolicy,
  ReleaseRecord,
  releaseDigest,
} from './releases';
import { sha256 } from './snapshot';
import { AuthenticatedCloudReaders } from './cloudReaders';
import { JevClient } from './jev';

const now = Date.parse('2026-09-27T12:00:00Z');
const target: CloudTarget = {
  id: 'eks-staging',
  accountId: '000000000000',
  region: 'us-east-1',
  clusterName: 'rizz-eks-staging',
  namespace: 'rizz-staging',
  owner: 'group:default/platform-team',
  sourceRepository: 'example/Rizz.AI',
  gitopsRepository: 'https://github.com/example/gitops.git',
  gitopsBranch: 'main',
  gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
  argoApplication: 'rizz-ai-staging',
  ingress: {
    stage: 'ready',
    hostname: 'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com',
    operatorCidr: '203.0.113.10/32',
    certificateArn:
      'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
    certificateSha256: sha256('fixture-certificate-only'),
  },
};
const record: ReleaseRecord = {
  schemaVersion: 1,
  releaseId: `rizz-${'a'.repeat(40)}-100-1`,
  source: {
    repository: target.sourceRepository,
    commit: 'a'.repeat(40),
    ref: 'refs/heads/master',
  },
  workflow: {
    path: '.github/workflows/publish.yml',
    runId: 100,
    runAttempt: 1,
  },
  createdAt: '2026-09-27T10:00:00Z',
  expiresAt: '2026-10-04T10:00:00Z',
  checks: {
    tests: 'passed',
    scan: 'passed',
    policyVersion: 'rizz-build-v1-high-critical',
  },
  images: {
    frontend: {
      repository: `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-frontend`,
      digest: sha256('fixture-front-manifest'),
      sourceCommit: 'a'.repeat(40),
    },
    backend: {
      repository: `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend`,
      digest: sha256('fixture-back-manifest'),
      sourceCommit: 'a'.repeat(40),
    },
  },
};
function options() {
  return structuredClone({
    now,
    context: {
      proposalId: '00000000-0000-4000-8000-000000000001',
      requester: 'user:default/developer',
      submissionChannel: 'mcp_action' as const,
    },
    proposal: {
      declaredIntent:
        'Deploy the paired Rizz.AI release to EKS staging, frontend HTTPS and private backend.',
      templateId: 'deploy-rizz-ai',
      inputs: {
        targetId: 'eks-staging',
        releaseId: record.releaseId,
        releaseRecordDigest: releaseDigest(record),
        frontendReplicas: 1,
        backendReplicas: 2,
      },
    },
    target,
    release: {
      state: 'verified' as const,
      record,
      recordDigest: releaseDigest(record),
    },
    gitopsBase: {
      revision: 'd'.repeat(40),
      files: [] as Array<{ name: 'runtime.yaml'; sha256: string }>,
    },
  });
}
it('freezes new app-or-platform review while preserving old platform-only snapshots', () => {
  const next = createCloudFrozenSnapshot(options());
  expect(next.envelope.policyVersion).toBe(
    'rizz-app-v2-distinct-app-or-platform-review',
  );
  expect(next.envelope.reviewerGroups).toEqual([
    'group:default/rizz-team',
    'group:default/platform-team',
  ]);
  expect(cloudSnapshotHasIntegrity(next)).toBe(true);
  const changed = structuredClone(next);
  (changed.envelope as any).reviewerGroups = [
    'group:default/rizz-team',
    'group:default/rizz-team',
  ];
  expect(cloudSnapshotHasIntegrity(changed)).toBe(false);
  const legacy = createCloudFrozenSnapshot({
    ...options(),
    policyVersion: 'rizz-staging-v1-distinct-platform-review',
  });
  expect(legacy.envelope.reviewerGroups).toBeUndefined();
  expect(cloudSnapshotHasIntegrity(legacy)).toBe(true);
});
it('binds rollback to a verified deployment record in a new digest', () => {
  const original = createCloudFrozenSnapshot(options());
  const rollback = createCloudFrozenSnapshot({
    ...options(),
    rollbackSource: {
      verifiedDeploymentId: original.envelope.proposalId,
      snapshotDigest: original.digest,
      mergeRevision: 'c'.repeat(40),
      verifiedAt: '2026-09-28T10:00:00.000Z',
    },
  });
  expect(rollback.envelope).toMatchObject({
    kind: 'rizz_cloud_rollback',
    schemaVersion: 3,
    rollbackSource: { snapshotDigest: original.digest },
  });
  expect(rollback.digest).not.toBe(original.digest);
  expect(rollback.files).toEqual(original.files);
  expect(cloudSnapshotHasIntegrity(rollback)).toBe(true);
  const changed = structuredClone(rollback);
  changed.envelope.rollbackSource!.snapshotDigest = sha256('wrong');
  expect(cloudSnapshotHasIntegrity(changed)).toBe(false);
});
it('summarizes only the complete exact cloud recipe, with no hidden extra changes', () => {
  const snapshot = createCloudFrozenSnapshot(options());
  const contents = Object.fromEntries(
    snapshot.files.map(file => [basename(file.path), file.content]),
  );
  expect(inspectCloudGitopsFiles(contents, target)).toMatchObject({
    state: 'present',
    frontendReplicas: 1,
    backendReplicas: 2,
    frontendImage: `${record.images.frontend.repository}@${record.images.frontend.digest}`,
    backendExposure: 'clusterip',
  });
  expect(inspectCloudGitopsFiles({}, target)).toEqual({ state: 'absent' });
  const changed = JSON.parse(contents['backend-service.yaml']);
  changed.spec.type = 'LoadBalancer';
  expect(() =>
    inspectCloudGitopsFiles(
      { ...contents, 'backend-service.yaml': JSON.stringify(changed) },
      target,
    ),
  ).toThrow('Unsupported');
  expect(() =>
    inspectCloudGitopsFiles({ ...contents, 'extra.yaml': '{}' }, target),
  ).toThrow();
  expect(() =>
    inspectCloudGitopsFiles(
      { 'runtime.yaml': contents['runtime.yaml'] },
      target,
    ),
  ).toThrow();
});
it('sends current configuration to Jev without account, operator IP or certificate identifiers', async () => {
  const snapshot = createCloudFrozenSnapshot(options());
  const contents = Object.fromEntries(
    snapshot.files.map(file => [basename(file.path), file.content]),
  );
  const current = inspectCloudGitopsFiles(contents, target);
  const fetcher = jest
    .fn()
    .mockResolvedValue(new Response(null, { status: 503 }));
  await new JevClient(
    'fixture-key-not-live',
    fetcher as typeof fetch,
  ).evaluateCloud(snapshot, current);
  const state = JSON.parse(fetcher.mock.calls[0][1].body).state;
  expect(state.currentState.frontendDigest).toBe(record.images.frontend.digest);
  expect(state.currentState.backendReplicas).toBe(2);
  expect(JSON.stringify(state)).not.toContain(target.accountId);
  expect(JSON.stringify(state)).not.toContain(target.ingress.operatorCidr);
  expect(JSON.stringify(state)).not.toContain(target.ingress.certificateArn);
});
it('reads and integrity-checks the complete current recipe from one pinned Git tree', async () => {
  const snapshot = createCloudFrozenSnapshot(options());
  const blobs = snapshot.files.map(file => ({
    ...file,
    gitSha: createHash('sha1')
      .update(`blob ${Buffer.byteLength(file.content)}\0${file.content}`)
      .digest('hex'),
  }));
  const fetcher = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('git/ref/heads/main'))
      return Response.json({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: 'a'.repeat(40) },
      });
    if (url.includes('git/commits/'))
      return Response.json({
        sha: 'a'.repeat(40),
        tree: { sha: 'b'.repeat(40) },
      });
    if (url.includes('git/trees/'))
      return Response.json({
        sha: 'b'.repeat(40),
        truncated: false,
        tree: blobs.map(blob => ({
          path: blob.path,
          sha: blob.gitSha,
          mode: '100644',
          type: 'blob',
          size: Buffer.byteLength(blob.content),
        })),
      });
    const blob = blobs.find(item => url.endsWith(`git/blobs/${item.gitSha}`))!;
    return Response.json({
      sha: blob.gitSha,
      encoding: 'base64',
      size: Buffer.byteLength(blob.content),
      content: Buffer.from(blob.content).toString('base64'),
    });
  });
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'not-live',
    fetcher: fetcher as typeof fetch,
  });
  const result = await reader.readGitops(target, AbortSignal.timeout(5000));
  expect(result.base.revision).toBe('a'.repeat(40));
  expect(result.base.files).toEqual(
    snapshot.files
      .map(file => ({ name: basename(file.path), sha256: file.sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  expect(result.currentState).toMatchObject({
    state: 'present',
    frontendReplicas: 1,
    backendReplicas: 2,
  });
  expect(result.contents).toEqual(
    Object.fromEntries(
      snapshot.files.map(file => [basename(file.path), file.content]),
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(12);
});
function releaseCatalog(
  mode: 'authenticated_ci' | 'fixture' = 'authenticated_ci',
) {
  const policy: ReleasePolicy = {
    repository: target.sourceRepository,
    ref: record.source.ref,
    workflowPath: record.workflow.path,
    frontendRepository: record.images.frontend.repository,
    backendRepository: record.images.backend.repository,
  };
  const evidence: ReleaseEvidence = {
    repository: policy.repository,
    ref: policy.ref,
    commit: record.source.commit,
    workflowPath: policy.workflowPath,
    runId: 100,
    runAttempt: 1,
    conclusion: 'success',
    event: 'push',
    artifactExpired: false,
    artifactRecordDigest: releaseDigest(record),
    verifiedImages: Object.values(record.images).map(
      i => `${i.repository}@${i.digest}`,
    ),
  };
  const resolver = jest.fn().mockResolvedValue([{ record, evidence }]);
  return {
    resolver,
    evidence,
    catalog: new ReleaseCatalog({
      policy,
      now: () => now,
      source: { mode, read: async () => [], resolve: resolver },
    }),
  };
}

describe('inactive cloud frozen snapshot (offline evidence fixtures only)', () => {
  it('renders valid local Kustomize output without contacting a cluster', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rizz-cloud-render-'));
    try {
      const snapshot = createCloudFrozenSnapshot(options());
      for (const file of snapshot.files)
        writeFileSync(join(directory, basename(file.path)), file.content, {
          flag: 'wx',
          mode: 0o600,
        });
      const rendered = execFileSync('kubectl', ['kustomize', directory], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 256 * 1024,
      });
      expect(rendered.match(/^kind: /gm)).toHaveLength(8);
      expect(rendered).toContain('namespace: rizz-staging');
      expect(rendered).toContain(
        `${record.images.frontend.repository}@${record.images.frontend.digest}`,
      );
      expect(rendered).toContain(
        `${record.images.backend.repository}@${record.images.backend.digest}`,
      );
      expect(rendered).not.toContain('release-required');
    } finally {
      // Exact unique directory produced by this test, never a caller path.
      rmSync(directory, { recursive: true });
    }
  });
  it('renders a deterministic paired recipe, scoped files and explicit provenance', () => {
    const snapshot = createCloudFrozenSnapshot(options());
    expect(createCloudFrozenSnapshot(options())).toEqual(snapshot);
    expect(cloudSnapshotHasIntegrity(snapshot)).toBe(true);
    expect(snapshot.envelope.intentSource).toBe('agent_supplied');
    expect(snapshot.envelope.target.owner).toBe('group:default/platform-team');
    expect(snapshot.files).toHaveLength(9);
    expect(
      snapshot.files.every(f =>
        f.path.startsWith('clusters/eks-staging/apps/rizz-ai/'),
      ),
    ).toBe(true);
    const objects = snapshot.files.map(f => JSON.parse(f.content));
    expect(objects.filter(r => r.kind === 'Deployment')).toHaveLength(2);
    expect(
      objects
        .filter(r => r.kind === 'Service')
        .every(r => r.spec.type === 'ClusterIP'),
    ).toBe(true);
    expect(
      objects.some(r =>
        [
          'Secret',
          'Namespace',
          'ClusterRole',
          'Application',
          'Component',
        ].includes(r.kind),
      ),
    ).toBe(false);
    const backend = objects.find(
      r => r.kind === 'Deployment' && r.metadata.name === 'rizz-backend',
    );
    expect(backend.spec.replicas).toBe(2);
    expect(backend.spec.template.spec.containers[0].image).toBe(
      `${record.images.backend.repository}@${record.images.backend.digest}`,
    );
    expect(
      backend.spec.template.spec.containers[0].env.every(
        (e: { value?: unknown }) => !('value' in e),
      ),
    ).toBe(true);
    expect(
      backend.spec.template.spec.containers[0].readinessProbe.httpGet.path,
    ).toBe('/readyz');
    for (const deploy of objects.filter(r => r.kind === 'Deployment')) {
      expect(deploy.metadata.labels['backstage.io/kubernetes-id']).toBe(
        deploy.spec.template.metadata.labels['backstage.io/kubernetes-id'],
      );
      expect(deploy.spec.template.spec.automountServiceAccountToken).toBe(
        false,
      );
      expect(
        deploy.spec.template.spec.containers[0].securityContext
          .readOnlyRootFilesystem,
      ).toBe(true);
    }
    const rest = options();
    rest.context.submissionChannel = 'backstage_rest' as never;
    expect(createCloudFrozenSnapshot(rest).envelope.intentSource).toBe(
      'authenticated_user_submitted',
    );
  });

  it('keeps backend ingress equivalent to the independently usable offline helper', () => {
    const path = pathToFileURL(
      resolve(__dirname, '../../../infra/cloud-platform/alb-demo.mjs'),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {renderAlbIngress} from ${JSON.stringify(
          path,
        )}; import {readFileSync} from 'node:fs'; console.log(JSON.stringify(renderAlbIngress(JSON.parse(readFileSync(0, 'utf8')))));`,
      ],
      {
        input: JSON.stringify({
          accountId: target.accountId,
          ...target.ingress,
        }),
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    const ingress = createCloudFrozenSnapshot(options()).files.find(f =>
      f.path.endsWith('/ingress.yaml'),
    )!;
    expect(JSON.parse(ingress.content)).toEqual(JSON.parse(output));
  });

  it('rejects unsupported targets, bootstrap stage, owner overrides and open access', () => {
    for (const change of [
      { namespace: 'staging' },
      { owner: 'group:default/payments-team' },
      { region: 'us-west-2' },
      { gitopsPath: 'apps/staging' },
      { gitopsRepository: 'https://user:secret@github.com/example/gitops.git' },
      { unknownField: 'untrusted' },
    ])
      expect(
        cloudTargetSchema.safeParse({ ...target, ...change }).success,
      ).toBe(false);
    for (const change of [
      { stage: 'bootstrap' },
      { operatorCidr: '0.0.0.0/0' },
      { operatorCidr: '10.1.2.3/32' },
      {
        certificateArn: target.ingress.certificateArn.replace(
          '000000000000:',
          '111111111111:',
        ),
      },
      { hostname: 'https://example.com' },
      { privateKey: 'not-accepted' },
    ])
      expect(
        cloudTargetSchema.safeParse({
          ...target,
          ingress: { ...target.ingress, ...change },
        }).success,
      ).toBe(false);
  });

  it('requires a matching, unexpired release pair from the approved registry/source', () => {
    const original = options();
    for (const change of ['digest', 'pair', 'registry', 'source', 'expiry']) {
      const bad = options();
      if (change === 'digest')
        bad.proposal.inputs.releaseRecordDigest = sha256('changed');
      if (change === 'pair')
        bad.release.record.images.backend.sourceCommit = 'b'.repeat(40);
      if (change === 'registry')
        bad.release.record.images.backend.repository =
          'docker.io/unsafe/backend';
      if (change === 'source')
        bad.release.record.source.repository = 'attacker/Rizz.AI';
      if (change === 'expiry') bad.now = Date.parse(record.expiresAt);
      // Preserve hash consistency where possible to test deeper policy checks.
      if (!['digest', 'expiry'].includes(change)) {
        bad.release.recordDigest = releaseDigest(bad.release.record);
        bad.proposal.inputs.releaseRecordDigest = bad.release.recordDigest;
      }
      expect(() => createCloudFrozenSnapshot(bad)).toThrow();
    }
    original.context.requester = 'user:default/guest';
    expect(() => createCloudFrozenSnapshot(original)).toThrow();
  });

  it('binds intent, replicas, requester, target, certificate, IP and base into the digest', () => {
    const snapshot = createCloudFrozenSnapshot(options());
    for (const change of [
      'intent',
      'replicas',
      'requester',
      'certificate',
      'ip',
      'repo',
      'revision',
      'baseFile',
    ]) {
      const changed = options();
      if (change === 'intent')
        changed.proposal.declaredIntent =
          'Deploy another paired Rizz.AI release to EKS staging.';
      if (change === 'replicas') changed.proposal.inputs.backendReplicas = 1;
      if (change === 'requester')
        changed.context.requester = 'user:default/another';
      if (change === 'certificate')
        changed.target.ingress.certificateSha256 = sha256('new-cert');
      if (change === 'ip')
        changed.target.ingress.operatorCidr = '198.51.100.10/32';
      if (change === 'repo')
        changed.target.gitopsRepository =
          'https://github.com/example/other.git';
      if (change === 'revision') changed.gitopsBase.revision = 'e'.repeat(40);
      if (change === 'baseFile')
        changed.gitopsBase.files.push({
          name: 'runtime.yaml',
          sha256: sha256('old-runtime'),
        });
      expect(createCloudFrozenSnapshot(changed).digest).not.toBe(
        snapshot.digest,
      );
    }
  });

  it('rejects traversal, unknown files and duplicate base paths rather than overwrite/delete them', () => {
    for (const files of [
      [{ name: '../platform/iam.yaml', sha256: sha256('file') }],
      [{ name: 'secret.yaml', sha256: sha256('file') }],
      [
        { name: 'runtime.yaml', sha256: sha256('file') },
        { name: 'runtime.yaml', sha256: sha256('file') },
      ],
    ])
      expect(() =>
        createCloudFrozenSnapshot({
          ...options(),
          gitopsBase: { revision: 'd'.repeat(40), files },
        }),
      ).toThrow();
  });

  it('detects byte tampering, missing/extra files, reordered paths and provenance alteration', () => {
    const snapshot = createCloudFrozenSnapshot(options());
    const wrong = structuredClone(snapshot);
    wrong.files[0].content += '# unauthorized change';
    expect(cloudSnapshotHasIntegrity(wrong)).toBe(false);
    for (const change of ['missing', 'extra', 'path', 'provenance']) {
      const bad = structuredClone(snapshot);
      if (change === 'missing') bad.files.pop();
      if (change === 'extra') bad.files.push(bad.files[0]);
      if (change === 'path')
        bad.files[0].path = 'apps/staging/stolen/deployment.yaml';
      if (change === 'provenance')
        bad.envelope.intentSource = 'authenticated_user_submitted';
      expect(cloudSnapshotHasIntegrity(bad)).toBe(false);
    }
    expect(cloudSnapshotHasIntegrity(null)).toBe(false);
  });

  it('freshly resolves release evidence and refuses fixture-mode, outage or missing images', async () => {
    const snapshot = createCloudFrozenSnapshot(options());
    const source = releaseCatalog();
    const recheck = () =>
      revalidateCloudSnapshot(snapshot, {
        releases: source.catalog,
        target,
        gitopsBase: options().gitopsBase,
      });
    expect(await recheck()).toEqual({ valid: true });
    expect(source.resolver).toHaveBeenCalledWith(record.releaseId);
    source.resolver.mockRejectedValueOnce(new Error('secret-private-error'));
    expect(await recheck()).toEqual({
      valid: false,
      reason: 'release_source_unavailable',
    });
    source.evidence.verifiedImages = [];
    expect(await recheck()).toEqual({
      valid: false,
      reason: 'image_unavailable',
    });
    expect(
      await revalidateCloudSnapshot(snapshot, {
        releases: releaseCatalog('fixture').catalog,
        target,
        gitopsBase: options().gitopsBase,
      }),
    ).toEqual({ valid: false, reason: 'trusted_resolver_not_connected' });
  });

  it('requires refreshed review after target or branch/current-app changes', async () => {
    const snapshot = createCloudFrozenSnapshot(options());
    const source = releaseCatalog();
    expect(
      await revalidateCloudSnapshot(snapshot, {
        releases: source.catalog,
        target: {
          ...target,
          ingress: { ...target.ingress, certificateSha256: sha256('rotated') },
        },
        gitopsBase: options().gitopsBase,
      }),
    ).toEqual({ valid: false, reason: 'target_changed' });
    expect(
      await revalidateCloudSnapshot(snapshot, {
        releases: source.catalog,
        target,
        gitopsBase: { revision: 'e'.repeat(40), files: [] },
      }),
    ).toEqual({ valid: false, reason: 'gitops_base_changed' });
    expect(source.resolver).not.toHaveBeenCalled();
  });
});
