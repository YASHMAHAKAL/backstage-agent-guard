import {
  LoggerService,
  SchedulerService,
  UrlReaderService,
} from '@backstage/backend-plugin-api';
import { EntityProviderConnection } from '@backstage/plugin-catalog-node';
import { GitopsCatalogProvider } from './gitopsCatalogProvider';

const prefix =
  'https://github.com/example-platform/backstage-agent-guard-gitops/blob/main/apps/staging';

function descriptor(name: string, kind = 'Component') {
  return {
    url: `${prefix}/${name}/catalog-info.yaml`,
    content: async () =>
      Buffer.from(`apiVersion: backstage.io/v1alpha1
kind: ${kind}
metadata:
  name: ${name}
  annotations:
    backstage.io/kubernetes-id: ${name}
spec:
  type: service
  lifecycle: staging
  owner: group:default/payments-team
`),
  };
}

function setup() {
  const search = jest.fn();
  const applyMutation = jest.fn().mockResolvedValue(undefined);
  const scheduleTask = jest.fn().mockResolvedValue(undefined);
  const provider = new GitopsCatalogProvider({
    owner: 'example-platform',
    repo: 'backstage-agent-guard-gitops',
    reader: { search } as unknown as UrlReaderService,
    scheduler: { scheduleTask } as unknown as SchedulerService,
    logger: { info: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
  });
  return { provider, search, applyMutation, scheduleTask };
}

it('discovers only main-branch staging descriptors for valid service folders', async () => {
  const { provider, search, applyMutation, scheduleTask } = setup();
  search.mockResolvedValue({
    files: [
      descriptor('gitops-pr-demo-api'),
      descriptor('payments-fastapi'),
      {
        url: 'https://github.com/example-platform/backstage-agent-guard-gitops/blob/agent-guard/unmerged/apps/staging/unmerged/catalog-info.yaml',
      },
      descriptor('bad_name'),
      { url: `${prefix}/payments-fastapi/deployment.yaml` },
      descriptor('wrong-kind', 'Location'),
    ],
    etag: 'commit-1',
  });
  await provider.connect({
    applyMutation,
  } as unknown as EntityProviderConnection);
  await provider.refresh();

  expect(search).toHaveBeenCalledWith(`${prefix}/*/catalog-info.yaml`);
  expect(scheduleTask).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'discover-merged-gitops-components',
      frequency: { minutes: 1 },
    }),
  );
  expect(applyMutation).toHaveBeenCalledWith({
    type: 'full',
    entities: expect.arrayContaining([
      expect.objectContaining({
        locationKey: `${prefix}/gitops-pr-demo-api/catalog-info.yaml`,
      }),
      expect.objectContaining({
        locationKey: `${prefix}/payments-fastapi/catalog-info.yaml`,
      }),
    ]),
  });
  const mutation = applyMutation.mock.calls[0][0];
  expect(mutation.entities).toHaveLength(2);
  expect(mutation.entities[1].entity).toMatchObject({
    kind: 'Component',
    metadata: {
      name: 'payments-fastapi',
      annotations: {
        'backstage.io/kubernetes-id': 'payments-fastapi',
        'backstage.io/kubernetes-namespace': 'staging',
        'backstage.io/managed-by-location':
          `url:${prefix}/payments-fastapi/catalog-info.yaml`,
        'backstage.io/managed-by-origin-location':
          `url:${prefix}/payments-fastapi/catalog-info.yaml`,
      },
    },
  });
});

it('retains existing Catalog locations when GitHub discovery fails', async () => {
  const { provider, search, applyMutation } = setup();
  search.mockRejectedValue(new Error('GitHub temporarily unavailable'));
  await provider.connect({
    applyMutation,
  } as unknown as EntityProviderConnection);

  await expect(provider.refresh()).rejects.toThrow(
    'GitHub temporarily unavailable',
  );
  expect(applyMutation).not.toHaveBeenCalled();
});

it('removes missing descriptors on a later successful full refresh', async () => {
  const { provider, search, applyMutation } = setup();
  search
    .mockResolvedValueOnce({
      files: [descriptor('payments-fastapi')],
      etag: 'commit-1',
    })
    .mockResolvedValueOnce({ files: [], etag: 'commit-2' });
  await provider.connect({
    applyMutation,
  } as unknown as EntityProviderConnection);

  await provider.refresh();
  await provider.refresh();
  expect(applyMutation.mock.calls[0][0].entities).toHaveLength(1);
  expect(applyMutation.mock.calls[1][0]).toEqual({
    type: 'full',
    entities: [],
  });
});
