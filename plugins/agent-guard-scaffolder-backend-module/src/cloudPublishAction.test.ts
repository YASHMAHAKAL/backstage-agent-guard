import {
  CloudGuardClient,
  CloudPublishPlan,
  ExactBaseCloudPublisher,
  createCloudPublishAction,
} from './cloudPublishAction';
import { createHash } from 'node:crypto';

const proposalId = '00000000-0000-4000-8000-000000000001';
const digest = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
const plan: CloudPublishPlan = {
  operation: 'rizz_cloud_release',
  target: {
    gitopsRepository: 'https://github.com/example/gitops.git',
    gitopsBranch: 'main',
    gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
  },
  baseRevision: 'a'.repeat(40),
  branchName: `agent-guard-cloud/${proposalId}`,
  approvedDigest: digest('fixture-approved'),
  createdAt: '2026-09-27T12:00:00Z',
  files: [
    'backend-deployment.yaml',
    'backend-service.yaml',
    'external-secret.yaml',
    'frontend-deployment.yaml',
    'frontend-service.yaml',
    'ingress.yaml',
    'kustomization.yaml',
    'runtime.yaml',
    'secret-store.yaml',
  ].map(name => ({
    path: `clusters/eks-staging/apps/rizz-ai/${name}`,
    content: '{}\n',
    sha256: digest('{}\n'),
  })),
};

it('allows the bounded reservation recheck to finish before timing out', async () => {
  const deadlines: number[] = [];
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(Response.json(plan))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  try {
    const guard = new CloudGuardClient({
      auth: {
        getOwnServiceCredentials: async () => ({}),
        getPluginRequestToken: async () => ({ token: 'test-token' }),
      },
      discovery: { getBaseUrl: async () => 'http://localhost:7007' },
    } as never);
    const claim = { proposalId, taskId: 'task-1', claim: 'a'.repeat(43) };
    await expect(guard.reserve(claim)).resolves.toEqual(plan);
    await expect(
      guard.complete({
        ...claim,
        prUrl: 'https://github.com/example/gitops/pull/7',
        prNumber: 7,
      }),
    ).resolves.toBeUndefined();
    expect(deadlines).toEqual([90000, 30000]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    fetcher.mockRestore();
    timeout.mockRestore();
  }
});
// Synthetic GitHub in-memory transport only. No network, token lookup or PR.
function harness(
  options: {
    moved?: boolean;
    foreignBranch?: boolean;
    timeoutAfterPr?: boolean;
    closed?: boolean;
    unsafeBase?: boolean;
  } = {},
) {
  const calls: Array<{
    path: string;
    method: string;
    body?: Record<string, any>;
  }> = [];
  let branch: string | undefined = options.foreignBranch
    ? 'f'.repeat(40)
    : undefined;
  let pr: Record<string, any> | undefined;
  const getToken = jest.fn().mockResolvedValue('synthetic-token-not-live');
  const fetcher = jest
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      const path = url.split('/repos/example/gitops/')[1];
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      const method = init.method ?? 'GET';
      calls.push({ path, body, method });
      if (path === 'git/ref/heads/main')
        return Response.json({
          ref: 'refs/heads/main',
          object: {
            type: 'commit',
            sha: options.moved ? 'f'.repeat(40) : plan.baseRevision,
          },
        });
      if (path === `git/commits/${plan.baseRevision}`)
        return Response.json({
          sha: plan.baseRevision,
          tree: { sha: 'b'.repeat(40) },
        });
      if (path.startsWith('git/trees/') && method === 'GET')
        return Response.json({
          sha: 'b'.repeat(40),
          truncated: false,
          tree: options.unsafeBase
            ? [
                {
                  path: `${plan.target.gitopsPath}/evil.yaml`,
                  type: 'blob',
                  mode: '100644',
                },
              ]
            : [],
        });
      if (path === 'git/trees' && method === 'POST')
        return Response.json({ sha: 'c'.repeat(40) });
      if (path === 'git/commits' && method === 'POST')
        return Response.json({ sha: 'd'.repeat(40) });
      if (path === `git/ref/heads/${plan.branchName}`)
        return branch
          ? Response.json({
              ref: `refs/heads/${plan.branchName}`,
              object: { type: 'commit', sha: branch },
            })
          : new Response(null, { status: 404 });
      if (path === 'git/refs' && method === 'POST') {
        branch = body.sha;
        return Response.json({ ref: body.ref, object: { sha: branch } });
      }
      if (path.startsWith('pulls?')) return Response.json(pr ? [pr] : []);
      if (path === 'pulls' && method === 'POST') {
        pr = {
          number: 7,
          html_url: 'https://github.com/example/gitops/pull/7',
          state: options.closed ? 'closed' : 'open',
          draft: body.draft,
          base: {
            ref: 'main',
            sha: plan.baseRevision,
            repo: { full_name: 'example/gitops' },
          },
          head: {
            ref: plan.branchName,
            sha: branch,
            repo: { full_name: 'example/gitops' },
          },
        };
        if (options.timeoutAfterPr)
          throw new Error('synthetic timeout after mutation');
        return Response.json(pr);
      }
      if (path === 'pulls/7') return Response.json(pr);
      throw new Error(`Unexpected fixture request: ${path}`);
    });
  return {
    calls,
    fetcher,
    getToken,
    publisher: new ExactBaseCloudPublisher({
      getToken,
      fetcher: fetcher as typeof fetch,
    }),
  };
}

it('creates exactly the frozen files from the reviewed base, as a draft; retries reuse branch/PR', async () => {
  const h = harness();
  const expected = {
    prUrl: 'https://github.com/example/gitops/pull/7',
    prNumber: 7,
  };
  expect(await h.publisher.publish(plan, proposalId)).toEqual(expected);
  expect(await h.publisher.publish(plan, proposalId)).toEqual(expected);
  const tree = h.calls.find(c => c.path === 'git/trees')!.body!;
  expect(tree.base_tree).toBe('b'.repeat(40));
  expect(tree.tree).toEqual(
    plan.files.map(file => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      content: file.content,
    })),
  );
  expect(
    h.calls.find(c => c.path === 'git/commits' && c.method === 'POST')!.body!
      .parents,
  ).toEqual([plan.baseRevision]);
  expect(
    h.calls.filter(c => c.path === 'git/refs' && c.method === 'POST'),
  ).toHaveLength(1);
  expect(
    h.calls.filter(c => c.path === 'pulls' && c.method === 'POST'),
  ).toHaveLength(1);
  expect(h.calls.some(c => ['PATCH', 'PUT', 'DELETE'].includes(c.method))).toBe(
    false,
  );
});
it('labels a governed runtime change distinctly while publishing only frozen bytes', async () => {
  const h = harness();
  const runtimePlan: CloudPublishPlan = {
    ...plan,
    operation: 'rizz_cloud_runtime_change',
  };
  await h.publisher.publish(runtimePlan, proposalId);
  expect(
    h.calls.find(call => call.path === 'git/commits' && call.method === 'POST')
      ?.body?.message,
  ).toContain('Approved Rizz.AI runtime change');
  expect(
    h.calls.find(call => call.path === 'pulls' && call.method === 'POST')?.body
      ?.title,
  ).toBe('Governed Rizz.AI staging runtime change');
  expect(
    h.calls.find(call => call.path === 'git/trees' && call.method === 'POST')
      ?.body?.tree,
  ).toEqual(
    plan.files.map(file => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      content: file.content,
    })),
  );
});
it('publishes a rollback as an exact-base draft PR, never a direct revert', async () => {
  const h = harness();
  const rollbackPlan: CloudPublishPlan = {
    ...plan,
    operation: 'rizz_cloud_rollback',
  };
  await h.publisher.publish(rollbackPlan, proposalId);
  expect(
    h.calls.find(call => call.path === 'git/commits' && call.method === 'POST')
      ?.body?.message,
  ).toContain('Approved Rizz.AI rollback');
  expect(
    h.calls.find(call => call.path === 'pulls' && call.method === 'POST')?.body
      ?.title,
  ).toBe('Governed Rizz.AI staging rollback');
  expect(
    h.calls.some(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method)),
  ).toBe(false);
});
it('recovers a PR response timeout without creating a duplicate', async () => {
  const h = harness({ timeoutAfterPr: true });
  await expect(h.publisher.publish(plan, proposalId)).resolves.toMatchObject({
    prNumber: 7,
  });
  expect(
    h.calls.filter(c => c.path === 'pulls' && c.method === 'POST'),
  ).toHaveLength(1);
});
it.each([{ moved: true }, { foreignBranch: true }, { unsafeBase: true }])(
  'refuses changed base/branch or unreviewed paths: %p',
  async options => {
    const h = harness(options);
    await expect(h.publisher.publish(plan, proposalId)).rejects.toThrow();
    expect(
      h.calls.filter(c => c.path === 'pulls' && c.method === 'POST'),
    ).toHaveLength(0);
  },
);
it('never opens a replacement for a closed proposal PR', async () => {
  const h = harness({ closed: true });
  await expect(h.publisher.publish(plan, proposalId)).rejects.toThrow('closed');
  await expect(h.publisher.publish(plan, proposalId)).rejects.toThrow('closed');
  expect(
    h.calls.filter(c => c.path === 'pulls' && c.method === 'POST'),
  ).toHaveLength(1);
});
it('rejects path/hash changes before retrieving publisher credentials', async () => {
  const h = harness();
  const bad = structuredClone(plan);
  bad.files[0].path = '../evil.yaml';
  await expect(h.publisher.publish(bad, proposalId)).rejects.toThrow(
    'Invalid frozen',
  );
  bad.files[0].path = plan.files[0].path;
  bad.files[0].content = 'modified';
  await expect(h.publisher.publish(bad, proposalId)).rejects.toThrow(
    'Invalid frozen',
  );
  expect(h.getToken).not.toHaveBeenCalled();
  expect(h.fetcher).not.toHaveBeenCalled();
});
it('private action requires a non-dry-run task claim and uses no agent workspace', async () => {
  const reserve = jest.fn().mockResolvedValue(plan);
  const complete = jest.fn().mockResolvedValue(undefined);
  const publish = jest.fn().mockResolvedValue({
    prUrl: 'https://github.com/example/gitops/pull/7',
    prNumber: 7,
  });
  const action = createCloudPublishAction({
    guard: { reserve, complete },
    publisher: { publish },
  });
  const ctx = {
    task: { id: 'cloud-task-fixture' },
    isDryRun: false,
    secrets: {},
    input: {},
    output: jest.fn(),
  };
  await expect(action.handler(ctx as never)).rejects.toThrow('claim');
  await expect(
    action.handler({ ...ctx, isDryRun: true } as never),
  ).rejects.toThrow('dry-run');
  expect(reserve).not.toHaveBeenCalled();
  await action.handler({
    ...ctx,
    secrets: {
      AGENT_GUARD_CLOUD_PROPOSAL_ID: proposalId,
      AGENT_GUARD_CLOUD_EXECUTION_CLAIM: 'a'.repeat(43),
    },
  } as never);
  expect(publish).toHaveBeenCalledWith(plan, proposalId);
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      proposalId,
      taskId: 'cloud-task-fixture',
      prNumber: 7,
    }),
  );
});
