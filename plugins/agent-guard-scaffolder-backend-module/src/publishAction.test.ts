import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuardedPublishAction, hashWorkspace } from './publishAction';

let workspacePath: string;

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'agent-guard-publish-test-'));
  await writeFile(join(workspacePath, 'deployment.yaml'), 'kind: Deployment\n');
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

function actionHarness(options: { claim?: string; approved?: boolean } = {}) {
  const reserve = jest.fn().mockImplementation(async () => {
    if (options.approved === false) {
      throw new Error('snapshot mismatch');
    }
    return {
      repoUrl: 'github.com?owner=yash&repo=backstage-agent-guard-gitops',
      branchName: 'agent-guard/proposal-1',
      targetBranchName: 'main',
      targetPath: 'apps/staging/demo',
      title: 'Deploy demo to staging',
      description: 'Approved digest',
    };
  });
  const complete = jest.fn().mockResolvedValue(undefined);
  const githubHandler = jest.fn().mockImplementation(async ctx => {
    ctx.output(
      'remoteUrl',
      'https://github.com/yash/backstage-agent-guard-gitops/pull/7',
    );
    ctx.output('pullRequestNumber', 7);
  });
  const action = createGuardedPublishAction({
    guard: { reserve, complete },
    githubAction: { handler: githubHandler } as never,
  });
  const output = jest.fn();
  const ctx = {
    workspacePath,
    task: { id: 'task-1' },
    secrets: options.claim
      ? {
          AGENT_GUARD_PROPOSAL_ID: 'proposal-1',
          AGENT_GUARD_EXECUTION_CLAIM: options.claim,
        }
      : undefined,
    output,
    isDryRun: false,
  };
  return { action, ctx, reserve, complete, githubHandler, output };
}

it('publishes only the backend-approved plan and records the returned PR', async () => {
  const { action, ctx, reserve, complete, githubHandler, output } =
    actionHarness({ claim: 'test-claim' });
  await action.handler(ctx as never);
  expect(reserve).toHaveBeenCalledWith({
    proposalId: 'proposal-1',
    taskId: 'task-1',
    claim: 'test-claim',
    files: await hashWorkspace(workspacePath),
  });
  expect(githubHandler).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        repoUrl: 'github.com?owner=yash&repo=backstage-agent-guard-gitops',
        targetPath: 'apps/staging/demo',
        update: false,
        createWhenEmpty: false,
      }),
    }),
  );
  expect(complete).toHaveBeenCalledWith({
    proposalId: 'proposal-1',
    taskId: 'task-1',
    claim: 'test-claim',
    prUrl: 'https://github.com/yash/backstage-agent-guard-gitops/pull/7',
    prNumber: 7,
  });
  expect(output).toHaveBeenCalledWith(
    'pullRequestUrl',
    'https://github.com/yash/backstage-agent-guard-gitops/pull/7',
  );
});

it('keeps render-only tasks inert and never contacts GitHub after guard rejection', async () => {
  const missing = actionHarness();
  await expect(
    missing.action.handler(missing.ctx as never),
  ).resolves.toBeUndefined();
  expect(missing.reserve).not.toHaveBeenCalled();
  expect(missing.githubHandler).not.toHaveBeenCalled();
  expect(missing.output).not.toHaveBeenCalled();

  const partial = actionHarness();
  await expect(
    partial.action.handler({
      ...partial.ctx,
      secrets: { AGENT_GUARD_PROPOSAL_ID: 'proposal-1' },
    } as never),
  ).rejects.toThrow('Missing Agent Guard execution claim');
  expect(partial.githubHandler).not.toHaveBeenCalled();

  const rejected = actionHarness({ claim: 'test-claim', approved: false });
  await expect(rejected.action.handler(rejected.ctx as never)).rejects.toThrow(
    'snapshot mismatch',
  );
  expect(rejected.githubHandler).not.toHaveBeenCalled();
});

it('rejects a symlink in the rendered workspace', async () => {
  await symlink('/tmp/other', join(workspacePath, 'link'));
  const { action, ctx, reserve, githubHandler } = actionHarness({
    claim: 'test-claim',
  });
  await expect(action.handler(ctx as never)).rejects.toThrow(
    'unsupported file type',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(githubHandler).not.toHaveBeenCalled();
});
