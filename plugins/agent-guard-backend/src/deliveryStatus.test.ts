import { DeliveryStatusObserver } from './deliveryStatus';
import { createFrozenSnapshot, FrozenSnapshot } from './snapshot';
import { ProposalRecord } from './services/ProposalService';

const proposalId = '453bbb61-302a-47bb-817d-2599ac1acfe1';
const mergeCommitSha = '003d35d51920dd44c2b05e5cbaf4c6182edb4447';
const snapshot = createFrozenSnapshot({
  proposalId,
  requester: 'user:default/developer',
  gitopsRepoUrl:
    'github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops',
  proposal: {
    declaredIntent: 'Create a staging Node.js API for payments',
    templateId: 'nodejs-api',
    inputs: {
      serviceName: 'gitops-pr-demo-api',
      requestedOwner: 'group:default/payments-team',
      environment: 'staging',
      description: 'Internal demo API',
    },
  },
});

// PR #1 was created before the shared-directory migration and includes the
// per-service kustomization file. Keep its frozen evidence for the opt-in live
// observer test; new proposals use the v4 directory-recursion layout above.
const legacyProposal = {
  declaredIntent:
    'Submit a new Agent Guard proposal for an internal staging Node.js API named gitops-pr-demo-api, owned by group:default/payments-team. Use the nodejs-api template. No public ingress or database. Do not reuse proposal 2a1574b0-3dbb-4552-9106-68f8a986d14c, run Scaffolder directly, or approve anything.',
  templateId: 'nodejs-api' as const,
  inputs: {
    serviceName: 'gitops-pr-demo-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging' as const,
    description:
      'Internal staging Node.js API with no public ingress or database.',
  },
};
const legacyBaseSnapshot = createFrozenSnapshot({
  proposalId,
  requester: 'user:default/developer',
  gitopsRepoUrl:
    'github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops',
  proposal: legacyProposal,
});
const legacyFiles = [
  ...legacyBaseSnapshot.files,
  {
    path: 'apps/staging/gitops-pr-demo-api/kustomization.yaml',
    content: `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
`,
    sha256:
      'sha256:b074f5274b540eb3d4dc5fb5c5bb42a0f6901e5bec690a276ec29909cbcfda2e',
  },
].sort((left, right) => left.path.localeCompare(right.path));
const legacySnapshot: FrozenSnapshot = {
  envelope: {
    ...legacyBaseSnapshot.envelope,
    template: {
      id: 'nodejs-api',
      version: 'agent-guard-v3-unconditional-guard-action',
      digest:
        'sha256:dc099ecb97219e0600c6bcf2dcbca5b204142dadc9d5b565f08370bf58acc435',
    },
    generatedFiles: legacyFiles.map(file => ({
      path: file.path,
      sha256: file.sha256,
    })),
  },
  digest:
    'sha256:52de500a37f9968d2183892025e0be2d59e5430b988f118ab28fada0372f1f92',
  files: legacyFiles,
};

function record(): ProposalRecord {
  return {
    id: proposalId,
    declaredIntent: snapshot.envelope.declaredIntent,
    intentSource: 'agent_supplied',
    templateId: 'nodejs-api',
    inputs: snapshot.envelope.inputs,
    requester: 'user:default/developer',
    status: 'pr_open',
    reviewLane: 'owner_review',
    reasonCodes: [],
    semantic: { kind: 'unavailable', reason: 'not_relevant' },
    snapshot,
    decision: {
      decision: 'approve',
      reviewer: 'user:default/reviewer',
      decidedAt: '2026-09-24T10:01:00Z',
      digest: snapshot.digest,
    },
    execution: {
      state: 'pr_open',
      claimedAt: '2026-09-24T10:00:00Z',
      prNumber: 1,
      prUrl:
        'https://github.com/YASHMAHAKAL/backstage-agent-guard-gitops/pull/1',
    },
    createdAt: '2026-09-24T10:00:00Z',
  };
}

function liveRecord(): ProposalRecord {
  const result = record();
  result.declaredIntent = legacyProposal.declaredIntent;
  result.inputs = legacyProposal.inputs;
  result.snapshot = legacySnapshot;
  result.decision!.digest = legacySnapshot.digest;
  return result;
}

function fixtureFetch(
  options: {
    prState?: 'open' | 'closed';
    mergedAt?: string | null;
    changedFile?: boolean;
    argoRevision?: string;
    argoPath?: string;
    compareStatus?: 'ahead' | 'behind' | 'diverged' | 'identical';
    workloadHealth?: string;
    argoConditions?: Array<{ type: string }>;
  } = {},
) {
  return jest.fn(async (input: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    const url = new URL(input);
    let body: unknown;
    if (url.pathname.endsWith('/pulls/1')) {
      body = {
        state: options.prState ?? 'closed',
        merged_at:
          options.mergedAt === undefined
            ? '2026-09-24T11:06:55Z'
            : options.mergedAt,
        merge_commit_sha: mergeCommitSha,
        base: { ref: 'main' },
        head: {
          ref: `agent-guard/${proposalId}`,
          repo: { full_name: 'YASHMAHAKAL/backstage-agent-guard-gitops' },
        },
      };
    } else if (url.pathname.includes('/contents/')) {
      const path = url.pathname.split('/contents/')[1];
      const file = snapshot.files.find(item => item.path === path);
      if (!file) {
        return new Response('', { status: 404 });
      }
      body = {
        encoding: 'base64',
        content: Buffer.from(
          options.changedFile && path.endsWith('deployment.yaml')
            ? 'changed after approval'
            : file.content,
        ).toString('base64'),
      };
    } else if (url.pathname.endsWith('/resource-tree')) {
      body = {
        nodes: [
          {
            kind: 'Deployment',
            name: 'gitops-pr-demo-api',
            namespace: 'staging',
            health: { status: options.workloadHealth ?? 'Healthy' },
          },
        ],
      };
    } else if (url.pathname.includes('/compare/')) {
      body = { status: options.compareStatus ?? 'identical' };
    } else if (url.pathname.endsWith('/applications/gitops-pr-demo-api')) {
      body = {
        spec: {
          project: 'agent-guard-staging',
          source: {
            repoURL:
              'git@github.com:YASHMAHAKAL/backstage-agent-guard-gitops.git',
            targetRevision: 'main',
            path: options.argoPath ?? 'apps/staging',
          },
          destination: { namespace: 'staging' },
        },
        status: {
          sync: {
            status: 'Synced',
            revision: options.argoRevision ?? mergeCommitSha,
          },
          health: { status: 'Healthy' },
          conditions: options.argoConditions ?? [],
        },
      };
    } else {
      throw new Error(`Unexpected URL: ${url.href}`);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function observer(fetcher: typeof fetch) {
  return new DeliveryStatusObserver({
    githubToken: 'github-test-token',
    argoCdUrl: 'http://127.0.0.1:8082',
    argoCdToken: 'argocd-test-token',
    fetcher,
  });
}

it('verifies exact merged files, matching Argo revision, and workload health', async () => {
  const fetcher = fixtureFetch();
  const delivery = await observer(fetcher).observe(record());
  expect(delivery.github).toMatchObject({
    state: 'merged',
    approvedFilesMatch: true,
    mergeCommitSha,
  });
  expect(delivery.argoCd).toMatchObject({
    state: 'observed',
    applicationUrl: 'http://127.0.0.1:8082/applications/gitops-pr-demo-api',
    syncStatus: 'Synced',
    healthStatus: 'Healthy',
    includesApprovedMerge: true,
    workloadHealth: 'Healthy',
  });
  expect(delivery.deployed).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(snapshot.files.length + 4);
});

it('does not claim deployment while the PR is merely open or closed unmerged', async () => {
  for (const options of [{ prState: 'open' as const }, { mergedAt: null }]) {
    const delivery = await observer(fixtureFetch(options)).observe(record());
    expect(delivery.deployed).toBe(false);
    expect(delivery.argoCd.state).toBe('not_checked');
  }
});

it('does not trust a merged PR if a file changed after approval', async () => {
  const delivery = await observer(fixtureFetch({ changedFile: true })).observe(
    record(),
  );
  expect(delivery.github).toMatchObject({
    state: 'merged',
    approvedFilesMatch: false,
  });
  expect(delivery.argoCd.state).toBe('not_checked');
  expect(delivery.deployed).toBe(false);
});

it('refuses delivery claims if the stored approval digest is inconsistent', async () => {
  const changed = record();
  changed.decision!.digest = `sha256:${'0'.repeat(64)}`;
  const fetcher = fixtureFetch();
  const delivery = await observer(fetcher).observe(changed);
  expect(delivery.github).toMatchObject({
    state: 'source_mismatch',
    reason: 'approval_integrity_failure',
  });
  expect(delivery.deployed).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('accepts a later shared-Application revision only when it contains the approved merge', async () => {
  const delivery = await observer(
    fixtureFetch({ argoRevision: 'f'.repeat(40), compareStatus: 'ahead' }),
  ).observe(record());
  expect(delivery.argoCd).toMatchObject({
    state: 'observed',
    revision: 'f'.repeat(40),
    includesApprovedMerge: true,
  });
  expect(delivery.deployed).toBe(true);
});

it('requires the shared Application target, approved merge ancestry, and healthy workload', async () => {
  for (const options of [
    { argoPath: 'apps/staging/another-service' },
    { compareStatus: 'behind' as const },
    { workloadHealth: 'Progressing' },
    { argoConditions: [{ type: 'ComparisonError' }] },
  ]) {
    const delivery = await observer(fixtureFetch(options)).observe(record());
    expect(delivery.deployed).toBe(false);
  }
});

it('reports Argo CD as unavailable instead of claiming deployment', async () => {
  const githubFetch = fixtureFetch();
  const fetcher = jest.fn(async (input: string, init?: RequestInit) => {
    if (new URL(input).hostname === '127.0.0.1') {
      throw new Error('Argo CD port-forward is down');
    }
    return githubFetch(input, init);
  }) as unknown as typeof fetch;

  const delivery = await observer(fetcher).observe(record());
  expect(delivery.github).toMatchObject({
    state: 'merged',
    approvedFilesMatch: true,
  });
  expect(delivery.argoCd).toMatchObject({
    state: 'unavailable',
    reason: 'request_failed',
  });
  expect(delivery.deployed).toBe(false);
});

it('refuses to send an Argo token to non-loopback HTTP', () => {
  expect(
    () =>
      new DeliveryStatusObserver({
        argoCdUrl: 'http://example.com',
        argoCdToken: 'secret',
      }),
  ).toThrow(/loopback HTTP/);
});

// The opt-in alias is a Jest test, although the lint rule cannot infer that.
/* eslint-disable jest/no-standalone-expect */
const liveTest = process.env.AGENT_GUARD_LIVE_DELIVERY === '1' ? it : it.skip;
liveTest(
  'observes the merged private PR and local Argo CD Application',
  async () => {
    const delivery = await new DeliveryStatusObserver({
      githubToken: process.env.GITHUB_TOKEN,
      argoCdUrl: process.env.AGENT_GUARD_ARGOCD_URL,
      argoCdToken: process.env.AGENT_GUARD_ARGOCD_TOKEN,
      argoCdCaBase64: process.env.AGENT_GUARD_ARGOCD_CA_B64,
    }).observe(liveRecord());
    expect(delivery.github).toMatchObject({
      state: 'merged',
      approvedFilesMatch: true,
      mergeCommitSha,
    });
    expect(delivery.argoCd).toMatchObject({
      state: 'observed',
      syncStatus: 'Synced',
      healthStatus: 'Healthy',
      revision: mergeCommitSha,
      workloadHealth: 'Healthy',
    });
    expect(delivery.deployed).toBe(true);
  },
);
/* eslint-enable jest/no-standalone-expect */
