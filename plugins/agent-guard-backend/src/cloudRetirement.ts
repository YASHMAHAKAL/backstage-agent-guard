import { z } from 'zod/v3';
import {
  cloudGitopsBaseSchema,
  inspectCloudGitopsFiles,
} from './cloudSnapshot';
import { cloudTargetSchema, CloudTarget } from './cloudTarget';
import { canonicalize, FrozenFile, sha256 } from './snapshot';
import { retirementPolicyVersion } from './cloudReviewPolicy';

export { retirementPolicyVersion } from './cloudReviewPolicy';
export const retirementInputSchema = z
  .object({
    targetId: z.literal('eks-staging'),
    declaredIntent: z.string().trim().min(20).max(2000),
    reason: z.string().trim().min(20).max(1000),
  })
  .strict();
const names = [
  'backend-deployment.yaml',
  'backend-service.yaml',
  'external-secret.yaml',
  'frontend-deployment.yaml',
  'frontend-service.yaml',
  'ingress.yaml',
  'kustomization.yaml',
  'runtime.yaml',
  'secret-store.yaml',
] as const;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const contextSchema = z
  .object({
    proposalId: z.string().uuid(),
    requester: z.string().regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/),
    submissionChannel: z.enum(['mcp_action', 'backstage_rest']),
  })
  .strict();
const cleanupEvidenceSchema = z
  .object({
    checkedAt: z.string().datetime(),
    ingressAbsent: z.literal(true),
    albAbsent: z.literal(true),
    targetGroupsAbsent: z.literal(true),
  })
  .strict();
const envelopeSchema = contextSchema
  .extend({
    schemaVersion: z.literal(4),
    kind: z.enum(['rizz_cloud_retire_ingress', 'rizz_cloud_retire_app']),
    declaredIntent: retirementInputSchema.shape.declaredIntent,
    intentSource: z.enum(['agent_supplied', 'authenticated_user_submitted']),
    reason: retirementInputSchema.shape.reason,
    policyVersion: z.literal(retirementPolicyVersion),
    target: cloudTargetSchema,
    gitopsBase: cloudGitopsBaseSchema,
    beforeFiles: z.array(z.object({ path: z.string(), sha256: hash }).strict()),
    generatedFiles: z.array(
      z.object({ path: z.string(), sha256: hash }).strict(),
    ),
    deletedPaths: z.array(z.string()),
    cleanupEvidence: cleanupEvidenceSchema.optional(),
  })
  .strict();
export type CloudRetirementSnapshot = {
  envelope: z.infer<typeof envelopeSchema>;
  digest: string;
  beforeFiles: FrozenFile[];
  files: FrozenFile[];
  deletePaths: string[];
};
const canonical = (value: unknown) =>
  canonicalize(JSON.parse(JSON.stringify(value)));
const sorted = (values: string[]) => [...values].sort();
const basename = (path: string, target: CloudTarget) =>
  path.slice(target.gitopsPath.length + 1);

/** Pure rendering. Authentication, target and cleanup evidence are checked by
 * the service that calls this with server-owned inputs. */
export function createCloudRetirementSnapshot(options: {
  input: unknown;
  context: z.infer<typeof contextSchema>;
  target: unknown;
  gitopsBase: unknown;
  contents: Record<string, string>;
  cleanupEvidence?: z.infer<typeof cleanupEvidenceSchema>;
}): CloudRetirementSnapshot {
  const input = retirementInputSchema.parse(options.input);
  const context = contextSchema.parse(options.context);
  const target = cloudTargetSchema.parse(options.target);
  const base = cloudGitopsBaseSchema.parse(options.gitopsBase);
  if (
    input.targetId !== target.id ||
    context.requester === 'user:default/guest'
  )
    throw new Error('Invalid retirement target or requester');
  const inspected = inspectCloudGitopsFiles(options.contents, target);
  if (inspected.state !== 'present' && inspected.state !== 'retiring')
    throw new Error('No supported deployment to retire');
  const phase =
    inspected.state === 'present'
      ? ('rizz_cloud_retire_ingress' as const)
      : ('rizz_cloud_retire_app' as const);
  const requiredNames =
    phase === 'rizz_cloud_retire_ingress'
      ? [...names]
      : names.filter(name => name !== 'ingress.yaml');
  if (
    canonical(sorted(Object.keys(options.contents))) !==
      canonical(sorted(requiredNames)) ||
    canonical(sorted(base.files.map(file => file.name))) !==
      canonical(sorted(requiredNames)) ||
    base.files.some(
      file => sha256(options.contents[file.name]) !== file.sha256,
    ) ||
    requiredNames.some(
      name =>
        options.contents[name] !==
        `${canonical(JSON.parse(options.contents[name]))}\n`,
    )
  )
    throw new Error('Retirement base and files disagree');
  const cleanupEvidence = options.cleanupEvidence
    ? cleanupEvidenceSchema.parse(options.cleanupEvidence)
    : undefined;
  if (
    (phase === 'rizz_cloud_retire_app' && !cleanupEvidence) ||
    (phase === 'rizz_cloud_retire_ingress' && cleanupEvidence)
  )
    throw new Error('Wrong retirement cleanup evidence');
  const beforeFiles = requiredNames.map(name => {
    const content = options.contents[name];
    return {
      path: `${target.gitopsPath}/${name}`,
      content,
      sha256: sha256(content),
    };
  });
  let files: FrozenFile[];
  let deletePaths: string[];
  if (phase === 'rizz_cloud_retire_ingress') {
    const kustomization = JSON.parse(options.contents['kustomization.yaml']);
    const after = `${canonical({
      ...kustomization,
      resources: names.filter(
        name => name !== 'ingress.yaml' && name !== 'kustomization.yaml',
      ),
    })}\n`;
    files = beforeFiles
      .filter(file => basename(file.path, target) !== 'ingress.yaml')
      .map(file =>
        basename(file.path, target) === 'kustomization.yaml'
          ? { ...file, content: after, sha256: sha256(after) }
          : file,
      );
    deletePaths = [`${target.gitopsPath}/ingress.yaml`];
  } else {
    const after = `${canonical({
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: target.namespace,
      resources: [],
    })}\n`;
    files = [
      {
        path: `${target.gitopsPath}/kustomization.yaml`,
        content: after,
        sha256: sha256(after),
      },
    ];
    deletePaths = names
      .filter(name => name !== 'ingress.yaml' && name !== 'kustomization.yaml')
      .map(name => `${target.gitopsPath}/${name}`);
  }
  const envelope = envelopeSchema.parse({
    ...context,
    schemaVersion: 4,
    kind: phase,
    declaredIntent: input.declaredIntent,
    intentSource:
      context.submissionChannel === 'mcp_action'
        ? 'agent_supplied'
        : 'authenticated_user_submitted',
    reason: input.reason,
    policyVersion: retirementPolicyVersion,
    target,
    gitopsBase: {
      ...base,
      files: [...base.files].sort((a, b) => a.name.localeCompare(b.name)),
    },
    beforeFiles: beforeFiles.map(({ path, sha256: value }) => ({
      path,
      sha256: value,
    })),
    generatedFiles: files.map(({ path, sha256: value }) => ({
      path,
      sha256: value,
    })),
    deletedPaths: deletePaths,
    ...(cleanupEvidence ? { cleanupEvidence } : {}),
  });
  return {
    envelope,
    digest: sha256(canonical(envelope)),
    beforeFiles,
    files,
    deletePaths,
  };
}

export function cloudRetirementSnapshotHasIntegrity(
  value: unknown,
): value is CloudRetirementSnapshot {
  try {
    const snapshot = value as CloudRetirementSnapshot;
    const envelope = envelopeSchema.parse(snapshot.envelope);
    const beforeFiles = z
      .array(
        z
          .object({
            path: z.string(),
            content: z.string().max(65536),
            sha256: hash,
          })
          .strict(),
      )
      .parse(snapshot.beforeFiles);
    const contents = Object.fromEntries(
      beforeFiles.map(file => [
        basename(file.path, envelope.target),
        file.content,
      ]),
    );
    const rebuilt = createCloudRetirementSnapshot({
      input: {
        targetId: envelope.target.id,
        declaredIntent: envelope.declaredIntent,
        reason: envelope.reason,
      },
      context: {
        proposalId: envelope.proposalId,
        requester: envelope.requester,
        submissionChannel: envelope.submissionChannel,
      },
      target: envelope.target,
      gitopsBase: envelope.gitopsBase,
      contents,
      cleanupEvidence: envelope.cleanupEvidence,
    });
    return canonical(value) === canonical(rebuilt);
  } catch {
    return false;
  }
}
