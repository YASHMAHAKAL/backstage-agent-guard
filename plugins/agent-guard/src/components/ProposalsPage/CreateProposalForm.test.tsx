import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateProposalForm } from './CreateProposalForm';

const mockFetch = jest.fn();

jest.mock('@backstage/frontend-plugin-api', () => ({
  fetchApiRef: {},
  useApi: () => ({ fetch: mockFetch }),
}));

function fillCommonFields() {
  fireEvent.change(screen.getByRole('textbox', { name: /Declared intent/ }), {
    target: {
      value: 'Create an internal staging service for the payments team',
    },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /Service name/ }), {
    target: { value: 'payments-demo-api' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: /Owner group/ }), {
    target: { value: 'group:default/payments-team' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
    target: { value: 'Internal payments demonstration' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

it('submits only narrow API inputs through Agent Guard REST', async () => {
  const onSubmitted = jest.fn();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('plugin://catalog/')) {
      return {
        ok: true,
        json: async () => [
          {
            kind: 'Group',
            metadata: { name: 'payments-team', title: 'Payments Team' },
          },
        ],
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: 'created-proposal',
        status: 'pending_approval',
        inputs: { serviceName: 'payments-demo-api' },
      }),
    };
  });

  render(<CreateProposalForm onClose={jest.fn()} onSubmitted={onSubmitted} />);
  await waitFor(() =>
    expect(
      document.querySelector(
        'datalist option[value="group:default/payments-team"]',
      ),
    ).not.toBeNull(),
  );
  fillCommonFields();
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit for semantic review' }),
  );

  await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  const call = mockFetch.mock.calls.find(
    ([url]) => url === 'plugin://agent-guard/proposals',
  );
  expect(call?.[1].method).toBe('POST');
  expect(JSON.parse(call![1].body)).toEqual({
    declaredIntent: 'Create an internal staging service for the payments team',
    templateId: 'nodejs-api',
    inputs: {
      serviceName: 'payments-demo-api',
      requestedOwner: 'group:default/payments-team',
      environment: 'staging',
      description: 'Internal payments demonstration',
      replicas: 1,
    },
  });
  expect(mockFetch.mock.calls.some(([url]) => url.includes('scaffolder'))).toBe(
    false,
  );
});

it('requires a worker cron schedule and includes it only for that template', async () => {
  const onSubmitted = jest.fn();
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.startsWith('plugin://catalog/')
        ? []
        : { id: 'created-worker', status: 'pending_approval' },
  }));
  render(<CreateProposalForm onClose={jest.fn()} onSubmitted={onSubmitted} />);
  fillCommonFields();
  fireEvent.click(screen.getByRole('radio', { name: /Scheduled worker/ }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit for semantic review' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'five-field cron schedule',
  );
  expect(
    mockFetch.mock.calls.some(
      ([url]) => url === 'plugin://agent-guard/proposals',
    ),
  ).toBe(false);

  fireEvent.change(
    screen.getByRole('textbox', { name: /Five-field cron schedule/ }),
    { target: { value: '0 2 * * *' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit for semantic review' }),
  );
  await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  const call = mockFetch.mock.calls.find(
    ([url]) => url === 'plugin://agent-guard/proposals',
  );
  expect(JSON.parse(call![1].body).inputs.schedule).toBe('0 2 * * *');
});

it('shows backend denial and does not claim a proposal was created', async () => {
  const onSubmitted = jest.fn();
  mockFetch.mockImplementation(async (url: string) => ({
    ok: url.startsWith('plugin://catalog/'),
    status: 400,
    json: async () =>
      url.startsWith('plugin://catalog/')
        ? []
        : { error: { message: 'Requested owner must exist in Catalog' } },
  }));
  render(<CreateProposalForm onClose={jest.fn()} onSubmitted={onSubmitted} />);
  fillCommonFields();
  fireEvent.click(
    screen.getByRole('button', { name: 'Submit for semantic review' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Requested owner must exist in Catalog',
  );
  expect(onSubmitted).not.toHaveBeenCalled();
});
