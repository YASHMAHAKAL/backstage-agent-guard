import { DeliveryStatusObserver } from './deliveryStatus';
import { createFrozenSnapshot } from './snapshot';
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

function fixtureFetch(
  options: {
    prState?: 'open' | 'closed';
    mergedAt?: string | null;
    changedFile?: boolean;
    argoRevision?: string;
    argoPath?: string;
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
    } else if (url.pathname.endsWith('/applications/gitops-pr-demo-api')) {
      body = {
        spec: {
          project: 'agent-guard-staging',
          source: {
            repoURL:
              'git@github.com:YASHMAHAKAL/backstage-agent-guard-gitops.git',
            targetRevision: 'main',
            path: options.argoPath ?? 'apps/staging/gitops-pr-demo-api',
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
    syncStatus: 'Synced',
    healthStatus: 'Healthy',
    workloadHealth: 'Healthy',
  });
  expect(delivery.deployed).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(snapshot.files.length + 3);
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

it('requires the exact Argo revision, target, and healthy workload', async () => {
  for (const options of [
    { argoRevision: 'f'.repeat(40) },
    { argoPath: 'apps/staging/another-service' },
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
    }).observe(record());
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
