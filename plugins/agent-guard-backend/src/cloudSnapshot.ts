import { z } from 'zod/v3';
import { cloudProposalInputSchema, CloudProposalInput } from './cloudDomain';
import {
  CloudTarget,
  cloudTargetSchema,
  renderCloudIngress,
} from './cloudTarget';
import {
  ReleaseCatalog,
  ReleaseResolution,
  releaseDigest,
  releaseRecordSchema,
} from './releases';
import { canonicalize, FrozenFile, sha256 } from './snapshot';

const templateVersion = 'rizz-paired-v1-restricted-alb';
import {
  applicationReviewPolicy,
  applicationReviewerGroups,
  cloudReviewerGroupsSchema,
  legacyReleasePolicy,
  reviewPolicyFieldsValid,
} from './cloudReviewPolicy';
import { cloudRollbackSourceSchema } from './cloudRollback';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
] as const;

export const cloudGitopsBaseSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    // Complete listing of the reviewed app directory, not just overwritten files.
    files: z
      .array(z.object({ name: z.enum(filenames), sha256: hash }).strict())
      .max(filenames.length),
  })
  .strict()
  .refine(
    base => new Set(base.files.map(f => f.name)).size === base.files.length,
    'Duplicate base paths',
  );
export type CloudGitopsBase = z.infer<typeof cloudGitopsBaseSchema>;

const contextSchema = z
  .object({
    proposalId: z.string().uuid(),
    requester: z
      .string()
      .regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/)
      .refine(
        value => value !== 'user:default/guest',
        'Guest is not a cloud requester',
      ),
    submissionChannel: z.enum(['mcp_action', 'backstage_rest']),
  })
  .strict();

// Reuse the existing canonical serializer without changing old local hashes.
const canonical = (value: unknown): string =>
  canonicalize(JSON.parse(JSON.stringify(value)));
const sortedBase = (value: unknown): CloudGitopsBase => {
  const base = cloudGitopsBaseSchema.parse(value);
  return {
    ...base,
    files: base.files.sort((a, b) => a.name.localeCompare(b.name)),
  };
};

const runtime = {
  NODE_ENV: 'production',
  PORT: '3000',
  GEMINI_MODEL: 'gemini-3.1-flash-lite',
  PROVIDER_TIMEOUT_MS: '25000',
  MAX_CONCURRENT_REQUESTS: '2',
  REQUESTS_PER_MINUTE: '10',
  MAX_PROVIDER_CALLS: '100',
};

function resources(
  proposal: {
    inputs: Pick<
      CloudProposalInput['inputs'],
      'frontendReplicas' | 'backendReplicas'
    >;
  },
  target: CloudTarget,
  release: {
    images: Record<
      'frontend' | 'backend',
      { repository: string; digest: string }
    >;
  },
) {
  const metadata = (name: string) => ({ name, namespace: target.namespace });
  const objects: Record<string, unknown> = {};
  for (const part of ['frontend', 'backend'] as const) {
    const name = `rizz-${part}`;
    const labels = {
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/part-of': 'rizz-ai',
      'backstage.io/kubernetes-id': name,
    };
    const front = part === 'frontend';
    const env = ['GEN_AI_KEY', 'DEMO_USERNAME', 'DEMO_PASSWORD'].map(
      (key, index) => ({
        name: key,
        valueFrom: {
          secretKeyRef: {
            name: 'rizz-runtime-secrets',
            key: ['gen-ai-key', 'demo-username', 'demo-password'][index],
          },
        },
      }),
    );
    objects[`${part}-deployment.yaml`] = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { ...metadata(name), labels },
      spec: {
        replicas: front
          ? proposal.inputs.frontendReplicas
          : proposal.inputs.backendReplicas,
        revisionHistoryLimit: 2,
        progressDeadlineSeconds: 120,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
        },
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 40,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: front ? 101 : 1000,
              runAsGroup: front ? 101 : 1000,
              fsGroup: front ? 101 : 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: part,
                image: `${release.images[part].repository}@${release.images[part].digest}`,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'http', containerPort: front ? 8080 : 3000 }],
                ...(!front
                  ? {
                      envFrom: [{ configMapRef: { name: 'rizz-runtime' } }],
                      env,
                    }
                  : {}),
                resources: {
                  requests: {
                    cpu: front ? '50m' : '100m',
                    memory: front ? '32Mi' : '128Mi',
                  },
                  limits: {
                    cpu: front ? '250m' : '500m',
                    memory: front ? '128Mi' : '256Mi',
                  },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                startupProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  periodSeconds: 2,
                  failureThreshold: 30,
                },
                livenessProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  periodSeconds: 10,
                },
                readinessProbe: {
                  httpGet: { path: '/readyz', port: 'http' },
                  periodSeconds: 5,
                },
                ...(front
                  ? {
                      lifecycle: {
                        preStop: { exec: { command: ['nginx', '-s', 'quit'] } },
                      },
                    }
                  : {}),
                volumeMounts: [{ name: 'temporary', mountPath: '/tmp' }],
              },
            ],
            volumes: [{ name: 'temporary', emptyDir: { sizeLimit: '32Mi' } }],
          },
        },
      },
    };
    objects[`${part}-service.yaml`] = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        ...metadata(`${name}-service`),
        labels: { 'backstage.io/kubernetes-id': name },
      },
      spec: {
        type: 'ClusterIP',
        selector: { 'app.kubernetes.io/name': name },
        ports: [{ name: 'http', port: front ? 80 : 3000, targetPort: 'http' }],
      },
    };
  }
  objects['runtime.yaml'] = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: metadata('rizz-runtime'),
    data: runtime,
  };
  objects['secret-store.yaml'] = {
    apiVersion: 'external-secrets.io/v1',
    kind: 'SecretStore',
    metadata: metadata('rizz-runtime'),
    spec: {
      provider: { aws: { service: 'SecretsManager', region: target.region } },
    },
  };
  objects['external-secret.yaml'] = {
    apiVersion: 'external-secrets.io/v1',
    kind: 'ExternalSecret',
    metadata: metadata('rizz-runtime'),
    spec: {
      refreshInterval: '5m',
      secretStoreRef: { name: 'rizz-runtime', kind: 'SecretStore' },
      target: {
        name: 'rizz-runtime-secrets',
        creationPolicy: 'Owner',
        deletionPolicy: 'Retain',
      },
      data: ['gen-ai-key', 'demo-username', 'demo-password'].map(key => ({
        secretKey: key,
        remoteRef: { key: 'rizz/staging/runtime', property: key },
      })),
    },
  };
  objects['ingress.yaml'] = renderCloudIngress(target);
  objects['kustomization.yaml'] = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: target.namespace,
    resources: filenames.filter(f => f !== 'kustomization.yaml'),
  };
  return objects;
}

// Current state is derived from the SAME immutable tree as the base hashes.
// Only this platform recipe is recognized. Unsupported/custom configuration
// requires an explicit migration, never an optimistic semantic summary.
type InspectedCloudGitops =
  | { state: 'absent' }
  | { state: 'retiring' }
  | { state: 'retired' }
  | {
      state: 'present';
      frontendImage: string;
      backendImage: string;
      frontendReplicas: number;
      backendReplicas: number;
      geminiModel: string;
      frontendExposure: 'restricted_alb_https';
      backendExposure: 'clusterip';
    };
export function inspectCloudGitopsFiles(
  contents: Record<string, string>,
  target: CloudTarget,
): InspectedCloudGitops {
  cloudTargetSchema.parse(target);
  if (Object.keys(contents).length === 0) return { state: 'absent' as const };
  if (
    Object.keys(contents).length === 1 &&
    typeof contents['kustomization.yaml'] === 'string'
  ) {
    const expected = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: target.namespace,
      resources: [],
    };
    if (
      canonical(JSON.parse(contents['kustomization.yaml'])) !==
      canonical(expected)
    )
      throw new Error('Unsupported retired app marker');
    return { state: 'retired' as const };
  }
  const ingressRemoved = filenames.filter(name => name !== 'ingress.yaml');
  if (
    Object.keys(contents).sort().join('|') ===
    [...ingressRemoved].sort().join('|')
  ) {
    const withoutIngress = filenames.filter(
      name => name !== 'ingress.yaml' && name !== 'kustomization.yaml',
    );
    const kustomization = JSON.parse(contents['kustomization.yaml']);
    if (
      canonical(kustomization) !==
      canonical({
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        namespace: target.namespace,
        resources: withoutIngress,
      })
    )
      throw new Error('Unsupported retirement kustomization');
    const restored = {
      ...contents,
      'ingress.yaml': `${canonical(renderCloudIngress(target))}\n`,
      'kustomization.yaml': `${canonical({
        ...kustomization,
        resources: filenames.filter(name => name !== 'kustomization.yaml'),
      })}\n`,
    };
    const original = inspectCloudGitopsFiles(restored, target);
    if (original.state !== 'present')
      throw new Error('Unsupported retirement baseline');
    return { state: 'retiring' as const };
  }
  if (
    Object.keys(contents).sort().join('|') !== [...filenames].sort().join('|')
  )
    throw new Error('Incomplete or unsupported cloud directory');
  const deployment = z.object({
    spec: z.object({
      replicas: z.number().int().min(1).max(2),
      template: z.object({
        spec: z.object({
          containers: z.array(z.object({ image: z.string() })).length(1),
        }),
      }),
    }),
  });
  const observed = (['frontend', 'backend'] as const).map(part => {
    const value = deployment.parse(
      JSON.parse(contents[`${part}-deployment.yaml`]),
    );
    const image = value.spec.template.spec.containers[0].image;
    const prefix = `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-${part}@`;
    if (
      !image.startsWith(prefix) ||
      !/^sha256:[a-f0-9]{64}$/.test(image.slice(prefix.length))
    )
      throw new Error('Unsupported current image');
    return {
      replicas: value.spec.replicas,
      image,
      repository: prefix.slice(0, -1),
      digest: image.slice(prefix.length),
    };
  });
  const [front, back] = observed;
  const expected = resources(
    {
      inputs: {
        frontendReplicas: front.replicas,
        backendReplicas: back.replicas,
      },
    },
    target,
    { images: { frontend: front, backend: back } },
  );
  for (const name of filenames) {
    if (canonical(JSON.parse(contents[name])) !== canonical(expected[name]))
      throw new Error('Unsupported current cloud configuration');
  }
  return {
    state: 'present' as const,
    frontendImage: front.image,
    backendImage: back.image,
    frontendReplicas: front.replicas,
    backendReplicas: back.replicas,
    geminiModel: runtime.GEMINI_MODEL,
    frontendExposure: 'restricted_alb_https' as const,
    backendExposure: 'clusterip' as const,
  };
}

const cloudEnvelopeSchema = contextSchema
  .extend({
    schemaVersion: z.union([z.literal(1), z.literal(3)]),
    kind: z.enum(['rizz_cloud_release', 'rizz_cloud_rollback']),
    declaredIntent: cloudProposalInputSchema.shape.declaredIntent,
    intentSource: z.enum(['agent_supplied', 'authenticated_user_submitted']),
    inputs: cloudProposalInputSchema.shape.inputs,
    template: z
      .object({
        id: z.literal('deploy-rizz-ai'),
        version: z.literal(templateVersion),
        digest: hash,
      })
      .strict(),
    policyVersion: z.enum([legacyReleasePolicy, applicationReviewPolicy]),
    reviewerGroups: cloudReviewerGroupsSchema,
    rollbackSource: cloudRollbackSourceSchema.optional(),
    target: cloudTargetSchema,
    release: z
      .object({ record: releaseRecordSchema, recordDigest: hash })
      .strict(),
    gitopsBase: cloudGitopsBaseSchema,
    generatedFiles: z
      .array(z.object({ path: z.string(), sha256: hash }).strict())
      .length(filenames.length),
  })
  .strict()
  .refine(reviewPolicyFieldsValid, 'Invalid reviewer policy fields')
  .refine(
    value =>
      value.kind === 'rizz_cloud_rollback'
        ? value.schemaVersion === 3 &&
          value.policyVersion === applicationReviewPolicy &&
          value.rollbackSource !== undefined
        : value.schemaVersion === 1 && value.rollbackSource === undefined,
    'Invalid cloud operation version',
  );
export type CloudApprovalEnvelope = z.infer<typeof cloudEnvelopeSchema>;
export interface CloudFrozenSnapshot {
  envelope: CloudApprovalEnvelope;
  digest: string;
  files: FrozenFile[];
}

/** Pure backend building block; callers supply authenticated server context and
 * freshly resolved evidence. This function does NOT establish their authority. */
export function createCloudFrozenSnapshot(options: {
  proposal: unknown;
  context: z.infer<typeof contextSchema>;
  target: unknown;
  release: Extract<ReleaseResolution, { state: 'verified' }>;
  gitopsBase: unknown;
  now?: number;
  policyVersion?: typeof legacyReleasePolicy | typeof applicationReviewPolicy;
  rollbackSource?: z.infer<typeof cloudRollbackSourceSchema>;
}): CloudFrozenSnapshot {
  const proposal = cloudProposalInputSchema.parse(options.proposal);
  const context = contextSchema.parse(options.context);
  const target = cloudTargetSchema.parse(options.target);
  const base = sortedBase(options.gitopsBase);
  const record = releaseRecordSchema.parse(options.release.record);
  const recordDigest = releaseDigest(record);
  const now = options.now ?? Date.now();
  const rollbackSource = options.rollbackSource
    ? cloudRollbackSourceSchema.parse(options.rollbackSource)
    : undefined;
  if (rollbackSource && options.policyVersion === legacyReleasePolicy)
    throw new Error('Rollback cannot use the historical review policy');
  if (
    options.release.state !== 'verified' ||
    recordDigest !== options.release.recordDigest ||
    recordDigest !== proposal.inputs.releaseRecordDigest ||
    record.releaseId !== proposal.inputs.releaseId ||
    record.releaseId !==
      `rizz-${record.source.commit}-${record.workflow.runId}-${record.workflow.runAttempt}` ||
    record.source.repository !== target.sourceRepository ||
    record.source.ref !== 'refs/heads/master' ||
    record.workflow.path !== '.github/workflows/publish.yml' ||
    Date.parse(record.createdAt) > now ||
    Date.parse(record.createdAt) >= Date.parse(record.expiresAt) ||
    Date.parse(record.expiresAt) <= now ||
    (['frontend', 'backend'] as const).some(
      part =>
        record.images[part].sourceCommit !== record.source.commit ||
        record.images[part].repository !==
          `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-${part}`,
    )
  ) {
    throw new Error(
      'Resolved release does not match the selected target and record.',
    );
  }
  const rendered = resources(proposal, target, record);
  const files = filenames.map(name => {
    // JSON is valid YAML; canonical bytes avoid presentation-dependent hashes.
    const content = `${canonical(rendered[name])}\n`;
    return {
      path: `${target.gitopsPath}/${name}`,
      content,
      sha256: sha256(content),
    };
  });
  const envelope: CloudApprovalEnvelope = {
    ...context,
    schemaVersion: rollbackSource ? 3 : 1,
    kind: rollbackSource ? 'rizz_cloud_rollback' : 'rizz_cloud_release',
    declaredIntent: proposal.declaredIntent,
    intentSource:
      context.submissionChannel === 'mcp_action'
        ? 'agent_supplied'
        : 'authenticated_user_submitted',
    inputs: proposal.inputs,
    template: {
      id: 'deploy-rizz-ai',
      version: templateVersion,
      // Hash the rendered recipe with normalized replica counts, including its
      // bound target/image pair, not only the template's friendly name.
      digest: sha256(
        canonical(
          resources(
            {
              ...proposal,
              inputs: {
                ...proposal.inputs,
                frontendReplicas: 1,
                backendReplicas: 1,
              },
            },
            target,
            record,
          ),
        ),
      ),
    },
    policyVersion: options.policyVersion ?? applicationReviewPolicy,
    ...(rollbackSource ? { rollbackSource } : {}),
    ...((options.policyVersion ?? applicationReviewPolicy) ===
    applicationReviewPolicy
      ? {
          reviewerGroups: [
            applicationReviewerGroups[0],
            applicationReviewerGroups[1],
          ] as const,
        }
      : {}),
    target,
    release: { record, recordDigest },
    gitopsBase: base,
    generatedFiles: files.map(({ path, sha256: value }) => ({
      path,
      sha256: value,
    })),
  };
  return { envelope, digest: sha256(canonical(envelope)), files };
}

export function cloudSnapshotHasIntegrity(
  value: unknown,
): value is CloudFrozenSnapshot {
  try {
    const snapshot = z
      .object({
        envelope: cloudEnvelopeSchema,
        digest: hash,
        files: z
          .array(
            z
              .object({
                path: z.string(),
                content: z.string().max(65536),
                sha256: hash,
              })
              .strict(),
          )
          .length(filenames.length),
      })
      .strict()
      .parse(value);
    const rebuilt = createCloudFrozenSnapshot({
      context: {
        proposalId: snapshot.envelope.proposalId,
        requester: snapshot.envelope.requester,
        submissionChannel: snapshot.envelope.submissionChannel,
      },
      proposal: {
        declaredIntent: snapshot.envelope.declaredIntent,
        templateId: 'deploy-rizz-ai',
        inputs: snapshot.envelope.inputs,
      },
      target: snapshot.envelope.target,
      release: { state: 'verified', ...snapshot.envelope.release },
      gitopsBase: snapshot.envelope.gitopsBase,
      policyVersion: snapshot.envelope.policyVersion,
      rollbackSource: snapshot.envelope.rollbackSource,
      // Integrity is independent of current expiry; freshness is checked below.
      now: Date.parse(snapshot.envelope.release.record.createdAt),
    });
    return canonical(snapshot) === canonical(rebuilt);
  } catch {
    return false;
  }
}

/** Preconditions only, NOT approval, target authorization or task authority.
 * Future executor must also freshly verify AWS/ACM/SG identity and state. */
export async function revalidateCloudSnapshot(
  snapshot: unknown,
  options: {
    releases: ReleaseCatalog;
    target: unknown;
    gitopsBase: unknown;
  },
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    if (!cloudSnapshotHasIntegrity(snapshot))
      return { valid: false, reason: 'snapshot_integrity_failed' };
    if (
      canonical(cloudTargetSchema.parse(options.target)) !==
      canonical(snapshot.envelope.target)
    )
      return { valid: false, reason: 'target_changed' };
    // Conservative first version: any main-branch movement forces a new review.
    if (
      canonical(sortedBase(options.gitopsBase)) !==
      canonical(snapshot.envelope.gitopsBase)
    )
      return { valid: false, reason: 'gitops_base_changed' };
    const release = await options.releases.resolve(
      snapshot.envelope.inputs.releaseId,
      snapshot.envelope.release.recordDigest,
    );
    if (release.state !== 'verified')
      return { valid: false, reason: release.reason };
    if (
      canonical(release.record) !== canonical(snapshot.envelope.release.record)
    )
      return { valid: false, reason: 'release_changed' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'revalidation_unavailable' };
  }
}
