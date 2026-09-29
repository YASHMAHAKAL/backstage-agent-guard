import { fireEvent, render, screen } from '@testing-library/react';
import { RizzReleasesPage } from './RizzReleasesPage';

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
const fixture = {
  releaseId: 'test-fixture',
  sourceCommit: 'a'.repeat(40),
  expiresAt: '2026-10-03T00:00:00Z',
  recordDigest: `sha256:${'b'.repeat(64)}`,
  images: {
    frontend: {
      repository: 'fixture/frontend',
      digest: `sha256:${'c'.repeat(64)}`,
    },
    backend: {
      repository: 'fixture/backend',
      digest: `sha256:${'d'.repeat(64)}`,
    },
  },
  eligibleForProposal: false,
};

it('shows the unconfigured state with no deploy action or fake releases', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ state: 'not_configured', items: [] }),
  });
  render(<RizzReleasesPage />);
  expect(
    await screen.findByText(/Trusted publisher not connected/),
  ).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith('plugin://agent-guard/rizz/releases');
});

it('labels fixtures, allows read-only inspection, and clears stale results on failure', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ state: 'fixture', items: [fixture] }),
  });
  render(<RizzReleasesPage />);
  expect(await screen.findByText(/Fixture evidence only/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: fixture.releaseId },
  });
  expect(
    screen.getByText(/Test fixture; no proposal allowed/),
  ).toBeInTheDocument();
  expect(screen.getByText(fixture.sourceCommit)).toBeInTheDocument();
  mockFetch.mockRejectedValueOnce(new Error('private-token-not-for-ui'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh releases' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Release data unavailable',
  );
  expect(screen.queryByText(fixture.sourceCommit)).not.toBeInTheDocument();
  expect(
    screen.queryByText(/private-token-not-for-ui/),
  ).not.toBeInTheDocument();
});
