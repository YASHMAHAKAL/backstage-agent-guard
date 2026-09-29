import { z } from 'zod/v3';
import { cloudGitopsBaseSchema } from './cloudSnapshot';
import {
  cloudRuntimeChangeInputSchema,
  previewCloudRuntimeChange,
} from './cloudRuntimeChange';
import { CloudTarget, cloudTargetSchema } from './cloudTarget';
import { cloudTemplateSpec } from './cloudTemplate';
import { canonicalize, FrozenFile, sha256 } from './snapshot';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const contextSchema = z
  .object({
    proposalId: z.string().uuid(),
    requester: z
      .string()
      .regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/)
      .refine(value => value !== 'user:default/guest'),
    submissionChannel: z.enum(['mcp_action', 'backstage_rest']),
  })
  .strict();
const runtimeState = z
  .object({
    state: z.literal('present'),
    frontendImage: z.string(),
    backendImage: z.string(),
    frontendReplicas: z.number().int().min(1).max(2),
    backendReplicas: z.number().int().min(1).max(2),
    geminiModel: z.string(),
    frontendExposure: z.literal('restricted_alb_https'),
    backendExposure: z.literal('clusterip'),
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string().min(1).max(300),
    content: z.string().max(65536),
    sha256: hash,
  })
  .strict();
const canonical = (value: unknown) =>
  canonicalize(JSON.parse(JSON.stringify(value)));
const templateDigest = sha256(canonical(cloudTemplateSpec));
import {
  applicationReviewPolicy,
  applicationReviewerGroups,
  cloudReviewerGroupsSchema,
  legacyRuntimePolicy,
  reviewPolicyFieldsValid,
} from './cloudReviewPolicy';

const envelopeSchema = contextSchema
  .extend({
    schemaVersion: z.literal(2),
    kind: z.literal('rizz_cloud_runtime_change'),
    declaredIntent: cloudRuntimeChangeInputSchema.shape.declaredIntent,
    intentSource: z.enum(['agent_supplied', 'authenticated_user_submitted']),
    target: cloudTargetSchema,
    template: z
      .object({
        id: z.literal('deploy-rizz-ai'),
        version: z.literal('rizz-paired-v1-restricted-alb'),
        digest: hash,
      })
      .strict(),
    policyVersion: z.enum([legacyRuntimePolicy, applicationReviewPolicy]),
    reviewerGroups: cloudReviewerGroupsSchema,
    patch: cloudRuntimeChangeInputSchema.shape.patch,
    gitopsBase: cloudGitopsBaseSchema,
    before: runtimeState,
    after: runtimeState,
    changedFields: z
      .array(z.enum(['frontendReplicas', 'backendReplicas']))
      .min(1)
      .max(2),
    generatedFiles: z
      .array(z.object({ path: z.string(), sha256: hash }).strict())
      .length(9),
  })
  .strict()
  .refine(reviewPolicyFieldsValid, 'Invalid reviewer policy fields');

export type CloudRuntimeEnvelope = z.infer<typeof envelopeSchema>;
export interface CloudRuntimeSnapshot {
  envelope: CloudRuntimeEnvelope;
  digest: string;
  baselineFiles: FrozenFile[];
  files: FrozenFile[];
}

/** A candidate, not approval. Only authenticated service code may supply the
 * pinned Git tree and user context; this function does not establish either. */
export function createCloudRuntimeSnapshot(options: {
  input: unknown;
  context: z.infer<typeof contextSchema>;
  target: CloudTarget;
  gitopsBase: unknown;
  contents: unknown;
  policyVersion?: typeof legacyRuntimePolicy | typeof applicationReviewPolicy;
}): CloudRuntimeSnapshot {
  const input = cloudRuntimeChangeInputSchema.parse(options.input);
  const context = contextSchema.parse(options.context);
  const target = cloudTargetSchema.parse(options.target);
  const preview = previewCloudRuntimeChange({
    input,
    target,
    base: options.gitopsBase,
    contents: options.contents,
  });
  if (preview.changedFields.length === 0)
    throw new Error('Runtime change is a no-op');
  const original = z.record(z.string().max(65536)).parse(options.contents);
  const baselineFiles = Object.keys(original)
    .sort()
    .map(name => ({
      path: `${target.gitopsPath}/${name}`,
      content: original[name],
      sha256: sha256(original[name]),
    }));
  const envelope: CloudRuntimeEnvelope = {
    ...context,
    schemaVersion: 2,
    kind: 'rizz_cloud_runtime_change',
    declaredIntent: input.declaredIntent,
    intentSource:
      context.submissionChannel === 'mcp_action'
        ? 'agent_supplied'
        : 'authenticated_user_submitted',
    target,
    template: {
      id: 'deploy-rizz-ai',
      version: 'rizz-paired-v1-restricted-alb',
      digest: templateDigest,
    },
    policyVersion: options.policyVersion ?? applicationReviewPolicy,
    ...((options.policyVersion ?? applicationReviewPolicy) ===
    applicationReviewPolicy
      ? {
          reviewerGroups: [
            applicationReviewerGroups[0],
            applicationReviewerGroups[1],
          ] as const,
        }
      : {}),
    patch: input.patch,
    gitopsBase: {
      ...preview.base,
      files: [...preview.base.files].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    },
    before: runtimeState.parse(preview.before),
    after: runtimeState.parse(preview.after),
    changedFields: preview.changedFields,
    generatedFiles: preview.files.map(({ path, sha256: value }) => ({
      path,
      sha256: value,
    })),
  };
  return {
    envelope,
    digest: sha256(canonical(envelope)),
    baselineFiles,
    files: preview.files,
  };
}

export function cloudRuntimeSnapshotHasIntegrity(
  value: unknown,
): value is CloudRuntimeSnapshot {
  try {
    const snapshot = z
      .object({
        envelope: envelopeSchema,
        digest: hash,
        baselineFiles: z.array(fileSchema).length(9),
        files: z.array(fileSchema).length(9),
      })
      .strict()
      .parse(value);
    const target = snapshot.envelope.target;
    const contents = Object.fromEntries(
      snapshot.baselineFiles.map(file => [
        file.path.slice(target.gitopsPath.length + 1),
        file.content,
      ]),
    );
    const rebuilt = createCloudRuntimeSnapshot({
      input: {
        operation: 'runtime_change',
        declaredIntent: snapshot.envelope.declaredIntent,
        targetId: target.id,
        patch: snapshot.envelope.patch,
      },
      context: {
        proposalId: snapshot.envelope.proposalId,
        requester: snapshot.envelope.requester,
        submissionChannel: snapshot.envelope.submissionChannel,
      },
      target,
      gitopsBase: snapshot.envelope.gitopsBase,
      contents,
      policyVersion: snapshot.envelope.policyVersion,
    });
    return canonical(snapshot) === canonical(rebuilt);
  } catch {
    return false;
  }
}

export function revalidateCloudRuntimeSnapshot(
  snapshot: unknown,
  options: { target: CloudTarget; gitopsBase: unknown; contents: unknown },
): { valid: true } | { valid: false; reason: string } {
  try {
    if (!cloudRuntimeSnapshotHasIntegrity(snapshot))
      return { valid: false, reason: 'snapshot_integrity_failed' };
    if (
      canonical(cloudTargetSchema.parse(options.target)) !==
      canonical(snapshot.envelope.target)
    )
      return { valid: false, reason: 'target_changed' };
    const base = cloudGitopsBaseSchema.parse(options.gitopsBase);
    if (
      canonical({
        ...base,
        files: [...base.files].sort((a, b) => a.name.localeCompare(b.name)),
      }) !== canonical(snapshot.envelope.gitopsBase)
    )
      return { valid: false, reason: 'gitops_base_changed' };
    const contents = z.record(z.string().max(65536)).parse(options.contents);
    if (
      Object.keys(contents).length !== base.files.length ||
      base.files.some(
        file =>
          !(file.name in contents) ||
          sha256(contents[file.name]) !== file.sha256,
      )
    )
      return { valid: false, reason: 'runtime_baseline_changed' };
    const rebuilt = createCloudRuntimeSnapshot({
      input: {
        operation: 'runtime_change',
        declaredIntent: snapshot.envelope.declaredIntent,
        targetId: snapshot.envelope.target.id,
        patch: snapshot.envelope.patch,
      },
      context: {
        proposalId: snapshot.envelope.proposalId,
        requester: snapshot.envelope.requester,
        submissionChannel: snapshot.envelope.submissionChannel,
      },
      target: options.target,
      gitopsBase: base,
      contents,
      policyVersion: snapshot.envelope.policyVersion,
    });
    if (canonical(rebuilt) !== canonical(snapshot))
      return { valid: false, reason: 'runtime_baseline_changed' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'revalidation_unavailable' };
  }
}
