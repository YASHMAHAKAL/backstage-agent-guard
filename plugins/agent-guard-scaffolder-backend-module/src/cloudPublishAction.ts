import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

interface Claim {
  proposalId: string;
  taskId: string;
  claim: string;
}
export interface CloudPublishPlan {
  operation:
    | 'rizz_cloud_release'
    | 'rizz_cloud_runtime_change'
    | 'rizz_cloud_rollback'
    | 'rizz_cloud_retire_ingress'
    | 'rizz_cloud_retire_app';
  files: Array<{ path: string; content: string; sha256: string }>;
  deletePaths?: string[];
  target: {
    gitopsRepository: string;
    gitopsBranch: 'main';
    gitopsPath: 'clusters/eks-staging/apps/rizz-ai';
  };
  baseRevision: string;
  branchName: string;
  approvedDigest: string;
  createdAt: string;
}
function operationLabel(operation: CloudPublishPlan['operation']) {
  if (operation === 'rizz_cloud_runtime_change') return 'runtime change';
  if (operation === 'rizz_cloud_rollback') return 'rollback';
  if (operation === 'rizz_cloud_retire_ingress') return 'retirement ingress';
  if (operation === 'rizz_cloud_retire_app') return 'retirement app';
  return 'release';
}
const filenames = [
  'backend-deployment.yaml',
  'backend-service.yaml',
  'external-secret.yaml',
  'frontend-deployment.yaml',
  'frontend-service.yaml',
  'ingress.yaml',
  'kustomization.yaml',
  'runtime.yaml',
  'secret-store.yaml',
];
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
function validatePlan(value: CloudPublishPlan, proposalId: string) {
  const t = value?.target;
  const deleted = value?.deletePaths ?? [];
  const expectedFiles =
    value?.operation === 'rizz_cloud_retire_ingress'
      ? filenames.filter(name => name !== 'ingress.yaml')
      : value?.operation === 'rizz_cloud_retire_app'
      ? ['kustomization.yaml']
      : filenames;
  const expectedDeleted =
    value?.operation === 'rizz_cloud_retire_ingress'
      ? ['ingress.yaml']
      : value?.operation === 'rizz_cloud_retire_app'
      ? filenames.filter(
          name => name !== 'ingress.yaml' && name !== 'kustomization.yaml',
        )
      : [];
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      proposalId,
    ) ||
    !t ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      t.gitopsRepository,
    ) ||
    t.gitopsBranch !== 'main' ||
    t.gitopsPath !== 'clusters/eks-staging/apps/rizz-ai' ||
    !/^[a-f0-9]{40}$/.test(value.baseRevision) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.approvedDigest) ||
    ![
      'rizz_cloud_release',
      'rizz_cloud_runtime_change',
      'rizz_cloud_rollback',
      'rizz_cloud_retire_ingress',
      'rizz_cloud_retire_app',
    ].includes(value.operation) ||
    value.branchName !== `agent-guard-cloud/${proposalId}` ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.files) ||
    value.files.length !== expectedFiles.length ||
    new Set(value.files.map(file => file.path)).size !== expectedFiles.length ||
    !Array.isArray(deleted) ||
    deleted.length !== expectedDeleted.length ||
    new Set(deleted).size !== expectedDeleted.length ||
    expectedFiles.some(
      name =>
        !value.files.some(file => file.path === `${t.gitopsPath}/${name}`),
    ) ||
    expectedDeleted.some(
      name => !deleted.includes(`${t.gitopsPath}/${name}`),
    ) ||
    value.files.some(
      file =>
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.content) > 65536 ||
        !expectedFiles.some(name => file.path === `${t.gitopsPath}/${name}`) ||
        file.sha256 !== hash(file.content),
    )
  )
    throw new Error('Invalid frozen cloud publish plan');
}

class TaskNotBoundError extends Error {}
export class CloudGuardClient {
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
    const base = await this.services.discovery.getBaseUrl('agent-guard');
    const response = await fetch(`${base}/internal/rizz/publish/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (path === 'reserve' && response.status === 409) {
        const error = (await response.json().catch(() => undefined)) as
          | { error?: { message?: string } }
          | undefined;
        if (error?.error?.message === 'task_not_bound')
          throw new TaskNotBoundError();
      }
      throw new Error(`Cloud approval gate rejected (${response.status})`);
    }
    return response.status === 204 ? undefined : response.json();
  }
  async reserve(input: Claim): Promise<CloudPublishPlan> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return (await this.post('reserve', input)) as CloudPublishPlan;
      } catch (error) {
        if (!(error instanceof TaskNotBoundError) || attempt === 19)
          throw error;
        await delay(250);
      }
    }
    throw new Error('Cloud task did not become bound');
  }
  async complete(input: Claim & { prUrl: string; prNumber: number }) {
    await this.post('complete', input);
  }
}

type Json = Record<string, any>; // GitHub response fields are checked before use below.
export class ExactBaseCloudPublisher {
  constructor(
    private readonly options: {
      getToken: (repository: string) => Promise<string>;
      fetcher?: typeof fetch;
    },
  ) {}
  async publish(
    plan: CloudPublishPlan,
    proposalId: string,
  ): Promise<{ prUrl: string; prNumber: number }> {
    validatePlan(plan, proposalId);
    const repo = plan.target.gitopsRepository.slice(
      'https://github.com/'.length,
      -4,
    );
    const token = await this.options.getToken(plan.target.gitopsRepository);
    if (!token) throw new Error('Cloud publisher credential unavailable');
    const signal = AbortSignal.timeout(60000);
    const api = async (
      path: string,
      body?: object,
      optional = false,
    ): Promise<Json | undefined> => {
      let response: Response;
      try {
        response = await (this.options.fetcher ?? fetch)(
          `https://api.github.com/repos/${repo}/${path}`,
          {
            method: body ? 'POST' : 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal,
            redirect: 'error',
          },
        );
      } catch {
        throw new Error(
          'Cloud GitHub request unavailable; reconcile before retry',
        );
      }
      if (optional && response.status === 404) return undefined;
      if (!response.ok || !response.body)
        throw new Error(
          `Cloud GitHub request rejected (${response.status}); reconcile before retry`,
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 2 * 1024 * 1024)
            throw new Error('Cloud GitHub response too large');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
    };
    const sha = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
        throw new Error('Invalid GitHub object identity');
      return value;
    };
    const checkMain = async () => {
      const ref = await api('git/ref/heads/main');
      if (
        ref?.ref !== 'refs/heads/main' ||
        ref.object?.type !== 'commit' ||
        sha(ref.object.sha) !== plan.baseRevision
      )
        throw new Error('GitOps base changed; a new review is required');
    };
    await checkMain();
    const base = await api(`git/commits/${plan.baseRevision}`);
    if (base?.sha !== plan.baseRevision)
      throw new Error('Wrong GitOps base commit');
    const baseTree = sha(base.tree?.sha);
    const listing = await api(`git/trees/${baseTree}?recursive=1`);
    if (
      listing?.sha !== baseTree ||
      listing.truncated !== false ||
      !Array.isArray(listing.tree) ||
      listing.tree.length > 10000
    )
      throw new Error('Incomplete GitOps base tree');
    for (const entry of listing.tree) {
      if (typeof entry.path !== 'string')
        throw new Error('Invalid GitOps base path');
      if (
        (entry.path === plan.target.gitopsPath ||
          plan.target.gitopsPath.startsWith(`${entry.path}/`)) &&
        (entry.type !== 'tree' || entry.mode !== '040000')
      )
        throw new Error('Unsafe cloud parent directory');
      if (
        entry.path.startsWith(`${plan.target.gitopsPath}/`) &&
        (entry.type !== 'blob' ||
          entry.mode !== '100644' ||
          ![
            ...plan.files.map(file => file.path),
            ...(plan.deletePaths ?? []),
          ].includes(entry.path))
      )
        throw new Error('Unreviewed cloud file in base');
    }
    const expectedBasePaths =
      plan.operation === 'rizz_cloud_retire_ingress' ||
      plan.operation === 'rizz_cloud_retire_app'
        ? [...plan.files.map(file => file.path), ...(plan.deletePaths ?? [])]
        : [];
    if (
      expectedBasePaths.some(
        path =>
          !listing.tree.some(
            (entry: Json) =>
              entry.path === path &&
              entry.type === 'blob' &&
              entry.mode === '100644',
          ),
      )
    )
      throw new Error('Retirement base files changed or are missing');
    // GitHub writes the exact frozen bytes over the reviewed base tree; there is
    // no workspace, mutable branch checkout, deletion, force push or main write.
    const tree = await api('git/trees', {
      base_tree: baseTree,
      tree: [
        ...plan.files.map(file => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
        ...(plan.deletePaths ?? []).map(path => ({
          path,
          mode: '100644',
          type: 'blob',
          sha: null,
        })),
      ],
    });
    const expectedTree = sha(tree?.sha);
    const date = new Date(plan.createdAt).toISOString();
    const identity = {
      name: 'Agent Guard',
      email: 'agent-guard@users.noreply.github.com',
      date,
    };
    const commit = await api('git/commits', {
      message: `Approved Rizz.AI ${operationLabel(
        plan.operation,
      )} ${proposalId}\n\n${plan.approvedDigest}`,
      tree: expectedTree,
      parents: [plan.baseRevision],
      author: identity,
      committer: identity,
    });
    const expectedHead = sha(commit?.sha);
    const branchPath = `git/ref/heads/${plan.branchName}`;
    let branch = await api(branchPath, undefined, true);
    if (!branch) {
      await checkMain();
      try {
        await api('git/refs', {
          ref: `refs/heads/${plan.branchName}`,
          sha: expectedHead,
        });
      } catch {
        // A timeout/concurrent create may already have succeeded. Never force it.
        branch = await api(branchPath, undefined, true);
        if (!branch)
          throw new Error(
            'Cloud branch result unknown; reconcile before retry',
          );
      }
      branch = await api(branchPath);
    }
    if (
      branch?.ref !== `refs/heads/${plan.branchName}` ||
      branch.object?.type !== 'commit' ||
      sha(branch.object.sha) !== expectedHead
    )
      throw new Error('Cloud proposal branch changed; refusing overwrite');
    const verifyPr = (pr: Json | undefined) => {
      if (
        !pr ||
        !Number.isSafeInteger(pr.number) ||
        pr.number < 1 ||
        pr.state !== 'open' ||
        pr.draft !== true ||
        pr.html_url !== `https://github.com/${repo}/pull/${pr.number}` ||
        pr.base?.ref !== 'main' ||
        pr.base.sha !== plan.baseRevision ||
        pr.base.repo?.full_name !== repo ||
        pr.head?.ref !== plan.branchName ||
        pr.head.sha !== expectedHead ||
        pr.head.repo?.full_name !== repo
      )
        throw new Error(
          'Cloud PR is closed, altered or differs from approved change',
        );
      return { prUrl: pr.html_url as string, prNumber: pr.number as number };
    };
    const query = `pulls?state=all&head=${encodeURIComponent(
      `${repo.split('/')[0]}:${plan.branchName}`,
    )}&base=main&per_page=100`;
    const lookup = async () => {
      const items = (await api(query)) as unknown;
      if (!Array.isArray(items) || items.length > 1)
        throw new Error('Ambiguous cloud PR history');
      return items[0] as Json | undefined;
    };
    let pr = await lookup();
    if (!pr) {
      await checkMain();
      try {
        pr = await api('pulls', {
          title: `Governed Rizz.AI staging ${operationLabel(plan.operation)}`,
          head: plan.branchName,
          base: 'main',
          draft: true,
          body: `Approval: ${plan.approvedDigest}\nReviewed base: ${plan.baseRevision}\n\nDraft: verify required checks and unchanged base before marking ready. No deployment until human merge.`,
        });
      } catch {
        pr = await lookup();
        if (!pr)
          throw new Error('Cloud PR result unknown; reconcile before retry');
      }
    }
    const result = verifyPr(pr);
    await checkMain();
    verifyPr(await api(`pulls/${result.prNumber}`));
    const finalBranch = await api(branchPath);
    if (finalBranch?.object?.sha !== expectedHead)
      throw new Error('Cloud branch moved before completion');
    return result;
  }
}

export function createCloudPublishAction(options: {
  guard: Pick<CloudGuardClient, 'reserve' | 'complete'>;
  publisher: Pick<ExactBaseCloudPublisher, 'publish'>;
}) {
  return createTemplateAction({
    id: 'agent-guard:publish-rizz-cloud-pr',
    description:
      'Publish only frozen task-bound Rizz.AI files as an exact-base draft PR',
    schema: {
      input: z => z.object({}).strict(),
      output: { pullRequestUrl: z => z.string().url() },
    },
    async handler(ctx) {
      if (ctx.isDryRun) throw new Error('Cloud publishing cannot be dry-run');
      const proposalId = ctx.secrets?.AGENT_GUARD_CLOUD_PROPOSAL_ID;
      const claim = ctx.secrets?.AGENT_GUARD_CLOUD_EXECUTION_CLAIM;
      if (
        !proposalId ||
        !/^[a-f0-9-]{36}$/.test(proposalId) ||
        !claim ||
        !/^[A-Za-z0-9_-]{43}$/.test(claim)
      )
        throw new Error('Missing or invalid cloud task claim');
      const input = { proposalId, taskId: ctx.task.id, claim };
      const plan = await options.guard.reserve(input);
      validatePlan(plan, proposalId);
      const result = await options.publisher.publish(plan, proposalId);
      await options.guard.complete({ ...input, ...result });
      ctx.output('pullRequestUrl', result.prUrl);
    },
  });
}
