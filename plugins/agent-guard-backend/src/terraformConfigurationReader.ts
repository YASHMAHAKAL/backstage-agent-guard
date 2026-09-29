import { z } from 'zod/v3';
import { TerraformConfigurationReader } from './services/TerraformControlService';
import { capacityFile } from './terraformCapacityPublisher';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positive = z.number().int().positive();
const pullSchema = z.object({
  number: positive,
  html_url: z.string().url(),
  merged_at: z.string().datetime().nullable(),
  merge_commit_sha: sha.nullable(),
  changed_files: z.number().int().min(1).max(100),
  user: z.object({ id: positive }),
  head: z.object({
    sha,
    repo: z.object({ id: positive, full_name: z.string() }),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ id: positive, full_name: z.string() }),
  }),
});
const reviewSchema = z.object({
  id: positive,
  user: z.object({ id: positive, login: z.string().min(1) }),
  state: z.enum([
    'APPROVED',
    'CHANGES_REQUESTED',
    'COMMENTED',
    'DISMISSED',
    'PENDING',
  ]),
  commit_id: sha,
  submitted_at: z.string().datetime().nullable(),
});
const fileSchema = z.object({
  filename: z.string().min(1).max(300),
  status: z.enum(['added', 'modified', 'removed']),
});

/** Read-only verification for a single reviewed infrastructure PR in the
 * platform repository. It never accepts a URL as an arbitrary fetch target. */
export class GitHubTerraformConfigurationReader
  implements TerraformConfigurationReader
{
  constructor(
    private readonly options: {
      owner: string;
      repo: string;
      token: string;
      fetcher?: typeof fetch;
    },
  ) {
    if (
      !/^[A-Za-z0-9-]{1,39}$/.test(options.owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(options.repo) ||
      !options.token
    )
      throw new Error('Invalid Terraform configuration repository');
  }

  private async read(path: string): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.github.com/repos/${this.options.owner}/${this.options.repo}${path}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok)
      throw new Error('GitHub configuration review unavailable');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 256 * 1024)
      throw new Error('GitHub configuration review response too large');
    const body = await response.text();
    if (Buffer.byteLength(body) > 256 * 1024)
      throw new Error('GitHub configuration review response too large');
    return JSON.parse(body) as unknown;
  }

  async verifyMergedReview(input: {
    pullRequest: { url: string; mergedCommit: string };
    sourceCommit: string;
    root: 'registry' | 'staging';
    requesterRef: string;
    capacityDesiredWorkers?: number;
    capacityPrHeadCommit?: string;
  }) {
    const expectedPrefix = `https://github.com/${this.options.owner}/${this.options.repo}/pull/`;
    if (!input.pullRequest.url.startsWith(expectedPrefix)) return false;
    const numberText = input.pullRequest.url.slice(expectedPrefix.length);
    if (!/^[1-9][0-9]*$/.test(numberText)) return false;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number)) return false;
    const pull = pullSchema.parse(await this.read(`/pulls/${number}`));
    const expectedName =
      `${this.options.owner}/${this.options.repo}`.toLowerCase();
    if (
      pull.number !== number ||
      pull.html_url !== input.pullRequest.url ||
      !pull.merged_at ||
      pull.merge_commit_sha !== input.sourceCommit ||
      pull.merge_commit_sha !== input.pullRequest.mergedCommit ||
      pull.base.ref !== 'main' ||
      pull.base.repo.full_name.toLowerCase() !== expectedName ||
      pull.head.repo.id !== pull.base.repo.id ||
      pull.head.repo.full_name.toLowerCase() !== expectedName
    )
      return false;
    if (
      input.capacityDesiredWorkers !== undefined &&
      (input.root !== 'staging' || pull.head.sha !== input.capacityPrHeadCommit)
    )
      return false;
    const reviews = z
      .array(reviewSchema)
      .max(100)
      .parse(await this.read(`/pulls/${number}/reviews?per_page=100`));
    if (reviews.length === 100) return false;
    const latest = new Map<number, (typeof reviews)[number]>();
    for (const review of reviews) {
      if (!review.submitted_at) continue;
      const previous = latest.get(review.user.id);
      if (
        !previous?.submitted_at ||
        Date.parse(review.submitted_at) > Date.parse(previous.submitted_at)
      )
        latest.set(review.user.id, review);
    }
    const approved = [...latest.values()].some(
      review =>
        review.user.id !== pull.user.id &&
        `user:default/${review.user.login.toLowerCase()}` !==
          input.requesterRef.toLowerCase() &&
        review.state === 'APPROVED' &&
        review.commit_id === pull.head.sha,
    );
    if (!approved) return false;
    const files = z
      .array(fileSchema)
      .max(100)
      .parse(await this.read(`/pulls/${number}/files?per_page=100`));
    const prefix =
      input.root === 'registry'
        ? 'infra/aws/registry/'
        : 'infra/aws/environments/staging/';
    const mainRef = z
      .object({
        ref: z.literal('refs/heads/main'),
        object: z.object({ type: z.literal('commit'), sha }),
      })
      .parse(await this.read('/git/ref/heads/main'));
    const reviewedFiles =
      files.length === pull.changed_files &&
      files.length > 0 &&
      files.every(file => file.filename.startsWith(prefix)) &&
      mainRef.object.sha === input.sourceCommit;
    if (!reviewedFiles) return false;
    if (input.capacityDesiredWorkers === undefined) return true;
    if (
      files.length !== 1 ||
      files[0].filename !== capacityFile ||
      files[0].status !== 'modified'
    )
      return false;
    const content = z
      .object({ encoding: z.literal('base64'), content: z.string() })
      .parse(
        await this.read(`/contents/${capacityFile}?ref=${input.sourceCommit}`),
      );
    const decoded = Buffer.from(content.content.replace(/\s/g, ''), 'base64');
    if (decoded.length > 1024) return false;
    const config = z
      .object({ worker_desired_size: z.number().int().min(1).max(2) })
      .strict()
      .parse(JSON.parse(decoded.toString('utf8')));
    return config.worker_desired_size === input.capacityDesiredWorkers;
  }
}
