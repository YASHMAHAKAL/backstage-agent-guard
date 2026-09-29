import { createHmac } from 'node:crypto';
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
import request from 'supertest';
import { createAgentGuardPlugin } from './plugin';
import { canonicalize } from './snapshot';
import { terraformBindingDigest } from './terraformPlan';

const runnerKey = Buffer.alloc(32, 7);
const approvalKey = Buffer.alloc(32, 8);
const memberOf: Record<string, string[]> = {
  requester: ['group:default/platform-team'],
  reviewer: ['group:default/platform-team'],
  outsider: ['group:default/rizz-team'],
  guest: ['group:default/platform-team'],
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
          ownershipEntityRefs: [ref, ...(memberOf[ref.split('/')[1]] ?? [])],
        };
      },
    };
  },
});
const header = (name: string) =>
  mockCredentials.user.header(`user:default/${name}`);
const proof = (value: unknown) =>
  `sha256:${createHmac('sha256', runnerKey)
    .update(canonicalize(value))
    .digest('hex')}`;

let backend: Awaited<ReturnType<typeof startTestBackend>> | undefined;
const initialAuthMode = process.env.AGENT_GUARD_AUTH_MODE;
afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  if (initialAuthMode === undefined) delete process.env.AGENT_GUARD_AUTH_MODE;
  else process.env.AGENT_GUARD_AUTH_MODE = initialAuthMode;
});

async function start(withCapacityPublisher = false) {
  process.env.AGENT_GUARD_AUTH_MODE = 'github';
  const configurationReader = {
    verifyMergedReview: jest.fn().mockResolvedValue(true),
  };
  const capacityPublisher = {
    readBaseline: jest.fn().mockResolvedValue({
      mainSha: 'b'.repeat(40),
      fileSha: 'c'.repeat(40),
      workers: 1,
    }),
    publish: jest.fn().mockResolvedValue({
      url: 'https://github.com/example/backstage-agent-guard/pull/19',
      headCommit: 'd'.repeat(40),
      baseCommit: 'b'.repeat(40),
    }),
  };
  backend = await startTestBackend({
    features: [
      userInfo,
      mockServices.rootConfig.factory({
        data: { auth: { environment: 'github' } },
      }),
      createServiceFactory({
        service: actionsRegistryServiceRef,
        deps: {},
        async factory() {
          return actionsRegistryServiceMock();
        },
      }),
      catalogServiceMock.factory({
        entities: [
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
          ...Object.entries(memberOf).map(([name, groups]) => ({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: { name },
            spec: { memberOf: groups.map(g => g.split('/')[1]) },
            relations: groups.map(group => ({
              type: 'memberOf',
              targetRef: group,
            })),
          })),
        ],
      }),
      createAgentGuardPlugin({
        terraform: {
          runnerKey,
          approvalKey,
          expectedAccountId: '000000000000',
          expectedRunnerId: 'terraform-runner-staging',
          configurationReader,
          ...(withCapacityPublisher ? { capacityPublisher } : {}),
        },
      }),
    ],
  });
  return { ...backend, configurationReader, capacityPublisher };
}

const base = '/api/agent-guard/rizz/terraform';
async function foundationRequest(
  server: Awaited<ReturnType<typeof start>>['server'],
) {
  return request(server)
    .post(`${base}/requests`)
    .set('Authorization', header('requester'))
    .send({
      operation: 'foundation_setup',
      root: 'staging',
      declaredIntent: 'Set up the reviewed Rizz.AI staging EKS foundation.',
    });
}

function planMessage(id: string) {
  const binding = {
    schemaVersion: 1,
    policyVersion: 'rizz-terraform-v1',
    requestId: id,
    operation: 'foundation_setup',
    root: 'staging',
    target: 'rizz-ai-eks-staging',
    accountId: '000000000000',
    region: 'us-east-1',
    requester: 'user:default/requester',
    sourceCommit: 'a'.repeat(40),
    providerLockDigest: `sha256:${'1'.repeat(64)}`,
    configDigest: `sha256:${'2'.repeat(64)}`,
    variablesDigest: `sha256:${'3'.repeat(64)}`,
    backendDigest: `sha256:${'4'.repeat(64)}`,
    planDigest: `sha256:${'5'.repeat(64)}`,
    stateLineage: '38a13b16-df15-41bb-8db7-6174d5e2b77f',
    stateSerial: 3,
    terraformVersion: '1.15.8',
    runnerId: 'terraform-runner-staging',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  } as const;
  const summary = {
    terraformVersion: '1.15.8',
    counts: { create: 1, update: 0, delete: 0, replace: 0, read: 0 },
    changes: [
      { address: 'aws_vpc.staging', type: 'aws_vpc', action: 'create' },
    ],
  };
  return {
    requestId: id,
    binding,
    summary,
    configurationPr: {
      url: 'https://github.com/example/backstage-agent-guard/pull/12',
      mergedCommit: 'a'.repeat(40),
    },
  };
}

describe('platform Terraform request and plan review gate', () => {
  it('publishes only an authenticated bounded capacity PR and binds the saved plan to it', async () => {
    const { server, capacityPublisher, configurationReader } = await start(
      true,
    );
    await request(server)
      .post(`${base}/requests`)
      .set('Authorization', header('requester'))
      .send({
        operation: 'capacity_change',
        root: 'staging',
        desiredWorkers: 1,
        declaredIntent: 'Keep only one Rizz.AI staging worker running.',
      })
      .expect(400);
    const submitted = await request(server)
      .post(`${base}/requests`)
      .set('Authorization', header('requester'))
      .send({
        operation: 'capacity_change',
        root: 'staging',
        desiredWorkers: 2,
        declaredIntent:
          'Increase only the Rizz.AI staging worker count to two.',
      })
      .expect(201);
    expect(submitted.body.capacityBaseline.workers).toBe(1);
    const publishPath = `${base}/requests/${submitted.body.id}/configuration-pr`;
    await request(server)
      .post(publishPath)
      .set('Authorization', header('reviewer'))
      .expect(403);
    const published = await request(server)
      .post(publishPath)
      .set('Authorization', header('requester'))
      .expect(200);
    expect(published.body.status).toBe('configuration_pr_open');
    expect(published.body.configurationPrDraft.url).toContain('/pull/19');
    await request(server)
      .post(publishPath)
      .set('Authorization', header('requester'))
      .expect(200);
    expect(capacityPublisher.publish).toHaveBeenCalledTimes(1);
    const lookup = { requestId: submitted.body.id };
    const pending = await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/request')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...lookup, proof: proof(lookup) })
      .expect(200);
    expect(pending.body).toMatchObject({
      desiredWorkers: 2,
      previousWorkers: 1,
      configurationPrUrl: published.body.configurationPrDraft.url,
      configurationPrHeadCommit: 'd'.repeat(40),
    });
    const baseMessage = planMessage(submitted.body.id);
    const message = {
      ...baseMessage,
      binding: { ...baseMessage.binding, operation: 'capacity_change' },
      summary: {
        terraformVersion: '1.15.8',
        counts: { create: 0, update: 1, delete: 0, replace: 0, read: 0 },
        changes: [
          {
            address: 'aws_eks_node_group.staging',
            type: 'aws_eks_node_group',
            action: 'update',
            workerDesiredSize: { before: 1, after: 2 },
          },
        ],
      },
      configurationPr: {
        url: published.body.configurationPrDraft.url,
        mergedCommit: 'a'.repeat(40),
      },
    };
    const plansPath = '/api/agent-guard/internal/rizz/terraform/plans';
    const wrong = {
      ...message,
      summary: {
        ...message.summary,
        changes: [
          {
            ...message.summary.changes[0],
            workerDesiredSize: { before: 1, after: 1 },
          },
        ],
      },
    };
    await request(server)
      .post(plansPath)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...wrong, proof: proof(wrong) })
      .expect(409);
    const swappedPr = {
      ...message,
      configurationPr: {
        ...message.configurationPr,
        url: 'https://github.com/example/backstage-agent-guard/pull/20',
      },
    };
    await request(server)
      .post(plansPath)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...swappedPr, proof: proof(swappedPr) })
      .expect(409);
    await request(server)
      .post(plansPath)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) })
      .expect(201);
    expect(configurationReader.verifyMergedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        capacityDesiredWorkers: 2,
        capacityPrHeadCommit: 'd'.repeat(40),
      }),
    );
  });
  it('exposes a pending request only to the authenticated, proof-bearing runner', async () => {
    const { server } = await start();
    const submitted = await foundationRequest(server);
    expect(submitted.status).toBe(201);
    const message = { requestId: submitted.body.id };
    const endpoint = '/api/agent-guard/internal/rizz/terraform/request';
    await request(server)
      .post(endpoint)
      .set('Authorization', header('requester'))
      .send({ ...message, proof: proof(message) })
      .expect(403);
    await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: `sha256:${'0'.repeat(64)}` })
      .expect(403);
    const response = await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) })
      .expect(200);
    expect(response.body).toEqual({
      id: submitted.body.id,
      requester: 'user:default/requester',
      operation: 'foundation_setup',
      root: 'staging',
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('receipt');
  });

  it('denies outsider, guest, and service submission before recording anything', async () => {
    const { server } = await start();
    await request(server)
      .post(`${base}/requests`)
      .set('Authorization', header('requester'))
      .send({
        operation: 'capacity_change',
        root: 'staging',
        desiredWorkers: 2,
        declaredIntent: 'Increase only the Rizz.AI staging worker count.',
      })
      .expect(503);
    for (const identity of ['outsider', 'guest']) {
      const response = await request(server)
        .post(`${base}/requests`)
        .set('Authorization', header(identity))
        .send({
          operation: 'foundation_setup',
          root: 'staging',
          declaredIntent: 'Set up the Rizz.AI staging EKS foundation.',
        });
      expect(response.status).toBe(403);
    }
    const service = await request(server)
      .post(`${base}/requests`)
      .set('Authorization', mockCredentials.service.header())
      .send({});
    expect(service.status).not.toBe(201);
    await request(server)
      .post(`${base}/requests`)
      .set('Authorization', header('requester'))
      .send({
        operation: 'capacity_change',
        root: 'staging',
        desiredWorkers: 3,
        declaredIntent:
          'Scale the staging node group beyond the reviewed limit.',
      })
      .expect(400);
    await request(server)
      .post(`${base}/requests`)
      .set('Authorization', header('requester'))
      .send({
        operation: 'foundation_setup',
        root: 'staging',
        moduleUrl: 'https://example.com/unreviewed-module',
        declaredIntent: 'Set up the reviewed staging foundation.',
      })
      .expect(400);
    const list = await request(server)
      .get(`${base}/requests`)
      .set('Authorization', header('reviewer'));
    expect(list.body.items).toHaveLength(0);
  });

  it('requires a service principal, runner proof and reviewed merged PR for a plan', async () => {
    const { server, configurationReader } = await start();
    const submitted = await foundationRequest(server);
    expect(submitted.status).toBe(201);
    const message = planMessage(submitted.body.id);
    const endpoint = '/api/agent-guard/internal/rizz/terraform/plans';
    const userCall = await request(server)
      .post(endpoint)
      .set('Authorization', header('requester'))
      .send({ ...message, proof: proof(message) });
    expect(userCall.status).not.toBe(201);
    const falseProof = await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: `sha256:${'0'.repeat(64)}` });
    expect(falseProof.status).toBe(403);
    const wrongTarget = {
      ...message,
      binding: { ...message.binding, accountId: '999999999999' },
    };
    await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...wrongTarget, proof: proof(wrongTarget) })
      .expect(409);
    configurationReader.verifyMergedReview.mockResolvedValueOnce(false);
    const unreviewed = await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) });
    expect(unreviewed.status).toBe(409);
    const registered = await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) });
    expect(registered.status).toBe(201);
    const replay = await request(server)
      .post(endpoint)
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) });
    expect(replay.status).toBe(409);
  });

  it('binds a distinct platform decision to the exact plan digest and hides the receipt', async () => {
    const { server, configurationReader } = await start();
    const submitted = await foundationRequest(server);
    const message = planMessage(submitted.body.id);
    await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/plans')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...message, proof: proof(message) })
      .expect(201);
    const endpoint = `${base}/requests/${submitted.body.id}/decision`;
    const digest = terraformBindingDigest(message.binding);
    await request(server)
      .post(endpoint)
      .set('Authorization', header('requester'))
      .send({ decision: 'approve', bindingDigest: digest })
      .expect(403);
    await request(server)
      .post(endpoint)
      .set('Authorization', header('outsider'))
      .send({ decision: 'approve', bindingDigest: digest })
      .expect(403);
    await request(server)
      .post(endpoint)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', bindingDigest: `sha256:${'0'.repeat(64)}` })
      .expect(409);
    configurationReader.verifyMergedReview.mockResolvedValueOnce(false);
    await request(server)
      .post(endpoint)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', bindingDigest: digest })
      .expect(409);
    const approved = await request(server)
      .post(endpoint)
      .set('Authorization', header('reviewer'))
      .send({ decision: 'approve', bindingDigest: digest })
      .expect(200);
    expect(approved.body.status).toBe('plan_approved');
    expect(approved.body.receipt).toBeUndefined();
    expect(approved.body.executable).toBe(false);
    const receiptMessage = { requestId: submitted.body.id };
    const receipt = await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/receipt')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...receiptMessage, proof: proof(receiptMessage) })
      .expect(200);
    expect(receipt.body.approval.bindingDigest).toBe(digest);
    expect(receipt.body.signature).toMatch(/^sha256:[a-f0-9]{64}$/);
    const outcome = {
      requestId: submitted.body.id,
      bindingDigest: digest,
      runId: 'a4375fa5-95df-4bf0-aea5-39ac562ee856',
      status: 'applied',
    };
    await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/outcome')
      .set('Authorization', header('requester'))
      .send({ ...outcome, proof: proof(outcome) })
      .expect(403);
    await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/outcome')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...outcome, proof: `sha256:${'0'.repeat(64)}` })
      .expect(403);
    const reported = await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/outcome')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...outcome, proof: proof(outcome) })
      .expect(200);
    expect(reported.body.status).toBe('runner_reported_applied');
    const retry = await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/outcome')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...outcome, proof: proof(outcome) })
      .expect(200);
    expect(retry.body.status).toBe('runner_reported_applied');
    await request(server)
      .post('/api/agent-guard/internal/rizz/terraform/receipt')
      .set('Authorization', mockCredentials.service.header())
      .send({ ...receiptMessage, proof: proof(receiptMessage) })
      .expect(409);
  });
});
