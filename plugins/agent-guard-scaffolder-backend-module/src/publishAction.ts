import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import { createPublishGithubPullRequestAction } from '@backstage/plugin-scaffolder-backend-module-github';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

interface PublishPlan {
  repoUrl: string;
  branchName: string;
  targetBranchName: 'main';
  targetPath: string;
  title: string;
  description: string;
}

interface PublishRequest {
  proposalId: string;
  taskId: string;
  claim: string;
}

class TaskNotBoundError extends Error {}

export class GuardClient {
  constructor(
    private readonly services: {
      auth: AuthService;
      discovery: DiscoveryService;
    },
  ) {}

  private async post(path: string, body: object): Promise<unknown> {
    const credentials = await this.services.auth.getOwnServiceCredentials();
    const { token } = await this.services.auth.getPluginRequestToken({
      onBehalfOf: credentials,
      targetPluginId: 'agent-guard',
    });
    const baseUrl = await this.services.discovery.getBaseUrl('agent-guard');
    const response = await fetch(`${baseUrl}/internal/publish/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (path === 'reserve' && response.status === 409) {
        const errorResponse = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        if (errorResponse?.error?.message === 'task_not_bound') {
          throw new TaskNotBoundError();
        }
      }
      // Never include the response body: it may echo task input or secrets.
      throw new Error(
        `Agent Guard publish ${path} rejected (${response.status})`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  async reserve(
    input: PublishRequest & { files: Array<{ path: string; sha256: string }> },
  ): Promise<PublishPlan> {
    // Scaffolder may begin executing before its task ID has been persisted by
    // Agent Guard. Only that specific pre-reservation race is safe to retry.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return (await this.post('reserve', input)) as PublishPlan;
      } catch (error) {
        if (!(error instanceof TaskNotBoundError) || attempt === 19) {
          throw error;
        }
        await delay(250);
      }
    }
    throw new Error('Agent Guard task did not become ready');
  }

  async complete(
    input: PublishRequest & { prUrl: string; prNumber: number },
  ): Promise<void> {
    await this.post('complete', input);
  }
}

export async function hashWorkspace(
  workspacePath: string,
): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({
          path: relativePath,
          sha256: `sha256:${createHash('sha256')
            .update(await readFile(absolutePath))
            .digest('hex')}`,
        });
      } else {
        throw new Error('Rendered workspace contains an unsupported file type');
      }
    }
  }
  await visit(workspacePath);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

type GithubAction = ReturnType<typeof createPublishGithubPullRequestAction>;

export function createGuardedPublishAction(options: {
  guard: Pick<GuardClient, 'reserve' | 'complete'>;
  githubAction: GithubAction;
}) {
  return createTemplateAction({
    id: 'agent-guard:publish-gitops-pr',
    description:
      'Publish a task-bound, hash-verified Agent Guard snapshot, or skip render-only tasks',
    schema: {
      input: z => z.object({}).strict(),
      output: {
        pullRequestUrl: z => z.string().url().optional(),
      },
    },
    async handler(ctx) {
      if (ctx.isDryRun) {
        throw new Error('Governed GitOps publishing cannot be dry-run');
      }
      const proposalId = ctx.secrets?.AGENT_GUARD_PROPOSAL_ID;
      const claim = ctx.secrets?.AGENT_GUARD_EXECUTION_CLAIM;
      if (!proposalId && !claim) {
        // Render-only approvals deliberately carry neither credential. The
        // guard still rejects incomplete or invalid claims before GitHub.
        return;
      }
      if (!proposalId || !claim) {
        throw new Error('Missing Agent Guard execution claim');
      }
      const request = { proposalId, taskId: ctx.task.id, claim };
      const files = await hashWorkspace(ctx.workspacePath);
      const plan = await options.guard.reserve({ ...request, files });
      let prUrl: string | undefined;
      let prNumber: number | undefined;
      await options.githubAction.handler({
        ...ctx,
        input: {
          repoUrl: plan.repoUrl,
          branchName: plan.branchName,
          targetBranchName: plan.targetBranchName,
          targetPath: plan.targetPath,
          title: plan.title,
          description: plan.description,
          update: false,
          createWhenEmpty: false,
        },
        output(name, value) {
          if (name === 'remoteUrl') {
            prUrl = value as string;
          } else if (name === 'pullRequestNumber') {
            prNumber = value as number;
          }
        },
      });
      if (!prUrl || !prNumber) {
        throw new Error('GitHub did not return a pull request');
      }
      await options.guard.complete({ ...request, prUrl, prNumber });
      ctx.output('pullRequestUrl', prUrl);
    },
  });
}
