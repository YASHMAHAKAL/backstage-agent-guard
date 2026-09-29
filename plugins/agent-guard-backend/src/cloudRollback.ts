import { z } from 'zod/v3';
import { FrozenFile, canonicalize } from './snapshot';

export const cloudRollbackInputSchema = z
  .object({
    operation: z.literal('rollback'),
    declaredIntent: z.string().trim().min(12).max(1000),
    targetId: z.literal('eks-staging'),
    verifiedDeploymentId: z.string().uuid(),
  })
  .strict();

export const cloudRollbackSourceSchema = z
  .object({
    verifiedDeploymentId: z.string().uuid(),
    snapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mergeRevision: z.string().regex(/^[a-f0-9]{40}$/),
    verifiedAt: z.string().datetime(),
  })
  .strict();

/** Permit only paired image/replica restoration. Routing, secret references,
 * resources and every other byte must match the retained healthy recipe. */
export function rollbackPreservesProtectedConfiguration(options: {
  current: Record<string, string>;
  restored: FrozenFile[];
  gitopsPath: string;
}): boolean {
  try {
    const desired = Object.fromEntries(
      options.restored.map(file => [
        file.path.slice(options.gitopsPath.length + 1),
        file.content,
      ]),
    );
    if (
      Object.keys(options.current).length !== 9 ||
      Object.keys(desired).length !== 9 ||
      Object.keys(desired).some(name => !(name in options.current))
    )
      return false;
    for (const [name, content] of Object.entries(desired)) {
      if (
        name !== 'frontend-deployment.yaml' &&
        name !== 'backend-deployment.yaml'
      ) {
        if (options.current[name] !== content) return false;
        continue;
      }
      const before = JSON.parse(options.current[name]);
      const after = JSON.parse(content);
      if (
        !Array.isArray(before?.spec?.template?.spec?.containers) ||
        before.spec.template.spec.containers.length !== 1 ||
        !Array.isArray(after?.spec?.template?.spec?.containers) ||
        after.spec.template.spec.containers.length !== 1
      )
        return false;
      before.spec.replicas = after.spec.replicas;
      before.spec.template.spec.containers[0].image =
        after.spec.template.spec.containers[0].image;
      if (canonicalize(before) !== canonicalize(after)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
