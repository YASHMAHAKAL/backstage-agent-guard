import {
  AuthService,
  DatabaseService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { mockCredentials } from '@backstage/backend-test-utils';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { applicationReviewPolicy } from '../cloudReviewPolicy';
import { ProposalService } from './ProposalService';
import { ProposalOverviewService } from './ProposalOverviewService';

const record = (id: string, requester: string) => ({
  id,
  requester,
  status: 'pr_open',
  createdAt: '2026-10-04T02:25:41.980Z',
  snapshot: {
    envelope: {
      kind: 'rizz_cloud_release',
      policyVersion: applicationReviewPolicy,
      target: { owner: 'group:default/platform-team' },
      inputs: { releaseId: 'rizz-verified-pair-1' },
    },
    files: [{ content: 'private manifest content must stay out of overview' }],
  },
});

function service(options: { kindFailure?: boolean } = {}) {
  const rows = [
    record('00000000-0000-4000-8000-000000000001', 'user:default/developer'),
    record('00000000-0000-4000-8000-000000000002', 'user:default/other'),
  ].map(value => ({ record: JSON.stringify(value) }));
  const client = Object.assign(
    jest.fn().mockReturnValue({
      orderBy: () => ({ limit: async () => rows }),
    }),
    { schema: { hasTable: async () => true } },
  );
  const auth = {
    isPrincipal: (credentials: { principal: { type: string } }) =>
      credentials.principal.type === 'user',
  } as unknown as AuthService;
  const userInfo = {
    getUserInfo: async (credentials: {
      principal: { userEntityRef: string };
    }) => ({
      userEntityRef: credentials.principal.userEntityRef,
      ownershipEntityRefs:
        credentials.principal.userEntityRef === 'user:default/reviewer' ||
        credentials.principal.userEntityRef === 'user:default/stranger'
          ? ['group:default/platform-team']
          : [],
    }),
  } as unknown as UserInfoService;
  const catalog = {
    getEntityByRef: async (ref: string) => ({
      kind: 'User',
      relations:
        ref === 'user:default/reviewer'
          ? [
              {
                type: 'memberOf',
                targetRef: 'group:default/platform-team',
              },
            ]
          : [],
    }),
  } as unknown as typeof catalogServiceRef.T;
  return new ProposalOverviewService({
    auth,
    userInfo,
    catalog,
    database: { getClient: async () => client } as unknown as DatabaseService,
    logger: { warn: jest.fn() } as unknown as LoggerService,
    proposals: {
      list: async () => {
        if (options.kindFailure) throw new Error('Kind reader unavailable');
        return [];
      },
    } as unknown as ProposalService,
  });
}

it('shows disabled cloud history to its requester without exposing manifest content', async () => {
  const overview = await service().list(
    mockCredentials.user('user:default/developer'),
  );
  expect(overview.cloudState).toBe('disabled');
  expect(overview.items).toEqual([
    expect.objectContaining({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'rizz',
      canReview: false,
    }),
  ]);
  expect(overview.items[0]).not.toHaveProperty('detailUrl');
  expect(JSON.stringify(overview)).not.toContain('private manifest content');
});

it('requires both authenticated and Catalog membership for reviewer visibility', async () => {
  const reviewer = await service().list(
    mockCredentials.user('user:default/reviewer'),
  );
  expect(reviewer.items).toHaveLength(2);
  expect(reviewer.items.every(item => !item.canReview)).toBe(true);

  const unconfirmedClaim = await service().list(
    mockCredentials.user('user:default/stranger'),
  );
  expect(unconfirmedClaim.items).toEqual([]);

  const guest = await service().list(
    mockCredentials.user('user:default/guest'),
  );
  expect(guest).toMatchObject({ cloudState: 'restricted', items: [] });
});

it('keeps authorized cloud history visible if the Kind queue is unavailable', async () => {
  const overview = await service({ kindFailure: true }).list(
    mockCredentials.user('user:default/developer'),
  );
  expect(overview.kindState).toBe('unavailable');
  expect(overview.cloudState).toBe('disabled');
  expect(overview.items).toHaveLength(1);
});
