import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RizzControlCenter } from './RizzControlCenter';

const mockFetch = jest.fn();
jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));
jest.mock('@backstage/plugin-catalog-react', () => ({
  useEntity: () => ({
    entity: {
      kind: 'System',
      metadata: { name: 'rizz-ai', title: 'Rizz.AI' },
      spec: { owner: 'group:default/rizz-team' },
    },
  }),
}));
jest.mock('./CloudDeliveryPanel', () => ({
  CloudDeliveryPanel: ({ proposalId }: { proposalId: string }) => (
    <div>Delivery evidence for {proposalId}</div>
  ),
}));

const proposalId = '00000000-0000-4000-8000-000000000001';
let queue: object[];
beforeEach(() => {
  mockFetch.mockReset();
  queue = [
    {
      id: proposalId,
      status: 'scaffolding',
      requester: 'user:default/developer',
      snapshot: {
        envelope: {
          kind: 'rizz_cloud_release',
          inputs: { releaseId: 'rizz-release-1' },
        },
      },
      viewerPermissions: { canReview: false },
    },
  ];
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/capabilities'))
      return {
        ok: true,
        json: async () => ({
          state: 'configured',
          canSubmit: true,
          reviewPolicy: {
            reviewerGroups: [
              'group:default/rizz-team',
              'group:default/platform-team',
            ],
            memberOfReviewerGroup: false,
            distinctReviewerRequired: true,
          },
          target: {
            id: 'eks-staging',
            clusterName: 'rizz-eks-staging',
            namespace: 'rizz-staging',
            region: 'us-east-1',
          },
        }),
      };
    if (url.endsWith('/releases'))
      return {
        ok: true,
        json: async () => ({
          state: 'available',
          items: [
            {
              releaseId: 'rizz-release-1',
              sourceCommit: 'a'.repeat(40),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              eligibleForProposal: true,
            },
          ],
        }),
      };
    if (url.endsWith('/proposals'))
      return {
        ok: true,
        json: async () => ({ items: queue }),
      };
    if (url.endsWith('/verified-deployments'))
      return { ok: true, json: async () => ({ items: [] }) };
    if (url.endsWith('/readiness'))
      return {
        ok: true,
        json: async () => ({
          scope: 'rizz-ai/eks-staging',
          checkedAt: '2026-09-28T10:00:00.000Z',
          checks: [
            {
              id: 'live_metrics',
              title: 'Live application metrics',
              state: 'unknown',
              detail: 'No authenticated metrics source is connected.',
              checkedAt: '2026-09-28T10:00:00.000Z',
              evidenceUrl: '/catalog/default/system/rizz-ai',
            },
          ],
        }),
      };
    if (url.endsWith('/metrics'))
      return {
        ok: true,
        json: async () => ({
          state: 'unavailable',
          checkedAt: '2026-09-28T10:00:00.000Z',
        }),
      };
    throw new Error('Unexpected endpoint');
  });
});

it('shows catalog context and actual scoped release/proposal data without a deployment claim', async () => {
  render(<RizzControlCenter />);
  expect(
    await screen.findByText('1 verified, unexpired release available.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /Configured target. Deployment health requires an observation/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Paired release · rizz-release-1'),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Propose replica change' }),
  ).toHaveAttribute('href', '/rizz-deployments#runtime-change-form');
  expect(screen.getByText(/New-request reviewer groups:/)).toHaveTextContent(
    'group:default/rizz-team or group:default/platform-team',
  );
  expect(screen.queryByText(/Verified as deployed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Delivery evidence for/)).not.toBeInTheDocument();
  expect(
    screen.getByText('No verified deployments recorded yet.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Live application metrics · unknown'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect delivery' }));
  expect(
    screen.getByText(`Delivery evidence for ${proposalId}`),
  ).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(6);
  expect(mockFetch.mock.calls.every(([, options]) => !options?.method)).toBe(
    true,
  );
});

it('labels runtime proposals accurately and links to their exact review request', async () => {
  queue = [
    {
      id: proposalId,
      status: 'pending_approval',
      requester: 'user:default/developer',
      snapshot: {
        envelope: {
          kind: 'rizz_cloud_runtime_change',
          changedFields: ['backendReplicas'],
          before: { frontendReplicas: 1, backendReplicas: 1 },
          after: { frontendReplicas: 1, backendReplicas: 2 },
        },
      },
      viewerPermissions: { canReview: true },
    },
  ];
  render(<RizzControlCenter />);
  expect(
    await screen.findByText('Runtime replicas · backend 1 → 2'),
  ).toBeInTheDocument();
  expect(screen.getByText(/awaiting your review/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Review proposal' })).toHaveAttribute(
    'href',
    `/rizz-deployments?proposal=${proposalId}#review-queue`,
  );
  expect(
    screen.queryByText(
      /Runtime change, rollback and retirement requests are being built/,
    ),
  ).not.toBeInTheDocument();
  expect(mockFetch.mock.calls.every(([, options]) => !options?.method)).toBe(
    true,
  );
});

it('shows only backend-recorded verified deployment history', async () => {
  const baseFetch = mockFetch.getMockImplementation();
  if (!baseFetch) throw new Error('Expected the default fetch fixture');
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/verified-deployments'))
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              proposalId,
              operation: 'rizz_cloud_release',
              verifiedAt: '2026-09-28T10:00:00.000Z',
              mergeRevision: 'c'.repeat(40),
              argoRevision: 'd'.repeat(40),
              prUrl: 'https://github.com/example/gitops/pull/1',
              frontendImage: 'example/frontend@sha256:one',
              backendImage: 'example/backend@sha256:two',
              frontendReplicas: 1,
              backendReplicas: 2,
              sourceRelease: { releaseId: 'rizz-release-1' },
            },
          ],
        }),
      };
    return baseFetch(url);
  });
  render(<RizzControlCenter />);
  const link = await screen.findByRole('link', {
    name: 'Reviewed pull request',
  });
  expect(link).toHaveAttribute(
    'href',
    'https://github.com/example/gitops/pull/1',
  );
  expect(link.parentElement).toHaveTextContent('frontend 1 · backend 2');
  expect(screen.getByText('example/frontend@sha256:one')).toBeInTheDocument();
});

it('labels measured backend metrics as one-replica samples', async () => {
  const baseFetch = mockFetch.getMockImplementation();
  if (!baseFetch) throw new Error('Expected the default fetch fixture');
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/metrics'))
      return {
        ok: true,
        json: async () => ({
          state: 'observed',
          checkedAt: '2026-09-28T10:00:00.000Z',
          scope: 'one_backend_replica',
          apiRequests: 8,
          apiErrors: 2,
          meanApiLatencySeconds: 0.25,
          providerOutcomes: { success: 5, rate_limited: 1 },
          providerCalls: 6,
          providerCallLimit: 100,
          providerInFlight: 0,
        }),
      };
    return baseFetch(url);
  });
  render(<RizzControlCenter />);
  expect(
    await screen.findByText(/API requests 8 · errors 2/),
  ).toBeInTheDocument();
  expect(screen.getByText(/mean latency 250 ms/)).toBeInTheDocument();
  expect(
    screen.getByText(/Sampled .* one backend replica/),
  ).toBeInTheDocument();
});

it('does not offer request links to a configured read-only viewer', async () => {
  const baseFetch = mockFetch.getMockImplementation();
  if (!baseFetch) throw new Error('Expected the default fetch fixture');
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/capabilities'))
      return {
        ok: true,
        json: async () => ({
          state: 'configured',
          canSubmit: false,
          reviewPolicy: {
            reviewerGroups: [
              'group:default/rizz-team',
              'group:default/platform-team',
            ],
            memberOfReviewerGroup: false,
            distinctReviewerRequired: true,
          },
          target: {
            id: 'eks-staging',
            clusterName: 'rizz-eks-staging',
            namespace: 'rizz-staging',
            region: 'us-east-1',
          },
        }),
      };
    return baseFetch(url);
  });
  render(<RizzControlCenter />);
  expect(
    await screen.findByText(/read-only; not in an authorized submitter group/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('link', { name: 'Propose replica change' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Inspect governed deployments' }),
  ).toBeInTheDocument();
});

it('keeps failures and fixture releases explicit and never offers a mutating control', async () => {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/capabilities'))
      return {
        ok: true,
        json: async () => ({ state: 'disabled', canSubmit: false }),
      };
    if (url.endsWith('/releases'))
      return { ok: true, json: async () => ({ state: 'fixture', items: [] }) };
    throw new Error('Cloud queue disabled');
  });
  render(<RizzControlCenter />);
  expect(
    await screen.findByText('Fixture evidence only; no deployable release.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Cloud target disabled. No EKS deployment is claimed.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Cloud review data is disabled or unavailable/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /approve|deploy|delete/i }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(12));
  expect(mockFetch.mock.calls.every(([, options]) => !options?.method)).toBe(
    true,
  );
});
