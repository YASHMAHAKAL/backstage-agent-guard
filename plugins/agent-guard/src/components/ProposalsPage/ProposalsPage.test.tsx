import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProposalsPage } from './ProposalsPage';

const mockFetch = jest.fn();

jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));

jest.mock('@backstage/core-components', () => ({
  Progress: () => <span>Loading</span>,
}));

jest.mock('@backstage/ui', () => ({
  Container: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Header: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const proposal = {
  id: '453bbb61-302a-47bb-817d-2599ac1acfe1',
  declaredIntent: 'Create an internal staging Node.js API',
  intentSource: 'agent_supplied',
  templateId: 'nodejs-api',
  inputs: {
    serviceName: 'gitops-pr-demo-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging',
    description: 'Internal demo API',
  },
  requester: 'user:default/developer',
  status: 'pr_open',
  execution: {
    state: 'pr_open',
    taskId: 'task-test-123',
    prUrl: 'https://github.com/YASHMAHAKAL/backstage-agent-guard-gitops/pull/1',
    prNumber: 1,
  },
  reviewLane: 'owner_review',
  reasonCodes: [],
  semantic: { kind: 'unavailable', reason: 'not_relevant' },
  snapshot: {
    digest: `sha256:${'a'.repeat(64)}`,
    envelope: {
      schemaVersion: 1,
      template: {
        id: 'nodejs-api',
        version: 'agent-guard-v3',
        digest: `sha256:${'b'.repeat(64)}`,
      },
      gitopsTarget: {
        repository:
          'github.com?owner=YASHMAHAKAL&repo=backstage-agent-guard-gitops',
        branch: 'main',
        path: 'apps/staging/gitops-pr-demo-api',
        publishEnabled: true,
      },
      policyVersion: 'staging-review-v5-guarded-pr',
    },
    files: [
      {
        path: 'apps/staging/gitops-pr-demo-api/deployment.yaml',
        content: 'kind: Deployment\n',
        sha256: `sha256:${'c'.repeat(64)}`,
      },
    ],
  },
  decision: {
    decision: 'approve',
    reviewer: 'user:default/reviewer',
    decidedAt: '2026-09-24T10:30:00Z',
    digest: `sha256:${'a'.repeat(64)}`,
  },
  viewerPermissions: { canReview: false, reason: 'Already reviewed' },
  createdAt: '2026-09-24T10:00:00Z',
};

const mergedDelivery = {
  checkedAt: '2026-09-24T11:30:00Z',
  github: {
    state: 'merged',
    url: 'https://github.com/YASHMAHAKAL/backstage-agent-guard-gitops/pull/1',
    mergedAt: '2026-09-24T11:06:55Z',
    mergeCommitSha: '003d35d51920dd44c2b05e5cbaf4c6182edb4447',
    approvedFilesMatch: true,
  },
  argoCd: {
    state: 'observed',
    applicationName: 'gitops-pr-demo-api',
    syncStatus: 'Synced',
    healthStatus: 'Healthy',
    revision: '003d35d51920dd44c2b05e5cbaf4c6182edb4447',
    workloadKind: 'Deployment',
    workloadHealth: 'Healthy',
    conditions: [],
  },
  deployed: true,
};

it('renders a verified delivery and changes to unavailable after refresh', async () => {
  let delivery: unknown = mergedDelivery;
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/delivery') ? delivery : { items: [proposal] },
  }));

  render(<ProposalsPage />);

  expect(
    await screen.findByText('Verified at the approved merge commit'),
  ).toBeInTheDocument();
  expect(screen.getByText(/sync Synced, health Healthy/)).toBeInTheDocument();
  expect(screen.getByText('task-test-123').closest('a')).toBeNull();
  expect(
    screen.getByText(/details restricted to the backend service/),
  ).toBeInTheDocument();
  expect(screen.getByText('Unknown (historical proposal)')).toBeInTheDocument();
  expect(screen.getByText('Merge verified').closest('li')).toHaveClass(
    'ag-track__stage--done',
  );
  expect(screen.getByText('Verified').closest('li')).toHaveClass(
    'ag-track__stage--done',
  );
  fireEvent.click(
    screen.getByText('apps/staging/gitops-pr-demo-api/deployment.yaml'),
  );
  expect(screen.getByText('kind: Deployment')).toBeInTheDocument();

  delivery = {
    ...mergedDelivery,
    argoCd: { state: 'unavailable', reason: 'request_failed' },
    deployed: false,
  };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

  expect(
    await screen.findByText('Not verified as deployed'),
  ).toBeInTheDocument();
  expect(
    await screen.findByText(/unavailable \(request_failed\)/),
  ).toBeInTheDocument();
  expect(screen.getByText('Argo synced').closest('li')).not.toHaveClass(
    'ag-track__stage--done',
  );
  expect(screen.getByText('Verified').closest('li')).not.toHaveClass(
    'ag-track__stage--done',
  );
});

it('shows accessible Jev gauges and requires exact-snapshot confirmation to approve', async () => {
  const pending = {
    ...proposal,
    id: '50c75fb6-1a38-48d2-8601-f464d0957c4f',
    status: 'pending_approval',
    execution: undefined,
    decision: undefined,
    submissionChannel: 'mcp_action',
    viewerPermissions: {
      canReview: true,
      reason: 'You are authorized to review this frozen proposal',
    },
    semantic: {
      kind: 'evaluated',
      model: 'jev-test',
      choice: 'aligned',
      choiceConfidence: 0.97,
      choiceProbabilities: { aligned: 0.98, scope_expansion: 0.02 },
      noul: 0.94,
      score: 0.09,
      scoreProbabilities: { '0': 0.95, '1': 0.05 },
      scoreLegend: { '0': 'No material mismatch', '1': 'Minor ambiguity' },
    },
  };
  mockFetch.mockImplementation(
    async (url: string, options?: { method?: string }) => ({
      ok: true,
      json: async () => {
        if (options?.method === 'POST') {
          return { ...pending, status: 'approved' };
        }
        if (url.endsWith('/delivery')) {
          return {
            checkedAt: '2026-09-24T10:00:00Z',
            github: { state: 'not_published' },
            argoCd: { state: 'not_checked' },
            deployed: false,
          };
        }
        return { items: [pending] };
      },
    }),
  );

  render(<ProposalsPage />);

  const noul = await screen.findByRole('meter', {
    name: 'Noul yes probability',
  });
  expect(noul).toHaveAttribute('aria-valuenow', '94');
  expect(
    screen.getByRole('meter', { name: 'Semantic mismatch severity score' }),
  ).toHaveAttribute('aria-valuenow', '0.09');
  expect(
    screen.getByText('aligned', { selector: '.ag-choice strong' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Advisory, not approval')).toBeInTheDocument();

  const approve = screen.getByRole('button', {
    name: 'Approve exact snapshot',
  });
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I reviewed the exact files/));
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith(
      `plugin://agent-guard/proposals/${pending.id}/decision`,
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const decisionCall = mockFetch.mock.calls.find(
    ([url, options]) => url.endsWith('/decision') && options?.method === 'POST',
  );
  expect(JSON.parse(decisionCall![1].body)).toMatchObject({
    decision: 'approve',
    digest: pending.snapshot.digest,
  });
});

it('keeps a Jev mismatch on hold without review controls', async () => {
  const held = {
    ...proposal,
    status: 'needs_clarification',
    execution: undefined,
    decision: undefined,
    reasonCodes: ['semantic_contradiction'],
    viewerPermissions: {
      canReview: false,
      reason: 'Proposal is not awaiting review',
    },
    semantic: {
      kind: 'evaluated',
      model: 'jev-test',
      choice: 'contradiction',
      choiceConfidence: 0.91,
      choiceProbabilities: { contradiction: 0.91, aligned: 0.09 },
      noul: 0.12,
      score: 3.8,
      scoreProbabilities: { '3': 0.2, '4': 0.8 },
      scoreLegend: { '3': 'Major unrequested scope', '4': 'Direct conflict' },
    },
  };
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/delivery')
        ? {
            checkedAt: '2026-09-24T10:00:00Z',
            github: { state: 'not_published' },
            argoCd: { state: 'not_checked' },
            deployed: false,
          }
        : { items: [held] },
  }));

  render(<ProposalsPage />);

  expect(
    await screen.findByText('contradiction', { selector: '.ag-choice strong' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('meter', { name: 'Noul yes probability' }),
  ).toHaveAttribute('aria-valuenow', '12');
  expect(
    screen.queryByRole('button', { name: 'Approve exact snapshot' }),
  ).toBeNull();
  expect(screen.getByText('Approved').closest('li')).toHaveClass(
    'ag-track__stage--halted',
  );
});

it('shows backend-recorded MCP provenance separately from agent-supplied intent', async () => {
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/delivery')
        ? mergedDelivery
        : { items: [{ ...proposal, submissionChannel: 'mcp_action' }] },
  }));

  render(<ProposalsPage />);

  expect(
    await screen.findByText('MCP action (backend-recorded)'),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/not cryptographically verified user words/),
  ).toBeInTheDocument();
});

it('opens manual creation and selects the returned proposal without starting execution', async () => {
  const created = {
    ...proposal,
    id: '81cf6a93-c00d-445c-b481-8f1513a4a517',
    status: 'needs_clarification',
    intentSource: 'authenticated_user_submitted',
    submissionChannel: 'backstage_rest',
    inputs: { ...proposal.inputs, serviceName: 'manual-demo-api' },
    execution: undefined,
    decision: undefined,
    viewerPermissions: {
      canReview: false,
      reason: 'Proposal is not awaiting review',
    },
  };
  let items: Array<typeof proposal | typeof created> = [proposal];
  mockFetch.mockImplementation(
    async (url: string, options?: { method?: string }) => {
      if (url.startsWith('plugin://catalog/')) {
        return { ok: true, json: async () => [] };
      }
      if (url.endsWith('/delivery')) {
        return {
          ok: true,
          json: async () => ({
            checkedAt: '2026-09-24T10:00:00Z',
            github: { state: 'not_published' },
            argoCd: { state: 'not_checked' },
            deployed: false,
          }),
        };
      }
      if (options?.method === 'POST') {
        items = [created, proposal];
        return { ok: true, json: async () => created };
      }
      return { ok: true, json: async () => ({ items }) };
    },
  );

  render(<ProposalsPage />);
  fireEvent.click(screen.getByRole('button', { name: /New proposal/ }));
  expect(screen.getByText('Create a service proposal')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: /Declared intent/ }), {
    target: { value: 'Create an internal staging Node.js API for payments' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /Service name/ }), {
    target: { value: 'manual-demo-api' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: /Owner group/ }), {
    target: { value: 'group:default/payments-team' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
    target: { value: 'Internal staging API' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit for semantic review' }),
  );

  expect(
    await screen.findByText(/manual-demo-api submitted/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Submitted with authenticated Backstage user credentials/),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Backstage REST (backend-recorded)'),
  ).toBeInTheDocument();
  expect(mockFetch.mock.calls.some(([url]) => url.includes('scaffolder'))).toBe(
    false,
  );
});
