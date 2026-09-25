import { createHash } from 'node:crypto';
import { get as httpsGet } from 'node:https';
import { z } from 'zod/v3';
import { snapshotHasIntegrity } from './snapshot';
import type { ProposalRecord } from './services/ProposalService';

const githubPullSchema = z.object({
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

const githubContentSchema = z.object({
  content: z.string(),
  encoding: z.literal('base64'),
});

const argoApplicationSchema = z.object({
  spec: z.object({
    project: z.string(),
    source: z.object({
      repoURL: z.string(),
      targetRevision: z.string(),
      path: z.string(),
    }),
    destination: z.object({ namespace: z.string() }),
  }),
  status: z.object({
    sync: z.object({ status: z.string(), revision: z.string().optional() }),
    health: z.object({ status: z.string() }),
    conditions: z.array(z.object({ type: z.string() })).optional(),
  }),
});

const argoTreeSchema = z.object({
  nodes: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      namespace: z.string().optional(),
      health: z.object({ status: z.string() }).optional(),
    }),
  ),
});

export type GitHubDelivery =
  | { state: 'not_published' }
  | { state: 'unavailable'; reason: string }
  | { state: 'source_mismatch'; reason: string }
  | { state: 'open'; url: string }
  | { state: 'closed_unmerged'; url: string }
  | {
      state: 'merged';
      url: string;
      mergedAt: string;
      mergeCommitSha: string;
      approvedFilesMatch: boolean;
    };

export type ArgoDelivery =
  | { state: 'not_checked' }
  | { state: 'not_configured' }
  | { state: 'unavailable'; reason: string }
  | { state: 'source_mismatch'; reason: string }
  | {
      state: 'observed';
      applicationName: string;
      syncStatus: string;
      healthStatus: string;
      revision?: string;
      workloadKind: string;
      workloadHealth: string;
      conditions: string[];
    };

export interface DeliveryStatus {
  checkedAt: string;
  github: GitHubDelivery;
  argoCd: ArgoDelivery;
  deployed: boolean;
}

type Fetcher = typeof fetch;

function parseRepository(repository: string) {
  const url = new URL(`https://${repository}`);
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');
  if (
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    [...url.searchParams.keys()].sort().join(',') !== 'owner,repo' ||
    !owner ||
    !repo ||
    !/^[a-zA-Z0-9-]+$/.test(owner) ||
    !/^[a-zA-Z0-9-]+$/.test(repo)
  ) {
    return undefined;
  }
  return { owner, repo };
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'authentication_failed';
  }
  if (status === 404) {
    return 'not_found';
  }
  return `http_${status}`;
}

export class DeliveryStatusObserver {
  private readonly argoCdBaseUrl?: string;

  constructor(
    private readonly options: {
      githubToken?: string;
      argoCdUrl?: string;
      argoCdToken?: string;
      argoCdCaBase64?: string;
      fetcher?: Fetcher;
    } = {},
  ) {
    if (options.argoCdUrl) {
      const url = new URL(options.argoCdUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        !(
          url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
      ) {
        throw new Error(
          'AGENT_GUARD_ARGOCD_URL must be HTTPS or a loopback HTTP origin',
        );
      }
      this.argoCdBaseUrl = url.origin;
    }
  }

  private get fetcher(): Fetcher {
    return this.options.fetcher ?? fetch;
  }

  private async readJson(
    url: string,
    token: string,
    github: boolean,
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
    if (
      !github &&
      !this.options.fetcher &&
      this.options.argoCdCaBase64 &&
      url.startsWith('https:')
    ) {
      return this.readArgoWithCa(url, token);
    }
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: github ? 'application/vnd.github+json' : 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { ok: false, reason: reasonForStatus(response.status) };
      }
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, reason: 'request_failed' };
    }
  }

  private readArgoWithCa(
    url: string,
    token: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
    return new Promise(resolve => {
      const request = httpsGet(
        url,
        {
          ca: Buffer.from(this.options.argoCdCaBase64!, 'base64'),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          timeout: 5000,
        },
        response => {
          if (!response.statusCode || response.statusCode >= 300) {
            response.resume();
            resolve({
              ok: false,
              reason: reasonForStatus(response.statusCode ?? 0),
            });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2_000_000) {
              request.destroy(new Error('response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              resolve({
                ok: true,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch {
              resolve({ ok: false, reason: 'invalid_json' });
            }
          });
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', () => {
        resolve({ ok: false, reason: 'request_failed' });
      });
    });
  }

  async observe(record: ProposalRecord): Promise<DeliveryStatus> {
    const checkedAt = new Date().toISOString();
    const github = await this.observeGitHub(record);
    if (github.state !== 'merged' || !github.approvedFilesMatch) {
      return {
        checkedAt,
        github,
        argoCd: { state: 'not_checked' },
        deployed: false,
      };
    }
    const argoCd = await this.observeArgoCd(record);
    return {
      checkedAt,
      github,
      argoCd,
      deployed:
        argoCd.state === 'observed' &&
        argoCd.revision === github.mergeCommitSha &&
        argoCd.syncStatus === 'Synced' &&
        argoCd.healthStatus === 'Healthy' &&
        argoCd.workloadHealth === 'Healthy' &&
        argoCd.conditions.length === 0,
    };
  }

  private async observeGitHub(record: ProposalRecord): Promise<GitHubDelivery> {
    if (
      !record.snapshot ||
      !record.execution?.prNumber ||
      !record.execution.prUrl
    ) {
      return { state: 'not_published' };
    }
    if (
      !snapshotHasIntegrity(record.snapshot) ||
      record.snapshot.envelope.proposalId !== record.id ||
      record.decision?.decision !== 'approve' ||
      record.decision.digest !== record.snapshot.digest ||
      record.decision.reviewer === record.requester
    ) {
      return { state: 'source_mismatch', reason: 'approval_integrity_failure' };
    }
    const repository = parseRepository(
      record.snapshot.envelope.gitopsTarget.repository,
    );
    if (!repository || !record.snapshot.envelope.gitopsTarget.publishEnabled) {
      return {
        state: 'source_mismatch',
        reason: 'invalid_approved_repository',
      };
    }
    const { owner, repo } = repository;
    const url = `https://github.com/${owner}/${repo}/pull/${record.execution.prNumber}`;
    if (record.execution.prUrl.toLowerCase() !== url.toLowerCase()) {
      return { state: 'source_mismatch', reason: 'pr_url_mismatch' };
    }
    if (!this.options.githubToken) {
      return { state: 'unavailable', reason: 'github_token_not_configured' };
    }
    const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
    const pull = await this.readJson(
      `${apiBase}/pulls/${record.execution.prNumber}`,
      this.options.githubToken,
      true,
    );
    if (!pull.ok) {
      return { state: 'unavailable', reason: pull.reason };
    }
    const parsed = githubPullSchema.safeParse(pull.body);
    if (!parsed.success) {
      return { state: 'unavailable', reason: 'invalid_pr_response' };
    }
    const { base, head, state, merged_at, merge_commit_sha } = parsed.data;
    if (
      base.ref !== record.snapshot.envelope.gitopsTarget.branch ||
      head.ref !== `agent-guard/${record.id}` ||
      head.repo?.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
    ) {
      return { state: 'source_mismatch', reason: 'pr_identity_mismatch' };
    }
    if (state === 'open') {
      return { state: 'open', url };
    }
    if (!merged_at) {
      return { state: 'closed_unmerged', url };
    }
    if (!merge_commit_sha || !/^[a-f0-9]{40}$/i.test(merge_commit_sha)) {
      return { state: 'unavailable', reason: 'missing_merge_commit' };
    }
    const matches = await Promise.all(
      record.snapshot.files.map(async file => {
        const contents = await this.readJson(
          `${apiBase}/contents/${file.path}?ref=${merge_commit_sha}`,
          this.options.githubToken!,
          true,
        );
        if (!contents.ok) {
          return { ok: false, reason: contents.reason };
        }
        const content = githubContentSchema.safeParse(contents.body);
        if (!content.success) {
          return { ok: false, reason: 'invalid_content_response' };
        }
        const actual = createHash('sha256')
          .update(Buffer.from(content.data.content, 'base64'))
          .digest('hex');
        return { ok: true, matches: file.sha256 === `sha256:${actual}` };
      }),
    );
    const failure = matches.find(result => !result.ok);
    if (failure && 'reason' in failure) {
      return {
        state: 'unavailable',
        reason: failure.reason ?? 'content_check_failed',
      };
    }
    return {
      state: 'merged',
      url,
      mergedAt: merged_at,
      mergeCommitSha: merge_commit_sha.toLowerCase(),
      approvedFilesMatch: matches.every(result => result.ok && result.matches),
    };
  }

  private async observeArgoCd(record: ProposalRecord): Promise<ArgoDelivery> {
    if (!this.argoCdBaseUrl || !this.options.argoCdToken) {
      return { state: 'not_configured' };
    }
    const name = record.inputs.serviceName;
    const project = 'agent-guard-staging';
    const path = `/api/v1/applications/${encodeURIComponent(name)}`;
    const application = await this.readJson(
      `${this.argoCdBaseUrl}${path}?project=${project}`,
      this.options.argoCdToken,
      false,
    );
    if (!application.ok) {
      return { state: 'unavailable', reason: application.reason };
    }
    const parsed = argoApplicationSchema.safeParse(application.body);
    if (!parsed.success) {
      return { state: 'unavailable', reason: 'invalid_application_response' };
    }
    const repository = parseRepository(
      record.snapshot!.envelope.gitopsTarget.repository,
    );
    const { spec, status } = parsed.data;
    if (
      !repository ||
      spec.project !== project ||
      spec.source.repoURL.toLowerCase() !==
        `git@github.com:${repository.owner}/${repository.repo}.git`.toLowerCase() ||
      spec.source.targetRevision !==
        record.snapshot!.envelope.gitopsTarget.branch ||
      spec.source.path !== record.snapshot!.envelope.gitopsTarget.path ||
      spec.destination.namespace !== record.inputs.environment
    ) {
      return {
        state: 'source_mismatch',
        reason: 'application_target_mismatch',
      };
    }
    const tree = await this.readJson(
      `${this.argoCdBaseUrl}${path}/resource-tree?project=${project}`,
      this.options.argoCdToken,
      false,
    );
    if (!tree.ok) {
      return { state: 'unavailable', reason: tree.reason };
    }
    const parsedTree = argoTreeSchema.safeParse(tree.body);
    if (!parsedTree.success) {
      return { state: 'unavailable', reason: 'invalid_resource_tree' };
    }
    const workloadKind =
      record.templateId === 'scheduled-worker' ? 'CronJob' : 'Deployment';
    const workload = parsedTree.data.nodes.find(
      node =>
        node.kind === workloadKind &&
        node.namespace === record.inputs.environment &&
        node.name === name,
    );
    return {
      state: 'observed',
      applicationName: name,
      syncStatus: status.sync.status,
      healthStatus: status.health.status,
      revision: status.sync.revision,
      workloadKind,
      workloadHealth: workload?.health?.status ?? 'Unknown',
      conditions: (status.conditions ?? []).map(condition => condition.type),
    };
  }
}
