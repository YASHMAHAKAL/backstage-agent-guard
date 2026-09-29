import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudDeploymentsPage } from './CloudDeploymentsPage';

const mockFetch = jest.fn();
jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));
jest.mock('@backstage/ui', () => ({
  Container: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Header: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
const release = {
  releaseId: `rizz-${'a'.repeat(40)}-100-1`,
  recordDigest: `sha256:${'b'.repeat(64)}`,
  sourceCommit: 'a'.repeat(40),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  eligibleForProposal: true,
};
const capability = {
  state: 'configured',
  canSubmit: true,
  target: {
    id: 'eks-staging',
    clusterName: 'rizz-eks-staging',
    namespace: 'rizz-staging',
    region: 'us-east-1',
    owner: 'group:default/platform-team',
  },
};
function proposal(canReview = false) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending_approval',
    requester: 'user:default/requester',
    viewerPermissions: { canReview },
    reasonCodes: ['distinct_platform_reviewer_required'],
    currentState: { state: 'absent' },
    semantic: {
      kind: 'evaluated',
      model: 'jev-fixture-only',
      choice: 'aligned',
      choiceConfidence: 0.95,
      choiceProbabilities: { aligned: 0.95 },
      noul: 0.93,
      score: 0.12,
      scoreProbabilities: { '0': 0.95 },
      scoreLegend: { '0': 'No mismatch' },
    },
    snapshot: {
      digest: `sha256:${'c'.repeat(64)}`,
      files: [
        {
          path: 'clusters/eks-staging/apps/rizz-ai/frontend-deployment.yaml',
          content: '{"kind":"Deployment"}',
          sha256: `sha256:${'d'.repeat(64)}`,
        },
      ],
      envelope: {
        kind: 'rizz_cloud_release',
        declaredIntent:
          'Deploy the paired Rizz.AI staging release with restricted public frontend and private backend.',
        intentSource: 'agent_supplied',
        submissionChannel: 'mcp_action',
        policyVersion: 'fixture-policy',
        template: {
          id: 'deploy-rizz-ai',
          version: 'fixture-version',
          digest: `sha256:${'e'.repeat(64)}`,
        },
        inputs: {
          releaseId: release.releaseId,
          frontendReplicas: 1,
          backendReplicas: 1,
        },
        target: {
          ...capability.target,
          accountId: '000000000000',
          gitopsRepository: 'https://github.com/example/gitops.git',
          gitopsBranch: 'main',
          gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
          argoApplication: 'rizz-ai-staging',
          ingress: {
            hostname:
              'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com',
            operatorCidr: '203.0.113.10/32',
            certificateArn: 'fixture-certificate-arn',
            certificateSha256: `sha256:${'f'.repeat(64)}`,
          },
        },
        gitopsBase: { revision: 'd'.repeat(40), files: [] },
        release: {
          recordDigest: release.recordDigest,
          record: {
            source: { commit: release.sourceCommit },
            expiresAt: release.expiresAt,
            images: {
              frontend: {
                repository: 'fixture/frontend',
                digest: `sha256:${'1'.repeat(64)}`,
              },
              backend: {
                repository: 'fixture/backend',
                digest: `sha256:${'2'.repeat(64)}`,
              },
            },
          },
        },
      },
    },
    audit: [],
  };
}
let caps: object;
let items: ReturnType<typeof proposal>[];
let releaseListing: object;
let verifiedHistory: object[];
let failRead: boolean;
let failWrite: boolean;
beforeEach(() => {
  window.history.replaceState({}, '', '/');
  mockFetch.mockReset();
  caps = capability;
  items = [];
  releaseListing = { state: 'available', items: [release] };
  verifiedHistory = [];
  failRead = false;
  failWrite = false;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (failRead && !init?.method) throw new Error('credential-not-for-ui');
    if (init?.method === 'POST') {
      if (failWrite) throw new Error('private-provider-secret');
      const value = url.endsWith('/decision')
        ? {
            ...items[0],
            status: 'scaffolding',
            viewerPermissions: { canReview: false },
            execution: { state: 'task_started', taskId: 'fixture-task' },
          }
        : proposal();
      return { ok: true, json: async () => value };
    }
    if (url.endsWith('/capabilities'))
      return { ok: true, json: async () => caps };
    if (url.endsWith('/releases'))
      return { ok: true, json: async () => releaseListing };
    if (url.endsWith('/verified-deployments'))
      return { ok: true, json: async () => ({ items: verifiedHistory }) };
    if (url.endsWith('/proposals'))
      return { ok: true, json: async () => ({ items }) };
    throw new Error('Unexpected fixture request');
  });
});
it('opens an authorized proposal from a Control Center deep link without mutating it', async () => {
  items = [proposal(true)];
  window.history.replaceState(
    {},
    '',
    `/rizz-deployments?proposal=${items[0].id}#review-queue`,
  );
  render(<CloudDeploymentsPage />);
  expect(
    await screen.findByRole('heading', { name: 'Review the cloud change' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Approve exact cloud snapshot' }),
  ).toBeDisabled();
  expect(mockFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
async function ready() {
  await screen.findByRole('heading', { name: 'Cloud review queue' });
}
function fill() {
  fireEvent.change(screen.getByLabelText('Verified release'), {
    target: { value: release.releaseId },
  });
  fireEvent.change(screen.getByLabelText('Declared intent'), {
    target: {
      value:
        'Deploy the paired Rizz.AI release to EKS staging with restricted public frontend and private backend.',
    },
  });
}
it('default-disabled page never queries releases/proposals or exposes mutating controls', async () => {
  caps = { state: 'disabled', canSubmit: false };
  render(<CloudDeploymentsPage />);
  expect(
    await screen.findByText(/Cloud releases are disabled/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Submit cloud proposal' }),
  ).not.toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][0]).toContain('/capabilities');
});
it('submits only a verified paired release proposal, never direct Scaffolder or a target override', async () => {
  render(<CloudDeploymentsPage />);
  await ready();
  fill();
  fireEvent.change(screen.getByLabelText('Frontend replicas'), {
    target: { value: '2' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit cloud proposal' }),
  );
  await screen.findByRole('heading', { name: 'Review the cloud change' });
  const writes = mockFetch.mock.calls.filter(
    ([, init]) => init?.method === 'POST',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('plugin://agent-guard/rizz/proposals');
  expect(JSON.parse(writes[0][1].body)).toEqual({
    declaredIntent: expect.any(String),
    templateId: 'deploy-rizz-ai',
    inputs: {
      targetId: 'eks-staging',
      releaseId: release.releaseId,
      releaseRecordDigest: release.recordDigest,
      frontendReplicas: 2,
      backendReplicas: 1,
    },
  });
  expect(
    screen.getByRole('meter', { name: 'Noul yes probability' }),
  ).toHaveAttribute('aria-valuenow', '93');
  expect(
    screen.getByText(/Agent-supplied declared intent/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Deployment not verified/)).toBeInTheDocument();
  expect(
    mockFetch.mock.calls.some(
      ([url]) => url.includes('scaffolder') || url.includes('sync'),
    ),
  ).toBe(false);
});
it('replicas above two are rejected in the form, not clamped or sent to Jev', async () => {
  render(<CloudDeploymentsPage />);
  await ready();
  fill();
  fireEvent.change(screen.getByLabelText('Backend replicas'), {
    target: { value: '3' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit cloud proposal' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'integers from 1 to 2',
  );
  expect(
    mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
});
it('previews and submits a bounded runtime change without requesting Scaffolder', async () => {
  const baseFetch = mockFetch.getMockImplementation();
  if (!baseFetch) throw new Error('Expected the default fetch fixture');
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/runtime/preview'))
      return {
        ok: true,
        json: async () => ({
          state: 'preview',
          baseRevision: 'b'.repeat(40),
          before: { frontendReplicas: 1, backendReplicas: 1 },
          after: { frontendReplicas: 1, backendReplicas: 2 },
          changedFields: ['backendReplicas'],
          changedFiles: [
            {
              path: 'clusters/eks-staging/apps/rizz-ai/backend-deployment.yaml',
              sha256: `sha256:${'1'.repeat(64)}`,
            },
          ],
        }),
      };
    if (url.endsWith('/runtime/proposals')) {
      const releaseProposal = proposal();
      return {
        ok: true,
        json: async () => ({
          ...releaseProposal,
          currentState: {
            state: 'present',
            frontendReplicas: 1,
            backendReplicas: 1,
          },
          snapshot: {
            ...releaseProposal.snapshot,
            envelope: {
              ...releaseProposal.snapshot.envelope,
              kind: 'rizz_cloud_runtime_change',
              inputs: undefined,
              release: undefined,
              before: { frontendReplicas: 1, backendReplicas: 1 },
              after: { frontendReplicas: 1, backendReplicas: 2 },
              changedFields: ['backendReplicas'],
            },
          },
        }),
      };
    }
    return baseFetch(url, init);
  });
  render(<CloudDeploymentsPage />);
  await ready();
  fireEvent.change(screen.getByLabelText('Runtime change intent'), {
    target: { value: 'Increase only the Rizz.AI backend to two replicas.' },
  });
  fireEvent.change(screen.getByLabelText('Backend replicas · optional'), {
    target: { value: '2' },
  });
  expect(
    screen.getByRole('button', { name: 'Submit runtime proposal' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact change' }));
  expect(
    await screen.findByText(/Changed fields: backendReplicas/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit runtime proposal' }),
  );
  expect(await screen.findByText('Runtime-only change')).toBeInTheDocument();
  const writes = mockFetch.mock.calls.filter(
    ([, init]) => init?.method === 'POST',
  );
  expect(writes.map(([url]) => url)).toEqual([
    'plugin://agent-guard/rizz/runtime/preview',
    'plugin://agent-guard/rizz/runtime/proposals',
  ]);
  expect(JSON.parse(writes[1][1].body)).toEqual({
    operation: 'runtime_change',
    declaredIntent: 'Increase only the Rizz.AI backend to two replicas.',
    targetId: 'eks-staging',
    patch: { backendReplicas: 2 },
  });
});
it('previews a recorded healthy release before submitting a rollback proposal', async () => {
  const verifiedId = '00000000-0000-4000-8000-000000000099';
  verifiedHistory = [
    {
      proposalId: verifiedId,
      operation: 'rizz_cloud_release',
      sourceRelease: { releaseId: release.releaseId },
      verifiedAt: '2026-09-28T10:00:00.000Z',
      frontendReplicas: 1,
      backendReplicas: 1,
    },
    {
      proposalId: '00000000-0000-4000-8000-000000000098',
      operation: 'rizz_cloud_runtime_change',
      verifiedAt: '2026-09-28T11:00:00.000Z',
      frontendReplicas: 1,
      backendReplicas: 2,
    },
  ];
  const baseFetch = mockFetch.getMockImplementation();
  if (!baseFetch) throw new Error('Expected the default fetch fixture');
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/rollback/preview'))
      return {
        ok: true,
        json: async () => ({
          state: 'preview',
          baseRevision: 'b'.repeat(40),
          before: {
            frontendImage: 'example/frontend@sha256:old',
            backendImage: 'example/backend@sha256:old',
            frontendReplicas: 2,
            backendReplicas: 2,
          },
          after: {
            frontendImage: 'example/frontend@sha256:healthy',
            backendImage: 'example/backend@sha256:healthy',
            frontendReplicas: 1,
            backendReplicas: 1,
          },
          changedFiles: [
            {
              path: 'frontend-deployment.yaml',
              sha256: `sha256:${'1'.repeat(64)}`,
            },
          ],
        }),
      };
    if (url.endsWith('/rollback/proposals'))
      return {
        ok: true,
        json: async () => ({
          ...proposal(),
          snapshot: {
            ...proposal().snapshot,
            envelope: {
              ...proposal().snapshot.envelope,
              kind: 'rizz_cloud_rollback',
              rollbackSource: {
                verifiedDeploymentId: verifiedId,
                verifiedAt: '2026-09-28T10:00:00.000Z',
                snapshotDigest: `sha256:${'c'.repeat(64)}`,
              },
            },
          },
        }),
      };
    return baseFetch(url, init);
  });
  render(<CloudDeploymentsPage />);
  await ready();
  expect(
    screen.queryByRole('option', { name: /2026-09-28T11:00/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(
    screen.getByLabelText('Previously verified release deployment'),
    {
      target: { value: verifiedId },
    },
  );
  fireEvent.change(screen.getByLabelText('Rollback intent'), {
    target: { value: 'Restore the previously verified Rizz.AI release.' },
  });
  expect(
    screen.getByRole('button', { name: 'Submit rollback proposal' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview rollback' }));
  expect(
    await screen.findByText(/Changed files: frontend-deployment.yaml/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit rollback proposal' }),
  );
  expect(
    await screen.findByText(/Restores verified deployment/),
  ).toBeInTheDocument();
  const writes = mockFetch.mock.calls.filter(
    ([, init]) => init?.method === 'POST',
  );
  expect(writes.map(([url]) => url)).toEqual([
    'plugin://agent-guard/rizz/rollback/preview',
    'plugin://agent-guard/rizz/rollback/proposals',
  ]);
  expect(JSON.parse(writes[1][1].body)).toEqual({
    operation: 'rollback',
    declaredIntent: 'Restore the previously verified Rizz.AI release.',
    targetId: 'eks-staging',
    verifiedDeploymentId: verifiedId,
  });
  expect(
    mockFetch.mock.calls.some(
      ([url]) => url.includes('scaffolder') || url.includes('sync'),
    ),
  ).toBe(false);
});
it.each(['fixture', 'expired'])(
  '%s releases cannot be submitted',
  async kind => {
    releaseListing =
      kind === 'fixture'
        ? { state: 'fixture', items: [release] }
        : {
            state: 'available',
            items: [{ ...release, expiresAt: '2000-01-01T00:00:00Z' }],
          };
    render(<CloudDeploymentsPage />);
    await ready();
    expect(screen.getByLabelText('Verified release')).toBeDisabled();
    expect(
      screen.queryByRole('option', { name: release.releaseId }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Submit cloud proposal' }),
    ).toBeDisabled();
  },
);
it('release-source outage blocks new proposals but preserves the authorized review queue', async () => {
  items = [proposal(true)];
  releaseListing = { state: 'unavailable', items: [] };
  render(<CloudDeploymentsPage />);
  await ready();
  expect(screen.getByLabelText('Verified release')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /pending approval/i }));
  expect(
    screen.getByRole('button', { name: 'Approve exact cloud snapshot' }),
  ).toBeDisabled();
  expect(screen.getByText(/Deployment not verified/)).toBeInTheDocument();
});
it('distinct reviewer explicitly confirms the frozen change and posts the exact approval digest', async () => {
  items = [proposal(true)];
  caps = { ...capability, canSubmit: false };
  render(<CloudDeploymentsPage />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /pending approval/i }));
  expect(
    screen.getByRole('button', { name: 'Approve exact cloud snapshot' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Approve exact cloud snapshot' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Approve exact cloud snapshot' }),
    ).not.toBeInTheDocument(),
  );
  const write = mockFetch.mock.calls.find(
    ([, init]) => init?.method === 'POST',
  )!;
  expect(write[0]).toBe(
    `plugin://agent-guard/rizz/proposals/${items[0].id}/decision`,
  );
  expect(JSON.parse(write[1].body)).toEqual({
    decision: 'approve',
    digest: items[0].snapshot.digest,
  });
  expect(screen.getByText(/Deployment not verified/)).toBeInTheDocument();
});
it('unauthorized/requester views have no approval buttons; refresh failure removes stale evidence', async () => {
  items = [proposal(false)];
  render(<CloudDeploymentsPage />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /pending approval/i }));
  expect(
    screen.queryByRole('button', { name: 'Approve exact cloud snapshot' }),
  ).not.toBeInTheDocument();
  failRead = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh cloud data' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  expect(screen.queryByText(/credential-not-for-ui/)).not.toBeInTheDocument();
});
it('ambiguous decisions require refresh and never auto-retry or allow stale reselection', async () => {
  items = [proposal(true)];
  failWrite = true;
  render(<CloudDeploymentsPage />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /pending approval/i }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Approve exact cloud snapshot' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Refresh before retrying',
  );
  expect(
    screen.getByRole('button', { name: /pending approval/i }),
  ).toBeDisabled();
  expect(screen.queryByText(/private-provider-secret/)).not.toBeInTheDocument();
  expect(
    mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
});
