import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RizzInfrastructurePage } from './RizzInfrastructurePage';

const mockFetch = jest.fn();
jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));

const id = 'ff26811f-bbfc-42f3-843f-e2bb4e13c7df';
let requests: object[];
let capacityPublishing: boolean;
beforeEach(() => {
  capacityPublishing = true;
  requests = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/capabilities'))
      return {
        ok: true,
        json: async () => ({
          state: 'request_and_review',
          executable: false,
          capacityPublishing,
        }),
      };
    if (url.endsWith('/requests') && options?.method === 'POST') {
      const request = JSON.parse(options.body as string);
      const created = {
        id,
        status: 'awaiting_configuration_pr',
        requester: 'user:default/platform',
        createdAt: new Date().toISOString(),
        request,
        capacityBaseline: { workers: 1, mainSha: 'a'.repeat(40) },
        canReview: false,
        executable: false,
      };
      requests = [created];
      return { ok: true, json: async () => created };
    }
    if (url.endsWith('/configuration-pr') && options?.method === 'POST') {
      requests = [
        {
          ...requests[0],
          status: 'configuration_pr_open',
          configurationPrDraft: {
            url: 'https://github.com/example/portal/pull/9',
            headCommit: 'b'.repeat(40),
            baseCommit: 'a'.repeat(40),
          },
        },
      ];
      return { ok: true, json: async () => requests[0] };
    }
    if (url.endsWith('/requests'))
      return { ok: true, json: async () => ({ items: requests }) };
    if (url.endsWith(`/${id}/aws-observation`))
      return {
        ok: true,
        json: async () => ({
          state: 'observed',
          root: 'staging',
          scope: 'partial_inventory',
          observedAt: '2026-09-29T00:00:00.000Z',
          checks: [{ name: 'EKS cluster', observed: true, detail: 'ACTIVE' }],
        }),
      };
    throw new Error(`Unexpected endpoint ${url}`);
  });
});

it('offers a bounded capacity PR form without suggesting Terraform was applied', async () => {
  render(<RizzInfrastructurePage />);
  await screen.findByText('No requests recorded yet.');
  fireEvent.change(screen.getByLabelText('Change type'), {
    target: { value: 'capacity_change' },
  });
  fireEvent.change(screen.getByLabelText('Declared intent'), {
    target: { value: 'Increase only the staging worker count to two.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record request' }));
  await screen.findByText(/1 → 2 staging workers/);
  expect(
    JSON.parse(
      mockFetch.mock.calls.find(
        ([, option]) =>
          option?.method === 'POST' &&
          String(option.body).includes('capacity_change'),
      )![1].body,
    ),
  ).toMatchObject({
    operation: 'capacity_change',
    root: 'staging',
    desiredWorkers: 2,
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Open bounded configuration PR' }),
  );
  await screen.findByRole('link', { name: 'Review one-file PR' });
  expect(
    screen.getByText(/merge does not apply Terraform/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Apply Terraform/ }),
  ).not.toBeInTheDocument();
});

it('hides capacity controls when policy evidence has not activated them', async () => {
  capacityPublishing = false;
  render(<RizzInfrastructurePage />);
  await waitFor(() =>
    expect(screen.getByLabelText('Change type')).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole('option', { name: /Staging node capacity/ }),
  ).not.toBeInTheDocument();
});

it('labels independent inventory as partial and never as applied', async () => {
  requests = [
    {
      id,
      status: 'runner_reported_applied',
      requester: 'user:default/platform',
      createdAt: '2026-09-29T00:00:00.000Z',
      request: {
        operation: 'foundation_setup',
        root: 'staging',
        declaredIntent: 'Create the reviewed staging foundation.',
      },
      runnerOutcome: {
        runId: id,
        status: 'applied',
        reportedAt: '2026-09-29T00:00:00.000Z',
      },
      canReview: false,
      executable: false,
    },
  ];
  render(<RizzInfrastructurePage />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Refresh AWS inventory' }),
  );
  expect(await screen.findByText(/EKS cluster: observed/)).toBeInTheDocument();
  expect(
    screen.getByText(/do not prove Terraform drift-free state/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Apply Terraform/ }),
  ).not.toBeInTheDocument();
});
