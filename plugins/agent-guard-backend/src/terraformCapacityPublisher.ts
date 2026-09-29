import { z } from 'zod/v3';

export const capacityFile =
  'infra/aws/environments/staging/capacity.auto.tfvars.json';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const workers = z.number().int().min(1).max(2);
const capacityFileSchema = z.object({ worker_desired_size: workers }).strict();
const refSchema = z.object({ object: z.object({ sha }) });
const contentSchema = z.object({
  type: z.literal('file'),
  sha,
  encoding: z.literal('base64'),
  content: z.string(),
});

export type CapacityBaseline = {
  mainSha: string;
  fileSha: string;
  workers: number;
};
export type CapacityPr = {
  url: string;
  headCommit: string;
  baseCommit: string;
};
export interface TerraformCapacityPublisher {
  readBaseline(): Promise<CapacityBaseline>;
  publish(input: {
    requestId: string;
    requester: string;
    desiredWorkers: number;
    baseline: CapacityBaseline;
  }): Promise<CapacityPr>;
}

/** Backend-owned, single-file GitHub publisher. The deterministic branch makes
 * an ambiguous HTTP retry recoverable; a changed branch is never overwritten.
 * This creates a configuration PR only, never a Terraform execution. */
export class GitHubTerraformCapacityPublisher
  implements TerraformCapacityPublisher
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
      throw new Error('Invalid Terraform capacity publisher configuration');
  }

  private async call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    allowMissing = false,
  ): Promise<unknown | null> {
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.github.com/repos/${this.options.owner}/${this.options.repo}${path}`,
      {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (allowMissing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `GitHub Terraform capacity request failed (${response.status})`,
      );
    const content = await response.text();
    if (Buffer.byteLength(content) > 256 * 1024)
      throw new Error('GitHub Terraform capacity response is too large');
    return JSON.parse(content) as unknown;
  }

  private async fileAt(ref: string) {
    const data = contentSchema.parse(
      await this.call(
        'GET',
        `/contents/${capacityFile}?ref=${encodeURIComponent(ref)}`,
      ),
    );
    const decoded = Buffer.from(data.content.replace(/\s/g, ''), 'base64');
    if (decoded.length > 1024)
      throw new Error('Capacity configuration is unexpectedly large');
    const parsed = capacityFileSchema.parse(
      JSON.parse(decoded.toString('utf8')),
    );
    return { fileSha: data.sha, workers: parsed.worker_desired_size };
  }

  async readBaseline(): Promise<CapacityBaseline> {
    const main = refSchema.parse(await this.call('GET', '/git/ref/heads/main'));
    return {
      mainSha: main.object.sha,
      ...(await this.fileAt(main.object.sha)),
    };
  }

  async publish(input: {
    requestId: string;
    requester: string;
    desiredWorkers: number;
    baseline: CapacityBaseline;
  }): Promise<CapacityPr> {
    const requestId = z.string().uuid().parse(input.requestId);
    const desiredWorkers = workers.parse(input.desiredWorkers);
    const baseline = z
      .object({ mainSha: sha, fileSha: sha, workers })
      .strict()
      .parse(input.baseline);
    if (baseline.workers === desiredWorkers)
      throw new Error('Capacity request is a no-op');
    const branch = `agent-guard/terraform-capacity-${requestId}`;
    const existing = await this.call(
      'GET',
      `/git/ref/heads/${branch}`,
      undefined,
      true,
    );
    if (!existing) {
      const main = await this.readBaseline();
      if (
        main.mainSha !== baseline.mainSha ||
        main.fileSha !== baseline.fileSha ||
        main.workers !== baseline.workers
      )
        throw new Error('Capacity baseline changed; submit a new request');
      await this.call('POST', '/git/refs', {
        ref: `refs/heads/${branch}`,
        sha: baseline.mainSha,
      });
    }
    const branchRef = refSchema.parse(
      await this.call('GET', `/git/ref/heads/${branch}`),
    );
    if (branchRef.object.sha === baseline.mainSha) {
      await this.call('PUT', `/contents/${capacityFile}`, {
        message: `chore(terraform): set staging workers to ${desiredWorkers}`,
        content: Buffer.from(
          `${JSON.stringify(
            { worker_desired_size: desiredWorkers },
            null,
            2,
          )}\n`,
        ).toString('base64'),
        sha: baseline.fileSha,
        branch,
      });
    }
    const compare = z
      .object({
        files: z.array(z.object({ filename: z.string(), status: z.string() })),
      })
      .parse(
        await this.call(
          'GET',
          `/compare/${baseline.mainSha}...${encodeURIComponent(branch)}`,
        ),
      );
    if (
      compare.files.length !== 1 ||
      compare.files[0].filename !== capacityFile ||
      compare.files[0].status !== 'modified' ||
      (await this.fileAt(branch)).workers !== desiredWorkers
    )
      throw new Error(
        'Capacity branch no longer contains the exact bounded change',
      );
    const currentHead = refSchema.parse(
      await this.call('GET', `/git/ref/heads/${branch}`),
    ).object.sha;
    const pulls = z
      .array(
        z.object({
          html_url: z.string().url(),
          state: z.enum(['open', 'closed']),
          head: z.object({ sha }),
          base: z.object({ ref: z.string() }),
        }),
      )
      .parse(
        await this.call(
          'GET',
          `/pulls?state=all&head=${encodeURIComponent(
            `${this.options.owner}:${branch}`,
          )}&base=main&per_page=10`,
        ),
      );
    if (
      pulls.length > 1 ||
      (pulls.length === 1 && pulls[0].head.sha !== currentHead)
    )
      throw new Error('Capacity pull request has changed unexpectedly');
    if (pulls.length === 1) {
      if (pulls[0].state !== 'open' || pulls[0].base.ref !== 'main')
        throw new Error('Capacity pull request is no longer open');
      return {
        url: pulls[0].html_url,
        headCommit: currentHead,
        baseCommit: baseline.mainSha,
      };
    }
    const created = z
      .object({ html_url: z.string().url(), head: z.object({ sha }) })
      .parse(
        await this.call('POST', '/pulls', {
          title: `Rizz.AI staging capacity: ${baseline.workers} → ${desiredWorkers} workers`,
          body: `Agent Guard infrastructure request: ${requestId}\nRequester: ${input.requester}\nOnly ${capacityFile} may change. Merge is configuration review, not Terraform plan approval or apply.`,
          head: branch,
          base: 'main',
          maintainer_can_modify: false,
        }),
      );
    if (created.head.sha !== currentHead)
      throw new Error(
        'Created capacity PR head differs from the reviewed branch',
      );
    return {
      url: created.html_url,
      headCommit: currentHead,
      baseCommit: baseline.mainSha,
    };
  }
}
