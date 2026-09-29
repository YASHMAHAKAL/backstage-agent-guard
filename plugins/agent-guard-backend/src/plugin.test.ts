import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { actionsRegistryServiceMock } from '@backstage/backend-test-utils/alpha';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { scaffolderServiceMock } from '@backstage/plugin-scaffolder-node/testUtils';
import request from 'supertest';
import { DeliveryStatusObserver } from './deliveryStatus';
import { JevClient } from './jev';
import { agentGuardPlugin, createAgentGuardPlugin } from './plugin';

const proposal = {
  declaredIntent: 'Create a staging Node.js payments API',
  templateId: 'nodejs-api',
  inputs: {
    serviceName: 'payments-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging',
    description: 'Internal payments API',
  },
};

let activeBackend: Awaited<ReturnType<typeof startTestBackend>> | undefined;
const originalAuthMode = process.env.AGENT_GUARD_AUTH_MODE;

const ownershipByUser: Record<string, string[]> = {
  'user:default/requester': ['group:default/requester-team'],
  'user:default/owner-reviewer': ['group:default/payments-team'],
  'user:default/same-team-requester': ['group:default/payments-team'],
  'user:default/guest': ['group:default/payments-team'],
};

const userInfoFactory = createServiceFactory({
  service: coreServices.userInfo,
  deps: {},
  async factory() {
    return {
      async getUserInfo(credentials) {
        const principal = credentials.principal as {
          type?: string;
          userEntityRef?: string;
        };
        if (principal.type !== 'user' || !principal.userEntityRef) {
          throw new Error('Expected user credentials');
        }
        const userEntityRef = principal.userEntityRef;
        return {
          userEntityRef,
          ownershipEntityRefs: [
            userEntityRef,
            ...(ownershipByUser[userEntityRef] ?? []),
          ],
        };
      },
    };
  },
});

function alignedJev(): JevClient {
  const fetcher = jest.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'jev-test',
        answers: {
          alignment: {
            type: 'choice',
            choice: 'aligned',
            probabilities: { aligned: 0.95, insufficient_context: 0.05 },
            confidence: 0.9,
          },
          preservesIntent: { type: 'noul', noul: 0.95 },
          mismatchSeverity: {
            type: 'score',
            score: 0.1,
            probabilities: { '0': 0.9, '1': 0.1 },
            legend: { '0': 'No material mismatch', '1': 'Minor ambiguity' },
            confidence: 0.9,
          },
        },
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
  return new JevClient('test-only', fetcher);
}

async function start(
  options: {
    jev?: JevClient;
    authMode?: 'guest-demo' | 'github';
    scaffoldError?: Error;
    gitopsRepoUrl?: string;
    deliveryObserver?: DeliveryStatusObserver;
  } = {},
) {
  if (options.authMode) {
    process.env.AGENT_GUARD_AUTH_MODE = options.authMode;
  }
  const scaffolder = scaffolderServiceMock.mock({
    scaffold: options.scaffoldError
      ? jest.fn().mockRejectedValue(options.scaffoldError)
      : jest.fn().mockResolvedValue({ taskId: 'task-test-123' }),
    getTask: jest.fn().mockResolvedValue({
      id: 'task-test-123',
      status: 'processing',
    }),
  });
  const actionsRegistry = actionsRegistryServiceMock();
  activeBackend = await startTestBackend({
    features: [
      scaffolder.factory,
      createServiceFactory({
        service: actionsRegistryServiceRef,
        deps: {},
        async factory() {
          return actionsRegistry;
        },
      }),
      ...(options.authMode
        ? [
            mockServices.rootConfig.factory({
              data: { auth: { environment: options.authMode } },
            }),
          ]
        : []),
      userInfoFactory,
      options.jev || options.gitopsRepoUrl || options.deliveryObserver
        ? createAgentGuardPlugin({
            jev: options.jev,
            gitopsRepoUrl: options.gitopsRepoUrl,
            deliveryObserver: options.deliveryObserver,
          })
        : agentGuardPlugin,
      catalogServiceMock.factory({
        entities: [
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'payments-team', namespace: 'default' },
            spec: { type: 'team', children: [] },
          },
        ],
      }),
    ],
  });
  return { ...activeBackend, scaffolder, actionsRegistry };
}

describe('Agent Guard backend', () => {
  it('authenticates read-only release browsing and does not invent releases', async () => {
    const { server, scaffolder } = await start();
    const url = '/api/agent-guard/rizz/releases';
    await request(server)
      .get(url)
      .set('Authorization', mockCredentials.none.header())
      .expect(401);
    await request(server)
      .get(url)
      .set('Authorization', mockCredentials.service.header())
      .expect(403);
    const response = await request(server)
      .get(url)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      state: 'not_configured',
      reason: 'trusted_publisher_not_connected',
      items: [],
    });
    await request(server)
      .post(url)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send({ release: 'fake' })
      .expect(404);
    expect(scaffolder.scaffold).not.toHaveBeenCalled();
  });
  afterEach(async () => {
    await activeBackend?.stop();
    activeBackend = undefined;
    if (originalAuthMode === undefined) {
      delete process.env.AGENT_GUARD_AUTH_MODE;
    } else {
      process.env.AGENT_GUARD_AUTH_MODE = originalAuthMode;
    }
  });
  it('scopes read-only delivery observation to proposal viewers', async () => {
    const observe = jest.fn().mockResolvedValue({
      checkedAt: '2026-09-24T11:10:00Z',
      github: { state: 'not_published' },
      argoCd: { state: 'not_checked' },
      deployed: false,
    });
    const { server } = await start({
      jev: alignedJev(),
      deliveryObserver: { observe } as unknown as DeliveryStatusObserver,
    });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    const url = `/api/agent-guard/proposals/${created.body.id}/delivery`;
    await request(server).get(url).expect(403);
    await request(server)
      .get(url)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/stranger'),
      )
      .expect(403);
    expect(observe).not.toHaveBeenCalled();
    const visible = await request(server)
      .get(url)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .expect(200);
    expect(visible.body).toMatchObject({
      github: { state: 'not_published' },
      deployed: false,
    });
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it('stores a valid proposal but never treats missing Jev as approval', async () => {
    const { server } = await start();
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .send(proposal)
      .expect(201);
    expect(created.body).toMatchObject({
      intentSource: 'authenticated_user_submitted',
      submissionChannel: 'backstage_rest',
      status: 'needs_clarification',
      reasonCodes: ['semantic_check_unavailable'],
    });
    expect(created.body.snapshot.envelope).toMatchObject({
      schemaVersion: 2,
      intentSource: 'authenticated_user_submitted',
      submissionChannel: 'backstage_rest',
    });
    expect(created.body.auditTrail[0]).toMatchObject({
      type: 'submitted',
      submissionChannel: 'backstage_rest',
      digest: created.body.snapshot.digest,
    });
    expect(created.body.id).toEqual(expect.any(String));
    await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .expect(200);
  });

  it('rejects agent-controlled provenance and unsupported production', async () => {
    const { server } = await start();
    const invalidProvenance = await request(server)
      .post('/api/agent-guard/proposals')
      .send({ ...proposal, intentSource: 'user_confirmed' })
      .expect(400);
    await request(server)
      .post('/api/agent-guard/proposals')
      .send({ ...proposal, submissionChannel: 'mcp_action' })
      .expect(400);
    const unsupportedEnvironment = await request(server)
      .post('/api/agent-guard/proposals')
      .send({
        ...proposal,
        inputs: { ...proposal.inputs, environment: 'production' },
      })
      .expect(400);
    expect(invalidProvenance.status).toBe(400);
    expect(unsupportedEnvironment.status).toBe(400);
  });

  it('records MCP action provenance from the trusted action entry point', async () => {
    const { server, actionsRegistry } = await start({ jev: alignedJev() });
    const credentials = mockCredentials.user('user:default/requester');
    const action = await actionsRegistry.invoke({
      id: 'test:submit-proposal',
      input: proposal,
      credentials,
    });
    const id = (action.output as { id: string }).id;
    const fetched = await request(server)
      .get(`/api/agent-guard/proposals/${id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .expect(200);

    expect(fetched.body).toMatchObject({
      requester: 'user:default/requester',
      intentSource: 'agent_supplied',
      submissionChannel: 'mcp_action',
      snapshot: {
        envelope: { schemaVersion: 2, submissionChannel: 'mcp_action' },
      },
      auditTrail: [{ type: 'submitted', submissionChannel: 'mcp_action' }],
    });
    await expect(
      actionsRegistry.invoke({
        id: 'test:submit-proposal',
        input: { ...proposal, submissionChannel: 'backstage_rest' },
        credentials,
      }),
    ).rejects.toThrow();
  });

  it('rejects a service principal and an unknown owner', async () => {
    const { server } = await start();
    const servicePrincipal = await request(server)
      .post('/api/agent-guard/proposals')
      .set('Authorization', mockCredentials.service.header())
      .send(proposal)
      .expect(403);
    const unknownOwner = await request(server)
      .post('/api/agent-guard/proposals')
      .send({
        ...proposal,
        inputs: { ...proposal.inputs, requestedOwner: 'group:default/unknown' },
      })
      .expect(400);
    expect(servicePrincipal.status).toBe(403);
    expect(unknownOwner.status).toBe(400);
  });

  it('does not reveal a proposal to a different user', async () => {
    const { server } = await start();
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .send(proposal)
      .expect(201);
    const forbidden = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set('Authorization', mockCredentials.user.header('user:default/other'))
      .expect(403);
    const list = await request(server)
      .get('/api/agent-guard/proposals')
      .set('Authorization', mockCredentials.user.header('user:default/other'))
      .expect(200, { items: [] });
    expect(forbidden.status).toBe(403);
    expect(list.body).toEqual({ items: [] });
  });

  it('freezes exact output and permits only the owner reviewer to approve it', async () => {
    const { server, scaffolder } = await start({ jev: alignedJev() });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'pending_approval',
      reviewLane: 'owner_review',
      viewerPermissions: { canReview: false },
    });
    expect(created.body.snapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Node.js uses the inline command recipe; unlike FastAPI it has no ConfigMap.
    expect(
      created.body.snapshot.files.map((file: { path: string }) => file.path),
    ).toEqual([
      'apps/staging/payments-api/catalog-info.yaml',
      'apps/staging/payments-api/deployment.yaml',
      'apps/staging/payments-api/service.yaml',
    ]);

    const requesterDenied = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(403);
    expect(requesterDenied.status).toBe(403);
    expect(scaffolder.scaffold).not.toHaveBeenCalled();

    const reviewerView = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .expect(200);
    expect(reviewerView.body.viewerPermissions.canReview).toBe(true);

    const approved = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({
        decision: 'approve',
        digest: created.body.snapshot.digest,
        comment: 'Reviewed exact staging output',
      })
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'scaffolding',
      decision: {
        reviewer: 'user:default/owner-reviewer',
        digest: created.body.snapshot.digest,
      },
      execution: { state: 'task_started', taskId: 'task-test-123' },
      viewerPermissions: { canReview: false },
    });
    expect(approved.body.auditTrail).toHaveLength(4);
    expect(scaffolder.scaffold).toHaveBeenCalledTimes(1);
    expect(scaffolder.scaffold).toHaveBeenCalledWith(
      {
        templateRef: 'template:default/nodejs-api',
        values: { ...proposal.inputs, replicas: 1 },
      },
      { credentials: expect.anything() },
    );
    expect(scaffolder.scaffold.mock.calls[0][1]).toEqual({
      credentials: expect.objectContaining({
        principal: expect.objectContaining({ type: 'service' }),
      }),
    });

    await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'reject', digest: created.body.snapshot.digest })
      .expect(409);
    const unchanged = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .expect(200);
    expect(unchanged.body.status).toBe('scaffolding');
    expect(unchanged.body.auditTrail).toHaveLength(4);
    expect(scaffolder.scaffold).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale digest and preserves pending state', async () => {
    const { server, scaffolder } = await start({ jev: alignedJev() });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    const conflict = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: `sha256:${'0'.repeat(64)}` })
      .expect(409);
    expect(conflict.status).toBe(409);
    const unchanged = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .expect(200);
    expect(unchanged.body.status).toBe('pending_approval');
    expect(scaffolder.scaffold).not.toHaveBeenCalled();
  });

  it('records ambiguous dispatch failure and does not retry it', async () => {
    const { server, scaffolder } = await start({
      jev: alignedJev(),
      scaffoldError: new Error('simulated timeout'),
    });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    const decision = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    expect(decision.body).toMatchObject({
      status: 'execution_failed',
      execution: {
        state: 'failed',
        errorCode: 'scaffolder_dispatch_failed',
      },
    });
    await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(409);
    expect(scaffolder.scaffold).toHaveBeenCalledTimes(1);
  });

  it('records a completed render task without claiming a PR or deployment', async () => {
    const { server, scaffolder } = await start({ jev: alignedJev() });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    scaffolder.getTask.mockResolvedValue({
      id: 'task-test-123',
      status: 'completed',
    } as never);
    const refreshed = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .expect(200);
    expect(refreshed.body).toMatchObject({
      status: 'render_complete',
      execution: { state: 'completed', taskId: 'task-test-123' },
    });
    expect(refreshed.body).not.toHaveProperty('pullRequestUrl');
    expect(scaffolder.scaffold).toHaveBeenCalledTimes(1);
  });

  it('publishes only a live, exact, task-bound approved snapshot', async () => {
    const { server, scaffolder } = await start({
      jev: alignedJev(),
      gitopsRepoUrl: 'github.com?owner=yash&repo=backstage-agent-guard-gitops',
    });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .send(proposal)
      .expect(201);
    const path = created.body.snapshot.envelope.gitopsTarget.path as string;
    const files = (
      created.body.snapshot.files as Array<{ path: string; sha256: string }>
    ).map(file => ({
      path: file.path.slice(path.length + 1),
      sha256: file.sha256,
    }));
    const reserveUrl = '/api/agent-guard/internal/publish/reserve';
    const completeUrl = '/api/agent-guard/internal/publish/complete';
    const serviceAuth = mockCredentials.service.header();
    const requestBody = {
      proposalId: created.body.id,
      taskId: 'task-test-123',
      claim: 'not-a-valid-claim'.repeat(3),
      files,
    };
    await request(server).post(reserveUrl).send(requestBody).expect(403);
    await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send(requestBody)
      .expect(403);

    const approved = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(200);
    expect(approved.body.execution).not.toHaveProperty('claimHash');
    expect(approved.body.snapshot.envelope.gitopsTarget.publishEnabled).toBe(
      true,
    );
    const scaffoldInput = scaffolder.scaffold.mock.calls[0][0] as {
      secrets: Record<string, string>;
    };
    const validRequest = {
      ...requestBody,
      claim: scaffoldInput.secrets.AGENT_GUARD_EXECUTION_CLAIM,
    };
    expect(validRequest.claim).toEqual(expect.any(String));
    expect(approved.body).not.toHaveProperty('execution.claimHash');
    await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send({ ...validRequest, taskId: 'another-task' })
      .expect(409);
    await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send({ ...validRequest, files: files.slice(1) })
      .expect(409);
    await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send({
        ...validRequest,
        files: [
          { ...files[0], sha256: `sha256:${'0'.repeat(64)}` },
          ...files.slice(1),
        ],
      })
      .expect(409);
    const reserved = await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send(validRequest)
      .expect(200);
    expect(reserved.body).toMatchObject({
      repoUrl: 'github.com?owner=yash&repo=backstage-agent-guard-gitops',
      targetBranchName: 'main',
      targetPath: path,
    });
    await request(server)
      .post(reserveUrl)
      .set('Authorization', serviceAuth)
      .send(validRequest)
      .expect(409);
    await request(server)
      .post(completeUrl)
      .set('Authorization', serviceAuth)
      .send({
        ...validRequest,
        files: undefined,
        prUrl: 'https://github.com/attacker/other/pull/12',
        prNumber: 12,
      })
      .expect(409);
    await request(server)
      .post(completeUrl)
      .set('Authorization', serviceAuth)
      .send({
        proposalId: created.body.id,
        taskId: 'task-test-123',
        claim: validRequest.claim,
        prUrl: 'https://github.com/yash/backstage-agent-guard-gitops/pull/12',
        prNumber: 12,
      })
      .expect(204);
    const view = await request(server)
      .get(`/api/agent-guard/proposals/${created.body.id}`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/requester'),
      )
      .expect(200);
    expect(view.body).toMatchObject({
      status: 'pr_open',
      execution: {
        state: 'pr_open',
        prNumber: 12,
        prUrl: 'https://github.com/yash/backstage-agent-guard-gitops/pull/12',
      },
    });
    expect(view.body.execution).not.toHaveProperty('claimHash');
  });

  it('denies same-team self-approval and lets a distinct owner reject', async () => {
    const { server, scaffolder } = await start({ jev: alignedJev() });
    const requesterHeader = mockCredentials.user.header(
      'user:default/same-team-requester',
    );
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set('Authorization', requesterHeader)
      .send(proposal)
      .expect(201);
    expect(created.body).toMatchObject({
      reviewLane: 'owner_review',
      viewerPermissions: { canReview: false },
    });
    await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set('Authorization', requesterHeader)
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(403);
    const rejected = await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'reject', digest: created.body.snapshot.digest })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      decision: {
        decision: 'reject',
        reviewer: 'user:default/owner-reviewer',
      },
    });
    expect(scaffolder.scaffold).not.toHaveBeenCalled();
  });

  it('never permits approval of a shared guest proposal', async () => {
    const { server } = await start({ jev: alignedJev() });
    const created = await request(server)
      .post('/api/agent-guard/proposals')
      .set('Authorization', mockCredentials.user.header('user:default/guest'))
      .send(proposal)
      .expect(201);
    expect(created.body.viewerPermissions.canReview).toBe(false);
    await request(server)
      .post(`/api/agent-guard/proposals/${created.body.id}/decision`)
      .set(
        'Authorization',
        mockCredentials.user.header('user:default/owner-reviewer'),
      )
      .send({ decision: 'approve', digest: created.body.snapshot.digest })
      .expect(403);
  });

  it('rejects even an existing guest user token in GitHub mode', async () => {
    const { server } = await start({ authMode: 'github' });
    const denied = await request(server)
      .get('/api/agent-guard/proposals')
      .set('Authorization', mockCredentials.user.header('user:default/guest'))
      .expect(403);
    expect(denied.body.error.message).toMatch(/guest identity is disabled/i);
  });
});
