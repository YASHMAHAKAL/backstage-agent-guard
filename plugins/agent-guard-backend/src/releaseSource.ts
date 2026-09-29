import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fromBuffer } from 'yauzl';
import { Config } from '@backstage/config';
import { z } from 'zod/v3';
import {
  ReleaseCatalog,
  ReleasePolicy,
  ReleaseSource,
  releaseDigest,
  releaseIdSchema,
  releaseRecordSchema,
} from './releases';

const exec = promisify(execFile);
const maxArchive = 128 * 1024;
const maxRecord = 64 * 1024;
const positiveId = z.number().int().positive().safe();
const runSchema = z.object({
  id: positiveId,
  run_attempt: positiveId,
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  head_branch: z.string(),
  path: z.string(),
  event: z.enum(['push', 'workflow_dispatch']),
  status: z.literal('completed'),
  conclusion: z.literal('success'),
  repository: z.object({ full_name: z.string(), id: positiveId }),
  head_repository: z.object({ full_name: z.string(), id: positiveId }),
});
const artifactSchema = z.object({
  id: positiveId,
  name: z.string(),
  expired: z.literal(false),
  size_in_bytes: z.number().int().positive().max(maxArchive),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expires_at: z.string().datetime(),
  workflow_run: z.object({
    id: positiveId,
    repository_id: positiveId,
    head_repository_id: positiveId,
    head_sha: z.string(),
  }),
});

// Bounded single-file parsing in memory; no archive extraction to the filesystem.
export function parseReleaseArchive(bytes: Buffer): Promise<unknown> {
  if (bytes.length > maxArchive)
    return Promise.reject(new Error('Archive too large'));
  return new Promise((resolve, reject) => {
    fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('Invalid archive'));
          return;
        }
        let settled = false;
        const fail = () => {
          if (!settled) {
            settled = true;
            zip.close();
            reject(new Error('Invalid release archive'));
          }
        };
        zip.on('error', fail);
        if (zip.entryCount !== 1) {
          fail();
          return;
        }
        zip.on('entry', entry => {
          if (
            entry.fileName !== 'release.json' ||
            entry.uncompressedSize > maxRecord ||
            entry.isEncrypted() ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          ) {
            fail();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail();
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            stream.on('error', fail);
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > maxRecord) {
                stream.destroy();
                fail();
                return;
              }
              chunks.push(chunk);
            });
            stream.on('end', () => {
              if (settled) return;
              try {
                const value: unknown = JSON.parse(
                  Buffer.concat(chunks).toString('utf8'),
                );
                settled = true;
                zip.close();
                resolve(value);
              } catch {
                fail();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > limit || !response.body) throw new Error('Invalid body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Body too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

type AwsReader = (args: string[], signal: AbortSignal) => Promise<unknown>;
export class GitHubEcrReleaseSource implements ReleaseSource {
  readonly mode = 'authenticated_ci' as const;
  private pending?: ReturnType<ReleaseSource['read']>;
  constructor(
    private readonly options: {
      policy: ReleasePolicy;
      githubToken: string;
      awsProfile: string;
      fetcher?: typeof fetch;
      awsReader?: AwsReader;
    },
  ) {
    const p = options.policy;
    const registry =
      /^([0-9]{12})\.dkr\.ecr\.us-east-1\.amazonaws\.com\/(rizz-staging-(frontend|backend))$/;
    const front = p.frontendRepository.match(registry);
    const back = p.backendRepository.match(registry);
    if (
      !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) ||
      p.ref !== 'refs/heads/master' ||
      p.workflowPath !== '.github/workflows/publish.yml' ||
      !front ||
      !back ||
      front[1] !== back[1] ||
      front[3] !== 'frontend' ||
      back[3] !== 'backend' ||
      options.awsProfile !== 'rizz-release-reader' ||
      !options.githubToken
    ) {
      throw new Error('Invalid trusted release configuration');
    }
  }
  read() {
    // Coalesce concurrent requests only, never retain a cached green response.
    if (!this.pending)
      this.pending = this.readFresh().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  resolve(releaseId: string): ReturnType<ReleaseSource['read']> {
    // Validate before making any network/CLI call or constructing a URL.
    const id = releaseIdSchema.parse(releaseId);
    return this.readFresh(id);
  }
  private async readFresh(
    releaseId?: string,
  ): ReturnType<ReleaseSource['read']> {
    const signal = AbortSignal.timeout(20000);
    const { policy } = this.options;
    const prefix = `/repos/${policy.repository}/actions`;
    const get = async (path: string, redirect = false) => {
      const response = await (this.options.fetcher ?? fetch)(
        `https://api.github.com${path}`,
        {
          headers: {
            Authorization: `Bearer ${this.options.githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
          },
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
      );
      if (redirect) {
        if (response.status !== 302) throw new Error('Artifact unavailable');
        return response;
      }
      if (!response.ok) throw new Error('GitHub unavailable');
      return JSON.parse(
        (await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8'),
      );
    };
    const aws: AwsReader =
      this.options.awsReader ??
      (async (args, operationSignal) => {
        const { stdout } = await exec(
          'aws',
          [
            ...args,
            '--profile',
            this.options.awsProfile,
            '--region',
            'us-east-1',
            '--output',
            'json',
            '--no-cli-pager',
          ],
          {
            timeout: 5000,
            maxBuffer: 2 * 1024 * 1024,
            signal: operationSignal,
            env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' },
          },
        );
        return JSON.parse(stdout);
      });
    const account = policy.frontendRepository.split('.')[0];
    const caller = z
      .object({
        Account: z.literal(account),
        Arn: z
          .string()
          .regex(
            new RegExp(
              `^arn:aws:sts::${account}:assumed-role/rizz-staging-release-reader/[A-Za-z0-9_+=,.@-]+$`,
            ),
          ),
      })
      .parse(await aws(['sts', 'get-caller-identity'], signal));
    if (!caller) throw new Error('Reader identity unavailable');
    const selected = releaseId?.split('-');
    const candidates = selected
      ? [await get(`${prefix}/runs/${selected[2]}/attempts/${selected[3]}`)]
      : z
          .object({ workflow_runs: z.array(z.unknown()).max(3) })
          .parse(
            await get(
              `${prefix}/workflows/publish.yml/runs?branch=master&status=success&per_page=3`,
            ),
          ).workflow_runs;
    const entries: Awaited<ReturnType<ReleaseSource['read']>> = [];
    for (const candidate of candidates) {
      const parsed = runSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const run = parsed.data;
      if (
        run.repository.full_name !== policy.repository ||
        run.head_repository.full_name !== policy.repository ||
        run.repository.id !== run.head_repository.id ||
        run.path !== policy.workflowPath ||
        `refs/heads/${run.head_branch}` !== policy.ref
      )
        continue;
      if (
        selected &&
        (run.head_sha !== selected[1] ||
          run.id !== Number(selected[2]) ||
          run.run_attempt !== Number(selected[3]))
      )
        throw new Error('Selected run identity mismatch');
      const artifacts = z
        .object({ artifacts: z.array(z.unknown()).max(20) })
        .parse(await get(`${prefix}/runs/${run.id}/artifacts?per_page=20`));
      const name = `rizz-release-${run.id}-${run.run_attempt}`;
      const matches = artifacts.artifacts.filter(
        a =>
          typeof a === 'object' && a !== null && 'name' in a && a.name === name,
      );
      if (!matches.length) continue;
      if (matches.length !== 1) throw new Error('Ambiguous artifact');
      const a = artifactSchema.parse(matches[0]);
      if (
        Date.parse(a.expires_at) <= Date.now() ||
        a.workflow_run.id !== run.id ||
        a.workflow_run.repository_id !== run.repository.id ||
        a.workflow_run.head_repository_id !== run.repository.id ||
        a.workflow_run.head_sha !== run.head_sha
      )
        throw new Error('Untrusted artifact');
      const jobs = z
        .object({
          jobs: z
            .array(
              z.object({
                name: z.string(),
                conclusion: z.string().nullable(),
                steps: z.array(
                  z.object({
                    name: z.string(),
                    conclusion: z.string().nullable(),
                  }),
                ),
              }),
            )
            .max(10),
        })
        .parse(
          await get(
            `${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=10`,
          ),
        );
      const publishJobs = jobs.jobs.filter(
        j => j.name === 'Publish verified release',
      );
      if (
        publishJobs.length !== 1 ||
        publishJobs[0].conclusion !== 'success' ||
        ![
          'Backend tests and dependency gate',
          'Frontend tests, build and dependency gate',
          'Build both images and run explicit mock-only integration',
          'Scan both local images (fail on HIGH or CRITICAL)',
          'Push scanned images and create release record',
          'Upload paired release record',
        ].every(step =>
          publishJobs[0].steps.some(
            s => s.name === step && s.conclusion === 'success',
          ),
        )
      )
        throw new Error('Required CI checks unavailable');
      const response: Response = await get(
        `${prefix}/artifacts/${a.id}/zip`,
        true,
      );
      const url = new URL(response.headers.get('location') ?? '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(
          /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
          /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(url.hostname)
        )
      )
        throw new Error('Unapproved artifact host');
      const download = await (this.options.fetcher ?? fetch)(url.toString(), {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!download.ok) throw new Error('Artifact unavailable');
      const bytes = await boundedBytes(download, maxArchive);
      if (
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        a.digest
      )
        throw new Error('Artifact checksum mismatch');
      const record = releaseRecordSchema.parse(
        await parseReleaseArchive(bytes),
      );
      if (
        record.workflow.runId !== run.id ||
        record.workflow.runAttempt !== run.run_attempt ||
        record.source.commit !== run.head_sha
      )
        throw new Error('Artifact identity mismatch');
      const verifiedImages: string[] = [];
      for (const component of ['frontend', 'backend'] as const) {
        const image = record.images[component];
        const repository =
          component === 'frontend'
            ? policy.frontendRepository
            : policy.backendRepository;
        if (image.repository !== repository)
          throw new Error('Unapproved registry');
        const result = z
          .object({
            failures: z.array(z.unknown()).default([]),
            images: z
              .array(
                z.object({
                  registryId: z.literal(account),
                  repositoryName: z.string(),
                  imageId: z.object({ imageDigest: z.string() }),
                  imageManifest: z.string().max(1024 * 1024),
                }),
              )
              .length(1),
          })
          .parse(
            await aws(
              [
                'ecr',
                'batch-get-image',
                '--registry-id',
                account,
                '--repository-name',
                repository.split('/')[1],
                '--image-ids',
                `imageDigest=${image.digest}`,
              ],
              signal,
            ),
          );
        const found = result.images[0];
        if (
          result.failures.length ||
          found.repositoryName !== repository.split('/')[1] ||
          found.imageId.imageDigest !== image.digest ||
          `sha256:${createHash('sha256')
            .update(found.imageManifest)
            .digest('hex')}` !== image.digest
        )
          throw new Error('Image unavailable');
        verifiedImages.push(`${repository}@${image.digest}`);
      }
      entries.push({
        record,
        evidence: {
          repository: run.repository.full_name,
          ref: `refs/heads/${run.head_branch}`,
          commit: run.head_sha,
          workflowPath: run.path,
          runId: run.id,
          runAttempt: run.run_attempt,
          conclusion: run.conclusion,
          event: run.event,
          artifactExpired: a.expired,
          artifactRecordDigest: releaseDigest(record),
          verifiedImages,
        },
      });
    }
    return entries;
  }
}

export function createReleaseCatalog(config: Config): ReleaseCatalog {
  if (!config.getOptionalBoolean('agentGuard.rizzReleases.enabled'))
    return new ReleaseCatalog();
  const c = config.getConfig('agentGuard.rizzReleases');
  const policy: ReleasePolicy = {
    repository: c.getString('repository'),
    ref: 'refs/heads/master',
    workflowPath: '.github/workflows/publish.yml',
    frontendRepository: c.getString('frontendRepository'),
    backendRepository: c.getString('backendRepository'),
  };
  return new ReleaseCatalog({
    policy,
    source: new GitHubEcrReleaseSource({
      policy,
      githubToken: c.getString('githubToken'),
      awsProfile: c.getString('awsProfile'),
    }),
  });
}
