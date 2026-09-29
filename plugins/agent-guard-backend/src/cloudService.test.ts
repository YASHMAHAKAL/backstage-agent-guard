import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { actionsRegistryServiceMock } from '@backstage/backend-test-utils/alpha';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { scaffolderServiceMock } from '@backstage/plugin-scaffolder-node/testUtils';
import request from 'supertest';
import { CloudTarget } from './cloudTarget';
import { JevClient } from './jev';
import { createAgentGuardPlugin } from './plugin';
import { ReleaseCatalog, ReleaseRecord, releaseDigest } from './releases';
import { CloudReaders } from './services/CloudProposalService';
import { sha256 } from './snapshot';
import { cloudTemplateSpec } from './cloudTemplate';
import { emptyCloudDelivery } from './cloudDelivery';
import {
  cloudDeliveryFixture,
  releaseFixtureEnvelope,
} from './testFixtures/cloudDeliveryFixture';
import {
  createCloudFrozenSnapshot,
  inspectCloudGitopsFiles,
} from './cloudSnapshot';
import { canonicalize } from './snapshot';
import { basename } from 'node:path';

const target: CloudTarget = {
  id: 'eks-staging',
  accountId: '000000000000',
  region: 'us-east-1',
  clusterName: 'rizz-eks-staging',
  namespace: 'rizz-staging',
  owner: 'group:default/platform-team',
  sourceRepository: 'example/Rizz.AI',
  gitopsRepository: 'https://github.com/example/gitops.git',
  gitopsBranch: 'main',
  gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
  argoApplication: 'rizz-ai-staging',
  ingress: {
    stage: 'ready',
    hostname: 'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com',
    operatorCidr: '203.0.113.10/32',
    certificateArn:
      'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
    certificateSha256: sha256('fixture-cert'),
  },
};
const groups: Record<string, string[]> = {
  'user:default/developer': [
    'group:default/developers',
    'group:default/rizz-team',
  ],
  'user:default/reviewer': [target.owner],
  'user:default/app_peer': ['group:default/rizz-team'],
  'user:default/stranger': [],
  'user:default/guest': [target.owner],
};
const userInfo = createServiceFactory({
  service: coreServices.userInfo,
  deps: {},
  async factory() {
    return {
      async getUserInfo(credentials) {
        const ref = (credentials.principal as { userEntityRef: string })
          .userEntityRef;
        return {
          userEntityRef: ref,
          ownershipEntityRefs: [ref, ...(groups[ref] ?? [])],
        };
      },
    };
  },
});
let backend: Awaited<ReturnType<typeof startTestBackend>> | undefined;
const initialAuthMode = process.env.AGENT_GUARD_AUTH_MODE;
afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  if (initialAuthMode === undefined) delete process.env.AGENT_GUARD_AUTH_MODE;
  else process.env.AGENT_GUARD_AUTH_MODE = initialAuthMode;
});
async function start(
  options: {
    disabled?: boolean;
    mismatch?: boolean;
    unavailable?: boolean;
    dispatchFailure?: boolean;
    missingTemplate?: boolean;
    wrongAppOwner?: boolean;
    delivery?: boolean;
  } = {},
) {
  process.env.AGENT_GUARD_AUTH_MODE = 'github';
  const record: ReleaseRecord = {
    schemaVersion: 1,
    releaseId: `rizz-${'a'.repeat(40)}-100-1`,
    source: {
      repository: target.sourceRepository,
      commit: 'a'.repeat(40),
      ref: 'refs/heads/master',
    },
    workflow: {
      path: '.github/workflows/publish.yml',
      runId: 100,
      runAttempt: 1,
    },
    createdAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    checks: {
      tests: 'passed',
      scan: 'passed',
      policyVersion: 'rizz-build-v1-high-critical',
    },
    images: {
      frontend: {
        repository:
          '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-frontend',
        digest: sha256('fixture-front'),
        sourceCommit: 'a'.repeat(40),
      },
      backend: {
        repository:
          '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend',
        digest: sha256('fixture-back'),
        sourceCommit: 'a'.repeat(40),
      },
    },
  };
  const resolve = jest.fn().mockResolvedValue([
    {
      record,
      evidence: {
        repository: record.source.repository,
        ref: record.source.ref,
        commit: record.source.commit,
        workflowPath: record.workflow.path,
        runId: 100,
        runAttempt: 1,
        conclusion: 'success',
        event: 'push',
        artifactExpired: false,
        artifactRecordDigest: releaseDigest(record),
        verifiedImages: Object.values(record.images).map(
          i => `${i.repository}@${i.digest}`,
        ),
      },
    },
  ]);
  const releases = new ReleaseCatalog({
    policy: {
      repository: record.source.repository,
      ref: record.source.ref,
      workflowPath: record.workflow.path,
      frontendRepository: record.images.frontend.repository,
      backendRepository: record.images.backend.repository,
    },
    source: { mode: 'authenticated_ci', read: async () => [], resolve },
  });
  const verifyTarget = jest.fn().mockResolvedValue(undefined);
  const base = { revision: 'b'.repeat(40), files: [] };
  const readGitops = jest.fn().mockImplementation(async () => ({
    base,
    currentState: { state: 'absent' },
  }));
  const readers: CloudReaders = {
    mode: 'authenticated',
    verifyTarget,
    readGitops,
  };
  const fetcher = jest.fn().mockImplementation(async () =>
    options.unavailable
      ? new Response(null, { status: 503 })
      : Response.json({
          model: 'jev-test-only',
          answers: {
            alignment: {
              type: 'choice',
              choice: options.mismatch ? 'contradiction' : 'aligned',
              probabilities: options.mismatch
                ? { contradiction: 0.95 }
                : { aligned: 0.95 },
              confidence: 0.95,
            },
            preservesIntent: {
              type: 'noul',
              noul: options.mismatch ? 0.1 : 0.95,
            },
            mismatchSeverity: {
              type: 'score',
              score: options.mismatch ? 4 : 0.1,
              probabilities: { '0': 0.9 },
              legend: { '0': 'No mismatch' },
              confidence: 0.95,
            },
          },
        }),
  );
  const scaffolder = scaffolderServiceMock.mock({
    scaffold: options.dispatchFailure
      ? jest.fn().mockRejectedValue(new Error('private-provider-error'))
      : jest.fn().mockResolvedValue({ taskId: 'cloud-task-only' }),
  });
  const actions = actionsRegistryServiceMock();
  const observe = jest
    .fn()
    .mockImplementation(async () => emptyCloudDelivery('not_published'));
  backend = await startTestBackend({
    features: [
      userInfo,
      scaffolder.factory,
      mockServices.rootConfig.factory({
        data: { auth: { environment: 'github' } },
      }),
      createServiceFactory({
        service: actionsRegistryServiceRef,
        deps: {},
        async factory() {
          return actions;
        },
      }),
      catalogServiceMock.factory({
        entities: [
          ...(!options.missingTemplate
            ? [
                {
                  apiVersion: 'scaffolder.backstage.io/v1beta3',
                  kind: 'Template',
                  metadata: {
                    name: 'deploy-rizz-ai',
                    annotations: {
                      'agent-guard.backstage.io/recipe-version':
                        'rizz-paired-v1-restricted-alb',
                    },
                  },
                  spec: cloudTemplateSpec,
                },
              ]
            : []),
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'platform-team' },
            spec: { type: 'team', children: [] },
          },
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'rizz-team' },
            spec: { type: 'team', children: [] },
          },
          ...[
            ['System', 'rizz-ai'],
            ['Component', 'rizz-frontend'],
            ['Component', 'rizz-backend'],
            ['API', 'rizz-api'],
          ].map(([kind, name]) => ({
            apiVersion: 'backstage.io/v1alpha1',
            kind,
            metadata: {
              name,
              annotations: {
                'backstage.io/source-location':
                  'url:https://github.com/example/Rizz.AI/',
                ...(kind === 'System'
                  ? { 'backstage.io/techdocs-ref': 'dir:.' }
                  : {}),
              },
            },
            spec: {
              owner: options.wrongAppOwner
                ? 'group:default/platform-team'
                : 'group:default/rizz-team',
              ...(kind !== 'System' ? { system: 'rizz-ai' } : {}),
              ...(name === 'rizz-frontend'
                ? { consumesApis: ['rizz-api'] }
                : {}),
              ...(name === 'rizz-backend'
                ? { providesApis: ['rizz-api'] }
                : {}),
            },
          })),
          ...Object.entries(groups).map(([ref, memberships]) => ({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: { name: ref.split('/')[1] },
            spec: { memberOf: memberships.map(g => g.split('/')[1]) },
            relations: memberships.map(g => ({
              type: 'memberOf',
              targetRef: g,
            })),
          })),
        ],
      }),
      createAgentGuardPlugin({
        jev: new JevClient('test-key-not-live', fetcher as typeof fetch),
        ...(!options.disabled
          ? {
              cloud: {
                target,
                releases,
                readers,
                ...(options.delivery ? { delivery: { observe } } : {}),
                submitterGroups: ['group:default/rizz-team', target.owner],
              },
            }
          : {}),
      }),
    ],
  });
  const proposal = {
    declaredIntent:
      'Deploy the paired Rizz.AI release to EKS staging. Frontend HTTPS, backend private.',
    templateId: 'deploy-rizz-ai',
    inputs: {
      targetId: 'eks-staging',
      releaseId: record.releaseId,
      releaseRecordDigest: releaseDigest(record),
      frontendReplicas: 1,
      backendReplicas: 2,
    },
  };
  return {
    ...backend,
    actions,
    scaffolder,
    fetcher,
    resolve,
    verifyTarget,
    readGitops,
    base,
    proposal,
    observe,
  };
}
const header = (name = 'developer') =>
  mockCredentials.user.header(`user:default/${name}`);
const url = '/api/agent-guard/rizz/proposals';
const runtimeUrl = '/api/agent-guard/rizz/runtime/proposals';
const runtimeInput = {
  operation: 'runtime_change' as const,
  declaredIntent:
    'Increase only the Rizz.AI backend to two replicas; keep the frontend unchanged.',
  targetId: 'eks-staging' as const,
  patch: { backendReplicas: 2 },
};
function seedRuntimeBaseline(
  readGitops: jest.Mock,
  options: { currentBackendReplicas?: number } = {},
) {
  const fixtureRecord = releaseFixtureEnvelope(cloudDeliveryFixture()).release
    .record;
  const snapshot = createCloudFrozenSnapshot({
    now: Date.parse(fixtureRecord.createdAt),
    target,
    context: {
      proposalId: '00000000-0000-4000-8000-000000000099',
      requester: 'user:default/developer',
      submissionChannel: 'backstage_rest',
    },
    proposal: {
      declaredIntent: 'Deploy the paired Rizz.AI staging release.',
      templateId: 'deploy-rizz-ai',
      inputs: {
        targetId: target.id,
        releaseId: fixtureRecord.releaseId,
        releaseRecordDigest: releaseDigest(fixtureRecord),
        frontendReplicas: 1,
        backendReplicas: 2,
      },
    },
    release: {
      state: 'verified',
      record: fixtureRecord,
      recordDigest: releaseDigest(fixtureRecord),
    },
    gitopsBase: { revision: 'a'.repeat(40), files: [] },
  });
  const contents = Object.fromEntries(
    snapshot.files.map(file => [basename(file.path), file.content]),
  );
  const deployment = JSON.parse(contents['backend-deployment.yaml']);
  deployment.spec.replicas = options.currentBackendReplicas ?? 1;
  contents['backend-deployment.yaml'] = `${canonicalize(deployment)}\n`;
  const base = {
    revision: 'b'.repeat(40),
    files: Object.keys(contents).map(name => ({
      name,
      sha256: sha256(contents[name]),
    })),
  };
  readGitops.mockResolvedValue({
    base,
    currentState: inspectCloudGitopsFiles(contents, target),
    contents,
  });
  return { base, contents };
}

describe('authenticated cloud service using ONLY synthetic backend/reader/CI fixtures', () => {
  it('offers an authenticated read-only runtime preview without Jev, persistence or dispatch', async () => {
    const s = await start();
    const fixtureRecord = releaseFixtureEnvelope(cloudDeliveryFixture()).release
      .record;
    const snapshot = createCloudFrozenSnapshot({
      now: Date.parse(fixtureRecord.createdAt),
      target,
      context: {
        proposalId: '00000000-0000-4000-8000-000000000099',
        requester: 'user:default/developer',
        submissionChannel: 'backstage_rest',
      },
      proposal: {
        declaredIntent: 'Deploy the paired Rizz.AI staging release.',
        templateId: 'deploy-rizz-ai',
        inputs: {
          targetId: target.id,
          releaseId: fixtureRecord.releaseId,
          releaseRecordDigest: releaseDigest(fixtureRecord),
          frontendReplicas: 1,
          backendReplicas: 2,
        },
      },
      release: {
        state: 'verified',
        record: fixtureRecord,
        recordDigest: releaseDigest(fixtureRecord),
      },
      gitopsBase: { revision: 'a'.repeat(40), files: [] },
    });
    const contents = Object.fromEntries(
      snapshot.files.map(file => [basename(file.path), file.content]),
    );
    const deployment = JSON.parse(contents['backend-deployment.yaml']);
    deployment.spec.replicas = 1;
    contents['backend-deployment.yaml'] = `${canonicalize(deployment)}\n`;
    s.readGitops.mockResolvedValue({
      base: {
        revision: 'b'.repeat(40),
        files: Object.keys(contents).map(name => ({
          name,
          sha256: sha256(contents[name]),
        })),
      },
      currentState: inspectCloudGitopsFiles(contents, target),
      contents,
    });
    const input = {
      operation: 'runtime_change',
      declaredIntent:
        'Increase only the Rizz.AI backend to two replicas; keep the frontend unchanged.',
      targetId: 'eks-staging',
      patch: { backendReplicas: 2 },
    };
    const path = '/api/agent-guard/rizz/runtime/preview';
    await request(s.server)
      .post(path)
      .set('Authorization', header('stranger'))
      .send(input)
      .expect(403);
    await request(s.server)
      .post(path)
      .set('Authorization', header('guest'))
      .send(input)
      .expect(403);
    expect(s.readGitops).not.toHaveBeenCalled();
    await request(s.server)
      .post(path)
      .set('Authorization', header())
      .send({ ...input, patch: { backendReplicas: 3 } })
      .expect(400);
    expect(s.readGitops).not.toHaveBeenCalled();
    const response = await request(s.server)
      .post(path)
      .set('Authorization', header())
      .send(input)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      state: 'preview',
      operation: 'runtime_change',
      before: { frontendReplicas: 1, backendReplicas: 1 },
      after: { frontendReplicas: 1, backendReplicas: 2 },
      changedFields: ['backendReplicas'],
    });
    expect(response.body.changedFiles).toHaveLength(1);
    const noChange = await request(s.server)
      .post(path)
      .set('Authorization', header())
      .send({ ...input, patch: { backendReplicas: 1 } })
      .expect(200);
    expect(noChange.body).toMatchObject({
      state: 'no_change',
      changedFields: [],
      changedFiles: [],
    });
    s.readGitops.mockResolvedValue({
      base: { revision: 'b'.repeat(40), files: [] },
      currentState: { state: 'absent' },
    });
    await request(s.server)
      .post(path)
      .set('Authorization', header())
      .send(input)
      .expect(409);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    const proposals = await request(s.server)
      .get(url)
      .set('Authorization', header())
      .expect(200);
    expect(proposals.body.items).toEqual([]);
  });
  it('shows role-scoped evidence-specific readiness without inventing live health', async () => {
    const s = await start();
    await request(s.server)
      .get('/api/agent-guard/rizz/readiness')
      .set('Authorization', header('stranger'))
      .expect(403);
    const response = await request(s.server)
      .get('/api/agent-guard/rizz/readiness')
      .set('Authorization', header())
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.scope).toBe('rizz-ai/eks-staging');
    expect(response.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ownership', state: 'pass' }),
        expect.objectContaining({ id: 'relationships', state: 'pass' }),
        expect.objectContaining({ id: 'techdocs_reference', state: 'pass' }),
        expect.objectContaining({ id: 'paired_release', state: 'fail' }),
        expect.objectContaining({
          id: 'historical_delivery',
          state: 'unknown',
        }),
        expect.objectContaining({ id: 'live_metrics', state: 'unknown' }),
      ]),
    );
    expect(
      response.body.checks.every(
        (item: { checkedAt: string; evidenceUrl: string }) =>
          Boolean(item.checkedAt && item.evidenceUrl),
      ),
    ).toBe(true);
    expect(s.verifyTarget).not.toHaveBeenCalled();
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    await request(s.server)
      .get('/api/agent-guard/rizz/metrics')
      .set('Authorization', header('stranger'))
      .expect(403);
    await request(s.server)
      .get('/api/agent-guard/rizz/metrics')
      .set('Authorization', header())
      .expect(200)
      .expect(response => expect(response.body.state).toBe('unavailable'));
  });
  it('authorizes cloud delivery reads before provider access and never mutates a proposal', async () => {
    const s = await start({ delivery: true });
    const submitted = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    const path = `${url}/${submitted.body.id}/delivery`;
    await request(s.server)
      .get(path)
      .set('Authorization', header('stranger'))
      .expect(403);
    await request(s.server)
      .get(path)
      .set('Authorization', header('guest'))
      .expect(403);
    await request(s.server)
      .get(path)
      .set('Authorization', mockCredentials.service.header())
      .expect(403);
    expect(s.observe).not.toHaveBeenCalled();
    for (const viewer of ['developer', 'reviewer']) {
      const response = await request(s.server)
        .get(path)
        .set('Authorization', header(viewer))
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.deployed).toBe(false);
    }
    expect(s.observe).toHaveBeenCalledTimes(2);
    const after = await request(s.server)
      .get(`${url}/${submitted.body.id}`)
      .set('Authorization', header())
      .expect(200);
    expect(after.body).toEqual(submitted.body);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('persists first verified deployment evidence without making observation a deployment action', async () => {
    const s = await start({ delivery: true });
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    const history = '/api/agent-guard/rizz/verified-deployments';
    await request(s.server)
      .get(history)
      .set('Authorization', header('stranger'))
      .expect(403);
    await request(s.server)
      .get(history)
      .set('Authorization', header())
      .expect(200)
      .expect(response => expect(response.body.items).toEqual([]));
    await request(s.server)
      .post('/api/agent-guard/rizz/rollback/proposals')
      .set('Authorization', header())
      .send({
        operation: 'rollback',
        declaredIntent: 'Restore a previously verified Rizz.AI deployment.',
        targetId: 'eks-staging',
        verifiedDeploymentId: created.body.id,
      })
      .expect(409);
    await request(s.server)
      .post(`${url}/${created.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    const claim =
      s.scaffolder.scaffold.mock.calls[0][0].secrets!
        .AGENT_GUARD_CLOUD_EXECUTION_CLAIM;
    const body = {
      proposalId: created.body.id,
      taskId: 'cloud-task-only',
      claim,
    };
    await request(s.server)
      .post('/api/agent-guard/internal/rizz/publish/reserve')
      .set('Authorization', mockCredentials.service.header())
      .send(body)
      .expect(200);
    await request(s.server)
      .post('/api/agent-guard/internal/rizz/publish/complete')
      .set('Authorization', mockCredentials.service.header())
      .send({
        ...body,
        prUrl: 'https://github.com/example/gitops/pull/1',
        prNumber: 1,
      })
      .expect(204);
    const verifiedAt = '2026-09-28T10:00:00.000Z';
    s.observe.mockResolvedValue({
      checkedAt: verifiedAt,
      github: { state: 'merged_files_match', revision: 'c'.repeat(40) },
      argoCd: { state: 'synced_files_match', revision: 'd'.repeat(40) },
      workloads: { state: 'verified' },
      smoke: { state: 'verified' },
      deployed: true,
    });
    const before = (
      await request(s.server)
        .get(`${url}/${created.body.id}`)
        .set('Authorization', header())
        .expect(200)
    ).body;
    for (let index = 0; index < 2; index++)
      await request(s.server)
        .get(`${url}/${created.body.id}/delivery`)
        .set('Authorization', header())
        .expect(200);
    await request(s.server)
      .get(history)
      .set('Authorization', header('reviewer'))
      .expect(200)
      .expect(response => {
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0]).toMatchObject({
          proposalId: created.body.id,
          verifiedAt,
          snapshotDigest: created.body.snapshot.digest,
        });
        expect(response.body.items[0]).not.toHaveProperty('snapshot');
      });
    const after = (
      await request(s.server)
        .get(`${url}/${created.body.id}`)
        .set('Authorization', header())
        .expect(200)
    ).body;
    expect(after).toEqual(before);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
    const contents = Object.fromEntries(
      created.body.snapshot.files.map(
        (file: { path: string; content: string }) => [
          basename(file.path),
          file.content,
        ],
      ),
    );
    const backendDeployment = JSON.parse(contents['backend-deployment.yaml']);
    backendDeployment.spec.replicas = 1;
    backendDeployment.spec.template.spec.containers[0].image =
      backendDeployment.spec.template.spec.containers[0].image.replace(
        /.$/,
        'f',
      );
    contents['backend-deployment.yaml'] = `${canonicalize(
      backendDeployment,
    )}\n`;
    const live = () => ({
      base: {
        revision: 'e'.repeat(40),
        files: Object.entries(contents).map(([name, content]) => ({
          name,
          sha256: sha256(content),
        })),
      },
      currentState: inspectCloudGitopsFiles(contents, target),
      contents,
    });
    s.readGitops.mockImplementation(async () => live());
    const rollbackInput = {
      operation: 'rollback',
      declaredIntent:
        'Restore the previously verified Rizz.AI release in EKS staging.',
      targetId: 'eks-staging',
      verifiedDeploymentId: created.body.id,
    };
    const semanticCalls = s.fetcher.mock.calls.length;
    await request(s.server)
      .post('/api/agent-guard/rizz/rollback/preview')
      .set('Authorization', header())
      .send(rollbackInput)
      .expect(200)
      .expect(response =>
        expect(response.body).toMatchObject({
          state: 'preview',
          verifiedDeploymentId: created.body.id,
          before: { backendReplicas: 1 },
          after: { backendReplicas: 2 },
          changedFiles: [
            { path: expect.stringContaining('backend-deployment.yaml') },
          ],
        }),
      );
    expect(s.fetcher).toHaveBeenCalledTimes(semanticCalls);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
    const rollback = await request(s.server)
      .post('/api/agent-guard/rizz/rollback/proposals')
      .set('Authorization', header())
      .send(rollbackInput)
      .expect(201);
    expect(rollback.body).toMatchObject({
      status: 'pending_approval',
      snapshot: {
        envelope: {
          kind: 'rizz_cloud_rollback',
          rollbackSource: {
            verifiedDeploymentId: created.body.id,
            snapshotDigest: created.body.snapshot.digest,
          },
        },
      },
    });
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
    await request(s.server)
      .post(`${url}/${rollback.body.id}/decision`)
      .set('Authorization', header())
      .send({ decision: 'approve', digest: rollback.body.snapshot.digest })
      .expect(403);
    await request(s.server)
      .post(`${url}/${rollback.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: rollback.body.snapshot.digest })
      .expect(200);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(2);
    const rollbackClaim =
      s.scaffolder.scaffold.mock.calls[1][0].secrets!
        .AGENT_GUARD_CLOUD_EXECUTION_CLAIM;
    await request(s.server)
      .post('/api/agent-guard/internal/rizz/publish/reserve')
      .set('Authorization', mockCredentials.service.header())
      .send({
        proposalId: rollback.body.id,
        taskId: 'cloud-task-only',
        claim: rollbackClaim,
      })
      .expect(200)
      .expect(response =>
        expect(response.body).toMatchObject({
          operation: 'rizz_cloud_rollback',
          approvedDigest: rollback.body.snapshot.digest,
        }),
      );
    contents['ingress.yaml'] = '{}';
    await request(s.server)
      .post('/api/agent-guard/rizz/rollback/proposals')
      .set('Authorization', header())
      .send(rollbackInput)
      .expect(503);
  });
  it('returns explicit unconfigured observation without provider reads', async () => {
    const s = await start();
    const submitted = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    const response = await request(s.server)
      .get(`${url}/${submitted.body.id}/delivery`)
      .set('Authorization', header())
      .expect(200);
    expect(response.body.github.state).toBe('not_configured');
    expect(s.observe).not.toHaveBeenCalled();
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('is disabled by default, with no cloud MCP actions or accidental handoff', async () => {
    const s = await start({ disabled: true });
    await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(503);
    await request(s.server)
      .post('/api/agent-guard/rizz/runtime/preview')
      .set('Authorization', header())
      .send({
        operation: 'runtime_change',
        declaredIntent: 'Increase only backend replicas to two.',
        targetId: 'eks-staging',
        patch: { backendReplicas: 2 },
      })
      .expect(503);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    expect(s.verifyTarget).not.toHaveBeenCalled();
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header())
      .expect(200)
      .expect(response =>
        expect(response.body).toEqual({ state: 'disabled', canSubmit: false }),
      );
    expect(
      [...s.actions.actions.values()].map(action => action.name),
    ).not.toContain('submit-rizz-release-proposal');
  });
  it('exposes only configured capability, not verified readiness, without paid/provider reads', async () => {
    const s = await start();
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header())
      .expect(200)
      .expect(response =>
        expect(response.body).toMatchObject({
          state: 'configured',
          canSubmit: true,
          reviewPolicy: {
            reviewerGroups: [
              'group:default/rizz-team',
              'group:default/platform-team',
            ],
            memberOfReviewerGroup: true,
            distinctReviewerRequired: true,
          },
          target: { id: 'eks-staging', owner: target.owner },
        }),
      );
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header('reviewer'))
      .expect(200)
      .expect(response =>
        expect(response.body.reviewPolicy.memberOfReviewerGroup).toBe(true),
      );
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header('stranger'))
      .expect(200)
      .expect(response =>
        expect(response.body).toMatchObject({
          canSubmit: false,
          reviewPolicy: { memberOfReviewerGroup: false },
        }),
      );
    expect(s.verifyTarget).not.toHaveBeenCalled();
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('allows a distinct mapped application peer to review a new routine release', async () => {
    const s = await start();
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    expect(created.body.snapshot.envelope.reviewerGroups).toEqual([
      'group:default/rizz-team',
      'group:default/platform-team',
    ]);
    await request(s.server)
      .get(`${url}/${created.body.id}`)
      .set('Authorization', header('app_peer'))
      .expect(200)
      .expect(response =>
        expect(response.body.viewerPermissions.canReview).toBe(true),
      );
    await request(s.server)
      .post(`${url}/${created.body.id}/decision`)
      .set('Authorization', header('app_peer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
  });
  it('refuses new cloud actions when app catalog ownership is not rizz-team', async () => {
    const s = await start({ wrongAppOwner: true });
    await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(409);
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header())
      .expect(409);
    expect(s.verifyTarget).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('requires the exact governed catalog template before proposal evaluation', async () => {
    const s = await start({ missingTemplate: true });
    await request(s.server)
      .get('/api/agent-guard/rizz/capabilities')
      .set('Authorization', header())
      .expect(409);
    await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(409);
    expect(s.verifyTarget).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('requires mapped non-guest authorized users and rejects spoofed fields/three replicas before Jev', async () => {
    const s = await start();
    await request(s.server)
      .post(url)
      .set('Authorization', mockCredentials.none.header())
      .send(s.proposal)
      .expect(401);
    await request(s.server)
      .post(url)
      .set('Authorization', mockCredentials.service.header())
      .send(s.proposal)
      .expect(403);
    for (const name of ['guest', 'stranger', 'unmapped'])
      await request(s.server)
        .post(url)
        .set('Authorization', header(name))
        .send(s.proposal)
        .expect(403);
    for (const body of [
      { ...s.proposal, requester: 'user:default/reviewer' },
      { ...s.proposal, inputs: { ...s.proposal.inputs, backendReplicas: 3 } },
    ])
      await request(s.server)
        .post(url)
        .set('Authorization', header())
        .send(body)
        .expect(400);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('records REST provenance and scoped visibility without submitting paid/secret data to Jev', async () => {
    const s = await start();
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    expect(created.body.status).toBe('pending_approval');
    expect(created.body.snapshot.envelope.requester).toBe(
      'user:default/developer',
    );
    expect(created.body.snapshot.envelope.intentSource).toBe(
      'authenticated_user_submitted',
    );
    await request(s.server)
      .get(`${url}/${created.body.id}`)
      .set('Authorization', header('stranger'))
      .expect(403);
    const list = await request(s.server)
      .get(url)
      .set('Authorization', header('stranger'))
      .expect(200);
    expect(list.body.items).toEqual([]);
    const state = JSON.parse(s.fetcher.mock.calls[0][1].body).state;
    expect(state.proposedConfiguration.backendExposure).toContain('ClusterIP');
    expect(JSON.stringify(state)).not.toContain(target.ingress.certificateArn);
    expect(JSON.stringify(state)).not.toContain(target.ingress.operatorCidr);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('uses the same service for MCP and records agent-supplied intent without exposing approval tools', async () => {
    const s = await start();
    const result = await s.actions.invoke({
      id: 'test:submit-rizz-release-proposal',
      input: s.proposal,
      credentials: mockCredentials.user('user:default/developer'),
    });
    const id = (result.output as { id: string }).id;
    const fetched = await request(s.server)
      .get(`${url}/${id}`)
      .set('Authorization', header())
      .expect(200);
    expect(fetched.body.snapshot.envelope).toMatchObject({
      requester: 'user:default/developer',
      submissionChannel: 'mcp_action',
      intentSource: 'agent_supplied',
    });
    const names = [...s.actions.actions.values()].map(action => action.name);
    expect(names.filter(name => name.includes('rizz'))).toEqual([
      'submit-rizz-rollback-proposal',
      'submit-rizz-runtime-change-proposal',
      'submit-rizz-release-proposal',
      'get-rizz-release-proposal-status',
      'get-rizz-runtime-change-proposal-status',
    ]);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('re-resolves release evidence at approval rather than trusting the preview', async () => {
    const s = await start();
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    s.resolve.mockResolvedValue([]);
    await request(s.server)
      .post(`${url}/${created.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(409);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it.each([{ mismatch: true }, { unavailable: true }])(
    'holds mismatched or unavailable semantic evidence: %p',
    async flags => {
      const s = await start(flags);
      const created = await request(s.server)
        .post(url)
        .set('Authorization', header())
        .send(s.proposal)
        .expect(201);
      expect(created.body.status).toBe('needs_clarification');
      await request(s.server)
        .post(`${url}/${created.body.id}/decision`)
        .set('Authorization', header('reviewer'))
        .send({ decision: 'approve', digest: created.body.snapshot.digest })
        .expect(403);
      expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    },
  );
  it('rejects self-review, wrong digests and target/base failure before dispatch', async () => {
    const s = await start();
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header('reviewer'))
      .send(s.proposal)
      .expect(201);
    const decision = `${url}/${created.body.id}/decision`;
    await request(s.server)
      .post(decision)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(403);
    const second = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    await request(s.server)
      .post(`${url}/${second.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: sha256('wrong') })
      .expect(409);
    s.base.revision = 'c'.repeat(40);
    await request(s.server)
      .post(`${url}/${second.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: second.body.snapshot.digest })
      .expect(409);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('fails closed on reader outage without storing a proposal or calling Jev', async () => {
    const s = await start();
    s.verifyTarget.mockRejectedValueOnce(
      new Error('private AWS credential details'),
    );
    const response = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('private AWS');
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(
      (
        await request(s.server)
          .get(url)
          .set('Authorization', header())
          .expect(200)
      ).body.items,
    ).toEqual([]);
  });
  it('dispatches only one approved private task; gates frozen publishing by service, claim and task', async () => {
    const s = await start();
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    const approve = () =>
      request(s.server)
        .post(`${url}/${created.body.id}/decision`)
        .set('Authorization', header('reviewer'))
        .send({ decision: 'approve', digest: created.body.snapshot.digest });
    const decisions = await Promise.all([approve(), approve()]);
    expect(decisions.filter(r => r.status === 200)).toHaveLength(1);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
    const dispatch = s.scaffolder.scaffold.mock.calls[0][0];
    expect(dispatch.templateRef).toBe('template:default/deploy-rizz-ai');
    expect(dispatch.values).toEqual({});
    const claim = dispatch.secrets!.AGENT_GUARD_CLOUD_EXECUTION_CLAIM;
    const reserve = '/api/agent-guard/internal/rizz/publish/reserve';
    const body = {
      proposalId: created.body.id,
      taskId: 'cloud-task-only',
      claim,
    };
    await request(s.server)
      .post(reserve)
      .set('Authorization', header('reviewer'))
      .send(body)
      .expect(403);
    await request(s.server)
      .post(reserve)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...body, claim: 'x'.repeat(43) })
      .expect(403);
    await request(s.server)
      .post(reserve)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...body, taskId: 'wrong' })
      .expect(403);
    const reservations = await Promise.all(
      [1, 2].map(() =>
        request(s.server)
          .post(reserve)
          .set('Authorization', mockCredentials.service.header())
          .send(body),
      ),
    );
    // The first reservation consumes the state once. A later same-task request
    // may recover that exact plan; concurrent pre-consumption CAS may conflict.
    expect(
      reservations.filter(r => r.status === 200).length,
    ).toBeGreaterThanOrEqual(1);
    expect(reservations.every(r => [200, 409].includes(r.status))).toBe(true);
    for (const successful of reservations.filter(r => r.status === 200))
      expect(successful.body).toEqual(
        reservations.find(r => r.status === 200)!.body,
      );
    expect(reservations.find(r => r.status === 200)!.body.files).toHaveLength(
      9,
    );
    const recovery = await request(s.server)
      .post(reserve)
      .set('Authorization', mockCredentials.service.header())
      .send(body)
      .expect(200);
    expect(recovery.body).toEqual(
      reservations.find(r => r.status === 200)!.body,
    );
    const complete = '/api/agent-guard/internal/rizz/publish/complete';
    await request(s.server)
      .post(complete)
      .set('Authorization', mockCredentials.service.header())
      .send({
        ...body,
        prUrl: 'https://github.com/attacker/other/pull/1',
        prNumber: 1,
      })
      .expect(409);
    await request(s.server)
      .post(complete)
      .set('Authorization', mockCredentials.service.header())
      .send({
        ...body,
        prUrl: 'https://github.com/example/gitops/pull/1',
        prNumber: 1,
      })
      .expect(204);
    const status = await request(s.server)
      .get(`${url}/${created.body.id}`)
      .set('Authorization', header())
      .expect(200);
    expect(status.body.status).toBe('pr_open');
    expect(
      status.body.audit.filter(
        (event: { event: string }) => event.event === 'execution_publishing',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(status.body)).not.toContain(claim);
    expect(status.body.execution.claimHash).toBeUndefined();
  });
  it('records ambiguous dispatch failure and never silently retries the task', async () => {
    const s = await start({ dispatchFailure: true });
    const created = await request(s.server)
      .post(url)
      .set('Authorization', header())
      .send(s.proposal)
      .expect(201);
    const result = await request(s.server)
      .post(`${url}/${created.body.id}/decision`)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    expect(result.body.status).toBe('execution_failed');
    expect(JSON.stringify(result.body)).not.toContain('private-provider-error');
    await request(s.server)
      .get(`${url}/${created.body.id}`)
      .set('Authorization', header())
      .expect(200);
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
  });
  it('submits only an authenticated bounded runtime patch and holds no-op or mismatch', async () => {
    const s = await start();
    seedRuntimeBaseline(s.readGitops);
    for (const body of [
      { ...runtimeInput, patch: { backendReplicas: 3 } },
      { ...runtimeInput, patch: { backendReplicas: 2, pathPrefix: '/admin' } },
      { ...runtimeInput, requester: 'user:default/reviewer' },
    ])
      await request(s.server)
        .post(runtimeUrl)
        .set('Authorization', header())
        .send(body)
        .expect(400);
    await request(s.server)
      .post(runtimeUrl)
      .set('Authorization', header('stranger'))
      .send(runtimeInput)
      .expect(403);
    expect(s.fetcher).not.toHaveBeenCalled();
    await request(s.server)
      .post(runtimeUrl)
      .set('Authorization', header())
      .send({ ...runtimeInput, patch: { backendReplicas: 1 } })
      .expect(409);
    expect(s.fetcher).not.toHaveBeenCalled();
    const created = await request(s.server)
      .post(runtimeUrl)
      .set('Authorization', header())
      .send(runtimeInput)
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'pending_approval',
      requester: 'user:default/developer',
      snapshot: {
        envelope: {
          schemaVersion: 2,
          kind: 'rizz_cloud_runtime_change',
          submissionChannel: 'backstage_rest',
          intentSource: 'authenticated_user_submitted',
          before: { frontendReplicas: 1, backendReplicas: 1 },
          after: { frontendReplicas: 1, backendReplicas: 2 },
          changedFields: ['backendReplicas'],
        },
      },
    });
    expect(created.body.snapshot.files).toHaveLength(9);
    expect(created.body.snapshot.baselineFiles).toHaveLength(9);
    const state = JSON.parse(s.fetcher.mock.calls[0][1].body).state;
    expect(state.operation).toBe('runtime_change');
    expect(state.changedFields).toEqual(['backendReplicas']);
    expect(JSON.stringify(state)).not.toContain(target.ingress.operatorCidr);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('exposes runtime submission to MCP without any approval or direct Scaffolder tool', async () => {
    const s = await start();
    seedRuntimeBaseline(s.readGitops);
    const result = await s.actions.invoke({
      id: 'test:submit-rizz-runtime-change-proposal',
      input: runtimeInput,
      credentials: mockCredentials.user('user:default/developer'),
    });
    const id = (result.output as { id: string }).id;
    const fetched = await request(s.server)
      .get(`${url}/${id}`)
      .set('Authorization', header())
      .expect(200);
    expect(fetched.body.snapshot.envelope).toMatchObject({
      kind: 'rizz_cloud_runtime_change',
      submissionChannel: 'mcp_action',
      intentSource: 'agent_supplied',
    });
    const status = await s.actions.invoke({
      id: 'test:get-rizz-runtime-change-proposal-status',
      input: { id },
      credentials: mockCredentials.user('user:default/developer'),
    });
    expect(status.output).toMatchObject({ id, status: 'pending_approval' });
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
  });
  it('requires exact digest, distinct reviewer, unchanged base and freezes approved runtime bytes', async () => {
    const s = await start();
    const baseline = seedRuntimeBaseline(s.readGitops);
    const created = await request(s.server)
      .post(runtimeUrl)
      .set('Authorization', header())
      .send(runtimeInput)
      .expect(201);
    const decision = `${url}/${created.body.id}/decision`;
    await request(s.server)
      .post(decision)
      .set('Authorization', header())
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(403);
    await request(s.server)
      .post(decision)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: sha256('wrong') })
      .expect(409);
    s.readGitops.mockResolvedValueOnce({
      base: { ...baseline.base, revision: 'c'.repeat(40) },
      currentState: inspectCloudGitopsFiles(baseline.contents, target),
      contents: baseline.contents,
    });
    await request(s.server)
      .post(decision)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(409);
    expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    const approved = await request(s.server)
      .post(decision)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    expect(approved.body.status).toBe('scaffolding');
    expect(s.scaffolder.scaffold).toHaveBeenCalledTimes(1);
    const dispatch = s.scaffolder.scaffold.mock.calls[0][0];
    expect(dispatch.values).toEqual({});
    const reserve = await request(s.server)
      .post('/api/agent-guard/internal/rizz/publish/reserve')
      .set('Authorization', mockCredentials.service.header())
      .send({
        proposalId: created.body.id,
        taskId: 'cloud-task-only',
        claim: dispatch.secrets!.AGENT_GUARD_CLOUD_EXECUTION_CLAIM,
      })
      .expect(200);
    expect(reserve.body.files).toEqual(created.body.snapshot.files);
    expect(reserve.body.operation).toBe('rizz_cloud_runtime_change');
    expect(reserve.body.approvedDigest).toBe(created.body.snapshot.digest);
    expect(reserve.body.baseRevision).toBe(baseline.base.revision);
  });
  it.each([{ mismatch: true }, { unavailable: true }])(
    'holds runtime semantic result when Jev is unsafe or unavailable: %p',
    async flags => {
      const s = await start(flags);
      seedRuntimeBaseline(s.readGitops);
      const created = await request(s.server)
        .post(runtimeUrl)
        .set('Authorization', header())
        .send(runtimeInput)
        .expect(201);
      expect(created.body.status).toBe('needs_clarification');
      await request(s.server)
        .post(`${url}/${created.body.id}/decision`)
        .set('Authorization', header('reviewer'))
        .send({ decision: 'approve', digest: created.body.snapshot.digest })
        .expect(403);
      expect(s.scaffolder.scaffold).not.toHaveBeenCalled();
    },
  );
});
