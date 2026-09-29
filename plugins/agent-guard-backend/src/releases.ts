import { z } from 'zod/v3';
import { canonicalize, sha256 } from './snapshot';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const releaseIdSchema = z
  .string()
  .max(100)
  .regex(/^rizz-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$/)
  .refine(value => {
    const [, , run, attempt] = value.split('-');
    return [run, attempt].every(part => Number.isSafeInteger(Number(part)));
  }, 'Run and attempt must be safe integers');
const image = z
  .object({
    repository: z.string().min(1).max(200),
    digest,
    sourceCommit: commit,
  })
  .strict();

// This schema describes data, not trust. Only a backend-owned source may
// provide the separately verified evidence; callers cannot upload records.
export const releaseRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: releaseIdSchema,
    source: z
      .object({
        repository: z.string().max(200),
        commit,
        ref: z.string().max(100),
      })
      .strict(),
    workflow: z
      .object({
        path: z.string().max(200),
        runId: z.number().int().positive().safe(),
        runAttempt: z.number().int().positive().safe(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    checks: z
      .object({
        tests: z.literal('passed'),
        scan: z.literal('passed'),
        policyVersion: z.literal('rizz-build-v1-high-critical'),
      })
      .strict(),
    images: z.object({ frontend: image, backend: image }).strict(),
  })
  .strict();

export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
export function releaseDigest(record: ReleaseRecord): string {
  return sha256(canonicalize(record));
}

export interface ReleasePolicy {
  repository: string;
  ref: string;
  workflowPath: string;
  frontendRepository: string;
  backendRepository: string;
}

export interface ReleaseEvidence {
  // The adapter derives these from authenticated CI/registry APIs,
  // never from fields in the JSON record or from agent arguments.
  repository: string;
  ref: string;
  commit: string;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  conclusion: string;
  event: string;
  artifactExpired: boolean;
  artifactRecordDigest: string;
  verifiedImages: string[];
}

export function checkRelease(
  raw: unknown,
  evidence: ReleaseEvidence,
  policy: ReleasePolicy,
  now = Date.now(),
):
  | { eligible: true; record: ReleaseRecord; recordDigest: string }
  | { eligible: false; reason: string } {
  const parsed = releaseRecordSchema.safeParse(raw);
  if (!parsed.success) return { eligible: false, reason: 'invalid_record' };
  const r = parsed.data;
  const recordDigest = releaseDigest(r);
  if (
    r.releaseId !==
    `rizz-${r.source.commit}-${r.workflow.runId}-${r.workflow.runAttempt}`
  )
    return { eligible: false, reason: 'release_identity_mismatch' };
  if (evidence.artifactExpired || Date.parse(r.expiresAt) <= now)
    return { eligible: false, reason: 'release_expired' };
  if (
    Date.parse(r.createdAt) > now ||
    Date.parse(r.createdAt) >= Date.parse(r.expiresAt)
  )
    return { eligible: false, reason: 'invalid_lifetime' };
  if (
    r.source.repository !== policy.repository ||
    r.source.ref !== policy.ref ||
    r.workflow.path !== policy.workflowPath ||
    evidence.repository !== policy.repository ||
    evidence.ref !== policy.ref ||
    evidence.workflowPath !== policy.workflowPath ||
    evidence.commit !== r.source.commit ||
    evidence.runId !== r.workflow.runId ||
    evidence.runAttempt !== r.workflow.runAttempt ||
    evidence.conclusion !== 'success' ||
    !['push', 'workflow_dispatch'].includes(evidence.event)
  )
    return { eligible: false, reason: 'untrusted_workflow' };
  if (evidence.artifactRecordDigest !== recordDigest)
    return { eligible: false, reason: 'record_integrity_mismatch' };
  for (const component of ['frontend', 'backend'] as const) {
    const img = r.images[component];
    const allowed =
      component === 'frontend'
        ? policy.frontendRepository
        : policy.backendRepository;
    if (
      !/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9_/-]*$/.test(
        allowed,
      ) ||
      img.repository !== allowed
    )
      return { eligible: false, reason: 'unapproved_registry' };
    if (img.sourceCommit !== r.source.commit)
      return { eligible: false, reason: 'image_pair_mismatch' };
    if (!evidence.verifiedImages.includes(`${img.repository}@${img.digest}`))
      return { eligible: false, reason: 'image_unavailable' };
  }
  return { eligible: true, record: r, recordDigest };
}

export interface ReleaseSource {
  mode: 'authenticated_ci' | 'fixture';
  read(): Promise<Array<{ record: unknown; evidence: ReleaseEvidence }>>;
  // Exact lookup is deliberately separate from the small recent-release list.
  resolve?(releaseId: string): ReturnType<ReleaseSource['read']>;
}

export type ReleaseResolution =
  | { state: 'verified'; record: ReleaseRecord; recordDigest: string }
  | { state: 'unavailable'; reason: string };

// Not connected to cloud proposals or Scaffolder. Production defaults to an
// empty, unconfigured source unless the operator explicitly enables the adapter.
export class ReleaseCatalog {
  constructor(
    private readonly options:
      | { policy: ReleasePolicy; source: ReleaseSource; now?: () => number }
      | undefined = undefined,
  ) {}

  /** Backend-only resolution. Not an execution/approval permission. */
  async resolve(
    releaseId: unknown,
    expectedDigest: unknown,
  ): Promise<ReleaseResolution> {
    const id = releaseIdSchema.safeParse(releaseId);
    const expected = digest.safeParse(expectedDigest);
    if (!id.success || !expected.success)
      return { state: 'unavailable', reason: 'invalid_release_selection' };
    if (!this.options)
      return {
        state: 'unavailable',
        reason: 'trusted_publisher_not_connected',
      };
    const { policy, source } = this.options;
    if (source.mode !== 'authenticated_ci' || !source.resolve)
      return { state: 'unavailable', reason: 'trusted_resolver_not_connected' };
    try {
      // Re-fetch independent evidence every time, including execution-time
      // revalidation. Neither a list result nor an old approval is a cache.
      const entries = await source.resolve(id.data);
      if (entries.length !== 1)
        return { state: 'unavailable', reason: 'release_missing_or_ambiguous' };
      const checked = checkRelease(
        entries[0].record,
        entries[0].evidence,
        policy,
        this.options.now?.() ?? Date.now(),
      );
      if (!checked.eligible)
        return { state: 'unavailable', reason: checked.reason };
      if (
        checked.record.releaseId !== id.data ||
        checked.recordDigest !== expected.data
      )
        return { state: 'unavailable', reason: 'release_selection_changed' };
      return {
        state: 'verified',
        record: checked.record,
        recordDigest: checked.recordDigest,
      };
    } catch {
      return { state: 'unavailable', reason: 'release_source_unavailable' };
    }
  }

  async list() {
    if (!this.options)
      return {
        state: 'not_configured' as const,
        reason: 'trusted_publisher_not_connected',
        items: [],
      };
    const { policy, source } = this.options;
    try {
      const entries = await source.read();
      if (entries.length > 50) throw new Error('Bounded source required');
      const checked = entries.map(entry =>
        checkRelease(
          entry.record,
          entry.evidence,
          policy,
          this.options!.now?.() ?? Date.now(),
        ),
      );
      const records = checked.filter(
        (r): r is Extract<typeof r, { eligible: true }> => r.eligible,
      );
      const ids = records.map(r => r.record.releaseId);
      if (new Set(ids).size !== ids.length)
        throw new Error('Ambiguous release IDs');
      return {
        state:
          source.mode === 'fixture'
            ? ('fixture' as const)
            : ('available' as const),
        items: records.map(r => ({
          releaseId: r.record.releaseId,
          sourceCommit: r.record.source.commit,
          createdAt: r.record.createdAt,
          expiresAt: r.record.expiresAt,
          recordDigest: r.recordDigest,
          images: r.record.images,
          // Fixture evidence can never become an executable release.
          eligibleForProposal: source.mode === 'authenticated_ci',
        })),
        rejectedCount: checked.length - records.length,
      };
    } catch {
      // No cached green response, secrets, or raw provider errors.
      return {
        state: 'unavailable' as const,
        reason: 'release_source_unavailable',
        items: [],
      };
    }
  }
}
