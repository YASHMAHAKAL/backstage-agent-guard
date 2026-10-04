import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequestOverviewPage } from './RequestOverviewPage';

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

const kind = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'kind',
  title: 'payments-api',
  operation: 'nodejs-api',
  owner: 'group:default/payments-team',
  requester: 'user:default/other',
  status: 'pending_approval',
  createdAt: '2026-10-03T12:00:00Z',
  canReview: true,
  detailUrl: '/agent-guard/kind?proposal=00000000-0000-4000-8000-000000000001',
};
const cloud = {
  id: '00000000-0000-4000-8000-000000000002',
  type: 'rizz',
  title: 'Rizz.AI paired release',
  operation: 'rizz_cloud_release',
  owner: 'group:default/platform-team',
  requester: 'user:default/developer',
  status: 'pr_open',
  createdAt: '2026-10-04T12:00:00Z',
  canReview: false,
  detailUrl:
    '/rizz-deployments?proposal=00000000-0000-4000-8000-000000000002#review-queue',
};

beforeEach(() => mockFetch.mockReset());

it('shows both authorized request types and links to their detail pages', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      viewer: 'user:default/developer',
      kindState: 'available',
      cloudState: 'configured',
      items: [cloud, kind],
    }),
  });
  render(<RequestOverviewPage />);

  expect(await screen.findByText('payments-api')).toHaveAttribute(
    'href',
    kind.detailUrl,
  );
  expect(screen.getByText('Rizz.AI paired release')).toHaveAttribute(
    'href',
    cloud.detailUrl,
  );
  fireEvent.click(screen.getByRole('button', { name: /Awaiting my review/ }));
  expect(screen.getByText('payments-api')).toBeInTheDocument();
  expect(screen.queryByText('Rizz.AI paired release')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /My requests/ }));
  expect(screen.getByText('Rizz.AI paired release')).toBeInTheDocument();
  expect(screen.queryByText('payments-api')).not.toBeInTheDocument();
});

it('keeps cloud history read-only while cloud operations are disabled', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      viewer: 'user:default/developer',
      kindState: 'available',
      cloudState: 'disabled',
      items: [{ ...cloud, detailUrl: undefined }],
    }),
  });
  render(<RequestOverviewPage />);

  expect(await screen.findByText('Rizz.AI paired release')).not.toHaveAttribute(
    'href',
  );
  expect(screen.getByText('Read-only history')).toBeInTheDocument();
  expect(screen.getByText(/Cloud operations are off/)).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.queryByRole('link', { name: 'Propose Rizz.AI release' }),
    ).not.toBeInTheDocument(),
  );
});
