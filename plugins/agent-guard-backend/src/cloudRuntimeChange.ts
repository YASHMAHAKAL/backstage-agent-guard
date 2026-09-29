import { z } from 'zod/v3';
import {
  cloudGitopsBaseSchema,
  inspectCloudGitopsFiles,
} from './cloudSnapshot';
import { CloudTarget, cloudTargetSchema } from './cloudTarget';
import { canonicalize, FrozenFile, sha256 } from './snapshot';

const replicas = z.number().int().min(1).max(2);

/** A runtime request never accepts images, manifests, model settings or target
 * connection details. This contract is not an executable proposal on its own. */
export const cloudRuntimeChangeInputSchema = z
  .object({
    operation: z.literal('runtime_change'),
    declaredIntent: z.string().trim().min(12).max(1000),
    targetId: z.literal('eks-staging'),
    patch: z
      .object({
        frontendReplicas: replicas.optional(),
        backendReplicas: replicas.optional(),
      })
      .strict()
      .refine(value => Object.keys(value).length > 0, 'Empty runtime patch'),
  })
  .strict();

const fileContents = z.record(z.string().max(65536));

/** Pure preview over bytes supplied by an authenticated, pinned GitOps reader.
 * Caller must separately establish identity, target and runtime evidence, then
 * bind this result to a versioned approval before any publisher can use it. */
export function previewCloudRuntimeChange(options: {
  input: unknown;
  target: CloudTarget;
  base: unknown;
  contents: unknown;
}): {
  base: z.infer<typeof cloudGitopsBaseSchema>;
  before: Extract<
    ReturnType<typeof inspectCloudGitopsFiles>,
    { state: 'present' }
  >;
  after: Extract<
    ReturnType<typeof inspectCloudGitopsFiles>,
    { state: 'present' }
  >;
  changedFields: Array<'frontendReplicas' | 'backendReplicas'>;
  files: FrozenFile[];
} {
  const input = cloudRuntimeChangeInputSchema.parse(options.input);
  const target = cloudTargetSchema.parse(options.target);
  if (input.targetId !== target.id) throw new Error('Runtime target mismatch');
  const base = cloudGitopsBaseSchema.parse(options.base);
  const contents = fileContents.parse(options.contents);
  const names = Object.keys(contents).sort();
  if (
    names.length !== base.files.length ||
    base.files.some(
      file =>
        !(file.name in contents) || sha256(contents[file.name]) !== file.sha256,
    )
  )
    throw new Error('Runtime GitOps files differ from pinned base');
  const before = inspectCloudGitopsFiles(contents, target);
  if (before.state !== 'present')
    throw new Error('Runtime change requires an existing complete deployment');

  const next = { ...contents };
  const changedFields: Array<'frontendReplicas' | 'backendReplicas'> = [];
  for (const part of ['frontend', 'backend'] as const) {
    const field = `${part}Replicas` as const;
    const requested = input.patch[field];
    if (requested === undefined || requested === before[field]) continue;
    const name = `${part}-deployment.yaml`;
    const deployment = JSON.parse(contents[name]);
    deployment.spec.replicas = requested;
    next[name] = `${canonicalize(deployment)}\n`;
    changedFields.push(field);
  }
  const after = inspectCloudGitopsFiles(next, target);
  if (after.state !== 'present')
    throw new Error('Runtime change produced an incomplete deployment');
  const files = names.map(name => ({
    path: `${target.gitopsPath}/${name}`,
    content: next[name],
    sha256: sha256(next[name]),
  }));
  return { base, before, after, changedFields, files };
}
