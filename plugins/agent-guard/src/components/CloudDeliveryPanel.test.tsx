import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudDeliveryPanel } from './CloudDeliveryPanel';

const mockFetch = jest.fn();
jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));
const observed = {
  checkedAt: '2026-09-27T12:00:00Z',
  github: { state: 'merged_files_match', revision: 'a'.repeat(40) },
  argoCd: {
    state: 'synced_files_match',
    revision: 'b'.repeat(40),
    sync: 'Synced',
    health: 'Healthy',
  },
  workloads: { state: 'not_checked' },
  smoke: { state: 'not_checked' },
  deployed: false,
};
const handoff = {
  status: 'pr_open',
  decision: { decision: 'approve' },
  execution: {
    state: 'pr_open',
    taskId: 'task-1',
    prUrl: 'https://github.com/example/gitops/pull/3',
  },
};
beforeEach(() => mockFetch.mockReset());
it('checks only the scoped read endpoint and never treats matching files as deployment proof', async () => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => observed });
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  expect(mockFetch).not.toHaveBeenCalled();
  expect(screen.getByText('Merge verified').closest('li')).toHaveClass(
    'ag-track__stage--current',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByText(/Observed at/);
  expect(mockFetch).toHaveBeenCalledWith(
    'plugin://agent-guard/rizz/proposals/fixture-id/delivery',
    { signal: expect.any(AbortSignal) },
  );
  expect(screen.getByText(/Deployment not verified/)).toBeInTheDocument();
  expect(screen.getByText('merged files match')).toBeInTheDocument();
  expect(screen.getByText('synced files match')).toBeInTheDocument();
  expect(screen.getByText('Verified').closest('li')).toHaveClass(
    'ag-track__stage--current',
  );
});
it('clears successful evidence when a new read fails; provider secrets are not rendered', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: async () => observed })
    .mockRejectedValueOnce(new Error('provider-private-token'));
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByText(/Observed at/);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('synced files match')).not.toBeInTheDocument();
  expect(screen.queryByText(/provider-private-token/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Observed at/)).not.toBeInTheDocument();
});
it('rejects unsupported claims of successful deployment', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ...observed, deployed: true }),
  });
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/Observed at/)).not.toBeInTheDocument();
});
it('shows verified delivery and replica evidence only when all stages pass', async () => {
  const evidence = {
    ...observed,
    deployed: true,
    workloads: {
      state: 'verified',
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
        generation: 4,
      },
    },
    smoke: { state: 'verified', health: 'alive', readiness: 'ready' },
  };
  mockFetch.mockResolvedValue({ ok: true, json: async () => evidence });
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByText(/Deployment verified for the approved release/);
  expect(screen.getByText(/backend: 2\/2 Pods ready/)).toBeInTheDocument();
  expect(screen.getByText(/4 of 4 checks verified/)).toBeInTheDocument();
  expect(
    screen.getByRole('list', { name: 'Cloud delivery stages' }),
  ).toHaveTextContent('VerifiedComplete');
});
it('rejects incomplete replicas even if the provider response claims verified', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      ...observed,
      deployed: true,
      workloads: {
        state: 'verified',
        frontend: {
          desired: 2,
          updated: 2,
          available: 1,
          readyPods: 1,
          generation: 2,
        },
      },
      smoke: { state: 'verified', health: 'alive', readiness: 'ready' },
    }),
  });
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/Deployment verified/)).not.toBeInTheDocument();
});
it('allows only one in-flight check', async () => {
  let finish!: (value: unknown) => void;
  mockFetch.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  render(<CloudDeliveryPanel proposalId="fixture-id" handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check cloud delivery' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Checking cloud delivery…' }),
  );
  expect(mockFetch).toHaveBeenCalledTimes(1);
  finish({ ok: true, json: async () => observed });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Check cloud delivery' }),
    ).toBeEnabled(),
  );
});
