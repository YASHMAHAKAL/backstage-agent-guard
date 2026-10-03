import { CloudDeliveryObserver } from './cloudDelivery';
import { cloudDeliveryFixture } from './testFixtures/cloudDeliveryFixture';
import { createCloudRuntimeSnapshot } from './cloudRuntimeSnapshot';
import { sha256 } from './snapshot';

const verifiedRuntime = {
  workloads: {
    state: 'verified' as const,
    frontend: {
      desired: 1,
      updated: 1,
      available: 1,
      readyPods: 1,
      generation: 3,
    },
    backend: {
      desired: 2,
      updated: 2,
      available: 2,
      readyPods: 2,
      generation: 3,
    },
  },
  smoke: {
    state: 'verified' as const,
    health: 'alive' as const,
    readiness: 'ready' as const,
  },
};

function setup() {
  const proposal = cloudDeliveryFixture();
  const target = proposal.snapshot.envelope.target;
  const merged = 'c'.repeat(40);
  const revision = 'd'.repeat(40);
  const repository = { full_name: 'example/gitops' };
  const pr = {
    number: 1,
    html_url: proposal.execution!.prUrl,
    state: 'closed',
    merged: true,
    draft: false,
    merge_commit_sha: merged,
    base: { ref: 'main', repo: repository },
    head: { ref: `agent-guard-cloud/${proposal.id}`, repo: repository },
  };
  const source = {
    repoURL: target.gitopsRepository,
    targetRevision: 'main',
    path: target.gitopsPath,
  };
  const destination = {
    server: 'https://kubernetes.default.svc',
    namespace: target.namespace,
  };
  const app = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name: target.argoApplication, namespace: 'argocd' },
    spec: { project: 'rizz-app', source, destination },
    status: {
      sync: { status: 'Synced', revision, comparedTo: { source, destination } },
      health: { status: 'Healthy' },
    },
  };
  const files = proposal.snapshot.files.map(file => ({
    name: file.path.slice(target.gitopsPath.length + 1),
    sha256: file.sha256,
  }));
  const readers = {
    readPullRequest: jest.fn().mockImplementation(async () => pr),
    isAncestor: jest.fn().mockResolvedValue(true),
    readGitopsRevision: jest.fn().mockImplementation(async (_target, ref) => ({
      base: { revision: ref, files },
      currentState: { state: 'present' },
    })),
    readArgoApplication: jest.fn().mockImplementation(async () => app),
  };
  const options = {
    readers,
    destinationServer: destination.server,
  };
  return { proposal, pr, app, readers, options, merged, revision };
}
it('independently checks merged and actual synced bytes, but never claims verified deployment', async () => {
  const s = setup();
  // Historical artifact expiration must not falsify an existing deployment.
  const before = JSON.stringify(s.proposal);
  const result = await new CloudDeliveryObserver(s.options).observe(s.proposal);
  expect(result.github).toEqual({
    state: 'merged_files_match',
    revision: s.merged,
  });
  expect(result.argoCd).toMatchObject({
    state: 'synced_files_match',
    revision: s.revision,
  });
  expect(s.readers.readGitopsRevision.mock.calls.map(call => call[1])).toEqual([
    s.merged,
    s.revision,
  ]);
  expect(s.readers.isAncestor).toHaveBeenCalledWith(
    s.proposal.snapshot.envelope.target,
    s.merged,
    s.revision,
    expect.any(AbortSignal),
  );
  expect(result.deployed).toBe(false);
  expect(result.workloads.state).toBe('not_configured');
  expect(result.smoke.state).toBe('not_configured');
  expect(JSON.stringify(s.proposal)).toBe(before);
});
it('declares delivery verified only after all evidence and a final Argo recheck', async () => {
  const s = setup();
  const runtime = { observe: jest.fn().mockResolvedValue(verifiedRuntime) };
  const result = await new CloudDeliveryObserver({
    ...s.options,
    runtime,
  }).observe(s.proposal);
  expect(result.deployed).toBe(true);
  expect(s.readers.readArgoApplication).toHaveBeenCalledTimes(2);
  expect(runtime.observe).toHaveBeenCalledWith(
    s.proposal.snapshot,
    expect.any(AbortSignal),
  );
});
it('observes a version-2 runtime change only against its exact merged and synced bytes', async () => {
  const s = setup();
  const target = s.proposal.snapshot.envelope.target;
  const contents = Object.fromEntries(
    s.proposal.snapshot.files.map(file => [
      file.path.slice(target.gitopsPath.length + 1),
      file.content,
    ]),
  );
  const snapshot = createCloudRuntimeSnapshot({
    input: {
      operation: 'runtime_change',
      declaredIntent: 'Increase only frontend replicas to two in EKS staging.',
      targetId: target.id,
      patch: { frontendReplicas: 2 },
    },
    context: {
      proposalId: s.proposal.id,
      requester: s.proposal.requester,
      submissionChannel: 'mcp_action',
    },
    target,
    gitopsBase: {
      revision: 'b'.repeat(40),
      files: Object.entries(contents).map(([name, content]) => ({
        name,
        sha256: sha256(content),
      })),
    },
    contents,
  });
  s.proposal.snapshot = snapshot;
  s.proposal.decision!.digest = snapshot.digest;
  s.readers.readGitopsRevision.mockImplementation(async (_target, ref) => ({
    base: {
      revision: ref,
      files: snapshot.files.map(file => ({
        name: file.path.slice(target.gitopsPath.length + 1),
        sha256: file.sha256,
      })),
    },
  }));
  const runtime = { observe: jest.fn().mockResolvedValue(verifiedRuntime) };
  const observed = await new CloudDeliveryObserver({
    ...s.options,
    runtime,
  }).observe(s.proposal);
  expect(observed.deployed).toBe(true);
  expect(runtime.observe).toHaveBeenCalledWith(
    snapshot,
    expect.any(AbortSignal),
  );
  snapshot.files[0].content += 'tampered';
  const invalid = await new CloudDeliveryObserver({
    ...s.options,
    runtime,
  }).observe(s.proposal);
  expect(invalid.github.state).toBe('approval_invalid');
  expect(runtime.observe).toHaveBeenCalledTimes(1);
});
it.each(['workloads', 'smoke'])(
  'does not declare verified delivery when %s fails',
  async part => {
    const s = setup();
    const evidence = structuredClone(verifiedRuntime) as any;
    evidence[part] = { state: 'unavailable' };
    const result = await new CloudDeliveryObserver({
      ...s.options,
      runtime: { observe: jest.fn().mockResolvedValue(evidence) },
    }).observe(s.proposal);
    expect(result.deployed).toBe(false);
  },
);
it('invalidates a successful runtime observation when Argo changes during verification', async () => {
  const s = setup();
  s.readers.readArgoApplication
    .mockResolvedValueOnce(s.app)
    .mockResolvedValueOnce({
      ...s.app,
      status: {
        ...s.app.status,
        sync: { ...s.app.status.sync, revision: 'e'.repeat(40) },
      },
    });
  const result = await new CloudDeliveryObserver({
    ...s.options,
    runtime: { observe: jest.fn().mockResolvedValue(verifiedRuntime) },
  }).observe(s.proposal);
  expect(result.deployed).toBe(false);
  expect(result.argoCd.state).toBe('changed_during_observation');
});
it('never reads Kubernetes or smoke endpoints for an unmerged PR', async () => {
  const s = setup();
  s.pr.state = 'open';
  s.pr.merged = false;
  const runtime = { observe: jest.fn() };
  await new CloudDeliveryObserver({ ...s.options, runtime }).observe(
    s.proposal,
  );
  expect(runtime.observe).not.toHaveBeenCalled();
});
it('does not equate merge ancestry with unchanged approved files', async () => {
  const s = setup();
  s.readers.readGitopsRevision.mockImplementation(async (_target, ref) => ({
    base: {
      revision: ref,
      files: s.proposal.snapshot.files.map((file, i) => ({
        name: file.path.split('/').pop(),
        sha256:
          ref === s.revision && i === 0
            ? `sha256:${'9'.repeat(64)}`
            : file.sha256,
      })),
    },
  }));
  const result = await new CloudDeliveryObserver(s.options).observe(s.proposal);
  expect(result.github.state).toBe('merged_files_match');
  expect(result.argoCd.state).toBe('approved_files_mismatch');
  expect(result.deployed).toBe(false);
});
it.each(['extraFile', 'duplicateFile', 'missingFile'])(
  'rejects complete-tree mismatch: %s',
  async issue => {
    const s = setup();
    s.readers.readGitopsRevision.mockImplementation(async (_target, ref) => {
      const files = s.proposal.snapshot.files.map(file => ({
        name: file.path.split('/').pop(),
        sha256: file.sha256,
      }));
      if (issue === 'extraFile')
        files.push({ name: 'extra.yaml', sha256: files[0].sha256 });
      if (issue === 'duplicateFile') files[0] = files[1];
      if (issue === 'missingFile') files.pop();
      return { base: { revision: ref, files } };
    });
    const result = await new CloudDeliveryObserver(s.options).observe(
      s.proposal,
    );
    expect(result.github.state).toBe('approved_files_mismatch');
    expect(s.readers.readArgoApplication).not.toHaveBeenCalled();
  },
);
it.each([
  'noApproval',
  'wrongDigest',
  'selfReview',
  'corruptSnapshot',
  'wrongUrl',
])('rejects invalid authority before provider reads: %s', async issue => {
  const s = setup();
  if (issue === 'noApproval') delete s.proposal.decision;
  if (issue === 'wrongDigest')
    s.proposal.decision!.digest = `sha256:${'9'.repeat(64)}`;
  if (issue === 'selfReview')
    s.proposal.decision!.reviewer = s.proposal.requester;
  if (issue === 'corruptSnapshot') s.proposal.snapshot.files[0].content += ' ';
  if (issue === 'wrongUrl')
    s.proposal.execution!.prUrl = 'https://github.com/wrong/repo/pull/1';
  const result = await new CloudDeliveryObserver(s.options).observe(s.proposal);
  expect(['approval_invalid', 'source_mismatch']).toContain(
    result.github.state,
  );
  expect(s.readers.readPullRequest).not.toHaveBeenCalled();
});
it.each(['wrongRepo', 'wrongBranch', 'wrongHead', 'badRevision'])(
  'rejects invalid PR evidence: %s',
  async issue => {
    const s = setup();
    if (issue === 'wrongRepo') s.pr.head.repo = { full_name: 'another/gitops' };
    if (issue === 'wrongBranch') s.pr.base.ref = 'master';
    if (issue === 'wrongHead') s.pr.head.ref = 'arbitrary-branch';
    if (issue === 'badRevision') s.pr.merge_commit_sha = 'shortsha';
    const result = await new CloudDeliveryObserver(s.options).observe(
      s.proposal,
    );
    expect(result.github.state).toBe('unavailable_or_invalid');
    expect(s.readers.readArgoApplication).not.toHaveBeenCalled();
  },
);
it.each(['open', 'draft', 'closed_unmerged'])(
  'does not observe deployment before merge: %s',
  async state => {
    const s = setup();
    s.pr.state = state === 'closed_unmerged' ? 'closed' : 'open';
    s.pr.merged = false;
    s.pr.draft = state === 'draft';
    const result = await new CloudDeliveryObserver(s.options).observe(
      s.proposal,
    );
    expect(result.github.state).toBe(state);
    expect(s.readers.readArgoApplication).not.toHaveBeenCalled();
  },
);
it.each([
  'wrongKind',
  'wrongApiVersion',
  'wrongName',
  'wrongProject',
  'wrongNamespace',
  'wrongDestination',
  'wrongPath',
  'multiSource',
  'comparisonMismatch',
  'errorCondition',
])('rejects Argo source/destination evidence: %s', async issue => {
  const s = setup();
  const app: any = structuredClone(s.app);
  if (issue === 'wrongKind') app.kind = 'AppProject';
  if (issue === 'wrongApiVersion') app.apiVersion = 'argoproj.io/v1beta1';
  if (issue === 'wrongName') app.metadata.name = 'another-app';
  if (issue === 'wrongProject') app.spec.project = 'default';
  if (issue === 'wrongNamespace') app.spec.destination.namespace = 'staging';
  if (issue === 'wrongDestination')
    app.spec.destination.server = 'https://another.cluster';
  if (issue === 'wrongPath') app.spec.source.path = 'apps/staging';
  if (issue === 'multiSource') app.spec.sources = [app.spec.source];
  if (issue === 'comparisonMismatch')
    app.status.sync.comparedTo.source.repoURL =
      'https://github.com/another/repo.git';
  if (issue === 'errorCondition')
    app.status.conditions = [{ type: 'ComparisonError' }];
  s.readers.readArgoApplication.mockResolvedValue(app);
  expect(
    (await new CloudDeliveryObserver(s.options).observe(s.proposal)).argoCd
      .state,
  ).toBe('unavailable_or_invalid');
});
it('returns not-ready for unhealthy or unsynced application', async () => {
  const s = setup();
  s.app.status.sync.status = 'OutOfSync';
  expect(
    (await new CloudDeliveryObserver(s.options).observe(s.proposal)).argoCd
      .state,
  ).toBe('not_ready');
});
it('rejects unrelated revisions', async () => {
  const s = setup();
  s.readers.isAncestor.mockResolvedValue(false);
  expect(
    (await new CloudDeliveryObserver(s.options).observe(s.proposal)).argoCd
      .state,
  ).toBe('revision_unrelated');
});
it('does not keep a green Argo result after a subsequent outage', async () => {
  const s = setup();
  const observer = new CloudDeliveryObserver(s.options);
  expect((await observer.observe(s.proposal)).argoCd.state).toBe(
    'synced_files_match',
  );
  s.readers.readArgoApplication.mockRejectedValue(
    new Error('private-secret-error'),
  );
  const result = await observer.observe(s.proposal);
  expect(result.argoCd.state).toBe('unavailable_or_invalid');
  expect(JSON.stringify(result)).not.toContain('private-secret-error');
});
it('bounds a reader that ignores cancellation and does not mutate a returned result later', async () => {
  const s = setup();
  let finish!: (value: unknown) => void;
  s.readers.readArgoApplication.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const result = await new CloudDeliveryObserver({
    ...s.options,
    timeoutMs: 20,
  }).observe(s.proposal);
  const before = JSON.stringify(result);
  finish(s.app);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(JSON.stringify(result)).toBe(before);
  expect(result.github.state).toBe('unavailable_or_invalid');
});
it.each([
  'http://remote.example',
  'https://user:password@kubernetes.default.svc',
  'https://kubernetes.default.svc/api',
  'https://kubernetes.default.svc/?token=x',
])('rejects unsafe pinned Argo destination %s', destinationServer => {
  expect(
    () => new CloudDeliveryObserver({ ...setup().options, destinationServer }),
  ).toThrow();
});
