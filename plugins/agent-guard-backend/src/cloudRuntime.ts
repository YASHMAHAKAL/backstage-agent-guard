import { z } from 'zod/v3';
import { CloudFrozenSnapshot } from './cloudSnapshot';
import { CloudRuntimeSnapshot } from './cloudRuntimeSnapshot';
import { AuthenticatedCloudReaders } from './cloudReaders';
import { readCloudHttpsJson, validateSmokeCertificate } from './cloudHttps';
import { canonicalize, sha256 } from './snapshot';

export type RuntimeState =
  | 'not_configured'
  | 'not_checked'
  | 'verified'
  | 'not_ready'
  | 'mismatch'
  | 'unavailable';
export type Rollout = {
  desired: number;
  updated: number;
  available: number;
  readyPods: number;
  generation: number;
};
export type WorkloadObservation = {
  state: RuntimeState;
  reason?: string;
  frontend?: Rollout;
  backend?: Rollout;
};
export type SmokeObservation = {
  state: RuntimeState;
  reason?: string;
  health?: 'alive';
  readiness?: 'ready';
};
export interface CloudRuntimeObservation {
  workloads: WorkloadObservation;
  smoke: SmokeObservation;
}
export interface CloudRuntimeReader {
  observe(
    snapshot: CloudFrozenSnapshot | CloudRuntimeSnapshot,
    signal: AbortSignal,
  ): Promise<CloudRuntimeObservation>;
}
type Connection = { endpoint: string; ca: string; token: string };
type Readers = Pick<
  AuthenticatedCloudReaders,
  | 'verifyTarget'
  | 'readClusterConnection'
  | 'readImageManifest'
  | 'readSmokeCertificate'
>;
class RuntimeMismatch extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const count = z.number().int().nonnegative().max(100);
const uid = z.string().min(1).max(100);
const meta = z.object({
  name: z.string(),
  namespace: z.string(),
  uid,
  generation: count.optional(),
  deletionTimestamp: z.string().nullable().optional(),
  ownerReferences: z
    .array(
      z.object({
        apiVersion: z.string(),
        kind: z.string(),
        name: z.string(),
        uid,
        controller: z.boolean().optional(),
      }),
    )
    .max(5)
    .optional(),
});
const conditions = z
  .array(z.object({ type: z.string(), status: z.string() }))
  .max(25);
const jsonObject = z.record(z.unknown());
const deploymentSchema = z.object({
  apiVersion: z.literal('apps/v1'),
  kind: z.literal('Deployment'),
  metadata: meta,
  spec: jsonObject,
  status: z.object({
    observedGeneration: count,
    replicas: count,
    updatedReplicas: count,
    readyReplicas: count,
    availableReplicas: count,
    unavailableReplicas: count.optional(),
    conditions,
  }),
});
const replicaSetSchema = z.object({
  apiVersion: z.literal('apps/v1'),
  kind: z.literal('ReplicaSet'),
  metadata: meta,
  spec: z.object({ replicas: count, template: jsonObject }),
  status: z.object({
    observedGeneration: count,
    replicas: count,
    readyReplicas: count.optional(),
    availableReplicas: count.optional(),
  }),
});
const podSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('Pod'),
  metadata: meta,
  spec: jsonObject,
  status: z.object({
    phase: z.string(),
    conditions,
    containerStatuses: z
      .array(
        z.object({
          name: z.string(),
          image: z.string(),
          imageID: z.string().max(500),
          ready: z.boolean(),
          started: z.boolean().optional(),
          state: z
            .object({
              running: z
                .object({ startedAt: z.string().datetime() })
                .optional(),
            })
            .passthrough(),
        }),
      )
      .max(5),
  }),
});
// Compare all reviewed fields while allowing server defaults. Arrays must match
// exactly: extra sidecars/env/volumes cannot hide behind a subset comparison.
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => contains(actual[index], value))
    );
  if (expected && typeof expected === 'object')
    return (
      !!actual &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) =>
        contains((actual as Record<string, unknown>)[key], value),
      )
    );
  return actual === expected;
}
const active = (metadata: z.infer<typeof meta>) => !metadata.deletionTimestamp;
function owner(
  metadata: z.infer<typeof meta>,
  kind: string,
  name: string,
  parentUid: string,
) {
  const refs = metadata.ownerReferences?.filter(ref => ref.controller) ?? [];
  return (
    refs.length === 1 &&
    refs[0].apiVersion === 'apps/v1' &&
    refs[0].kind === kind &&
    refs[0].name === name &&
    refs[0].uid === parentUid
  );
}
function conditionTrue(items: z.infer<typeof conditions>, type: string) {
  const matches = items.filter(item => item.type === type);
  return matches.length === 1 && matches[0].status === 'True';
}
function noInjectedContainers(spec: Record<string, unknown>) {
  return ['initContainers', 'ephemeralContainers'].every(
    key =>
      spec[key] === undefined ||
      (Array.isArray(spec[key]) && spec[key].length === 0),
  );
}
function safePodSpec(actual: any, expected: any) {
  if (
    !contains(actual, expected) ||
    !noInjectedContainers(actual) ||
    ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace'].some(
      key => actual[key] === true,
    )
  )
    return false;
  return actual.containers.every((container: any, index: number) => {
    const reviewed = expected.containers[index];
    if (
      Object.keys(container).some(
        key =>
          !(key in reviewed) &&
          !['terminationMessagePath', 'terminationMessagePolicy'].includes(key),
      )
    )
      return false;
    const security = container.securityContext ?? {};
    if (
      security.privileged ||
      security.capabilities?.add?.length ||
      ['runAsUser', 'runAsGroup'].some(
        key => key in security && !(key in reviewed.securityContext),
      )
    )
      return false;
    return (
      canonicalize(container.resources) === canonicalize(reviewed.resources)
    );
  });
}
const manifestType = z.enum([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const indexType = z.enum([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const imageManifest = z.object({
  schemaVersion: z.literal(2),
  mediaType: manifestType,
  config: z.object({
    digest: digestSchema,
    size: z.number().int().positive(),
    mediaType: z.string(),
  }),
  layers: z
    .array(
      z.object({
        digest: digestSchema,
        size: z.number().int().nonnegative(),
        mediaType: z.string(),
      }),
    )
    .max(100),
});

export class CloudRuntimeVerifier implements CloudRuntimeReader {
  constructor(
    private readonly options: {
      readers: Readers;
      kubeRead?: (
        connection: Connection,
        path: string,
        signal: AbortSignal,
      ) => Promise<unknown>;
      smokeRead?: (
        url: URL,
        ca: string,
        fingerprint: string,
        signal: AbortSignal,
      ) => Promise<unknown>;
    },
  ) {}

  private async kube(
    connection: Connection,
    path: string,
    signal: AbortSignal,
  ) {
    if (this.options.kubeRead)
      return this.options.kubeRead(connection, path, signal);
    return readCloudHttpsJson({
      url: new URL(path, connection.endpoint),
      ca: connection.ca,
      token: connection.token,
      signal,
    });
  }
  private async smoke(
    url: URL,
    ca: string,
    fingerprint: string,
    signal: AbortSignal,
  ) {
    if (this.options.smokeRead)
      return this.options.smokeRead(url, ca, fingerprint, signal);
    return readCloudHttpsJson({
      url,
      ca,
      certificateSha256: fingerprint,
      signal,
      maxBytes: 4096,
    });
  }

  async observe(
    snapshot: CloudFrozenSnapshot | CloudRuntimeSnapshot,
    signal: AbortSignal,
  ): Promise<CloudRuntimeObservation> {
    const result: CloudRuntimeObservation = {
      workloads: { state: 'unavailable' },
      smoke: { state: 'not_checked' },
    };
    const target = snapshot.envelope.target;
    try {
      // Includes fresh account/EKS/ALB/SG/ACM evidence; smoke is not allowed to
      // turn an unexpectedly public or misbound target into verified delivery.
      await this.options.readers.verifyTarget(target, signal);
      const connection = await this.options.readers.readClusterConnection(
        target,
        signal,
      );
      const checkWiring = async () => {
        const routes: Record<string, string> = {
          'frontend-service.yaml':
            '/api/v1/namespaces/rizz-staging/services/rizz-frontend-service',
          'backend-service.yaml':
            '/api/v1/namespaces/rizz-staging/services/rizz-backend-service',
          'runtime.yaml':
            '/api/v1/namespaces/rizz-staging/configmaps/rizz-runtime',
          'ingress.yaml':
            '/apis/networking.k8s.io/v1/namespaces/rizz-staging/ingresses/rizz-frontend',
          'secret-store.yaml':
            '/apis/external-secrets.io/v1/namespaces/rizz-staging/secretstores/rizz-runtime',
          'external-secret.yaml':
            '/apis/external-secrets.io/v1/namespaces/rizz-staging/externalsecrets/rizz-runtime',
        };
        await Promise.all(
          Object.entries(routes).map(async ([filename, path]) => {
            const expected = JSON.parse(
              snapshot.files.find(file => file.path.endsWith(`/${filename}`))!
                .content,
            );
            const actual: any = await this.kube(connection, path, signal);
            if (
              !contains(actual, expected) ||
              actual.metadata?.deletionTimestamp
            )
              throw new RuntimeMismatch('live_configuration_mismatch');
            if (
              filename === 'runtime.yaml' &&
              (canonicalize(actual.data) !== canonicalize(expected.data) ||
                actual.binaryData)
            )
              throw new RuntimeMismatch('live_runtime_config_mismatch');
            if (
              filename.endsWith('-service.yaml') &&
              (actual.spec.externalIPs?.length || actual.spec.externalName)
            )
              throw new RuntimeMismatch('live_service_exposure_mismatch');
            if (
              filename === 'ingress.yaml' &&
              Object.keys(actual.metadata.annotations ?? {}).some(
                key =>
                  key.startsWith('alb.ingress.kubernetes.io/') &&
                  !(key in expected.metadata.annotations),
              )
            )
              throw new RuntimeMismatch('live_ingress_configuration_mismatch');
            if (
              filename === 'secret-store.yaml' &&
              canonicalize(actual.spec.provider) !==
                canonicalize(expected.spec.provider)
            )
              throw new RuntimeMismatch('live_secret_source_mismatch');
            if (
              filename === 'external-secret.yaml' &&
              (actual.spec.dataFrom?.length || actual.spec.target.template)
            )
              throw new RuntimeMismatch('live_secret_source_mismatch');
            if (
              filename === 'secret-store.yaml' ||
              filename === 'external-secret.yaml'
            ) {
              if (
                !conditionTrue(
                  conditions.parse(actual.status?.conditions),
                  'Ready',
                )
              )
                throw new RuntimeMismatch('secret_sync_not_ready');
            }
          }),
        );
      };
      await checkWiring();
      const manifests = new Map<string, Promise<unknown>>(); // This observation only.
      const readManifest = (part: 'frontend' | 'backend', digest: string) => {
        const key = `${part}:${digest}`;
        if (!manifests.has(key))
          manifests.set(
            key,
            this.options.readers.readImageManifest(
              target,
              part,
              digest,
              signal,
            ),
          );
        return manifests.get(key)!;
      };
      const verifyImage = async (
        part: 'frontend' | 'backend',
        runtimeId: string,
      ) => {
        const image =
          snapshot.envelope.kind === 'rizz_cloud_runtime_change'
            ? (() => {
                const reference = snapshot.envelope.after[`${part}Image`];
                const [repository, digest] = reference.split('@');
                return { repository, digest };
              })()
            : snapshot.envelope.release.record.images[part];
        const escapedRepo = image.repository.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );
        const runtime = new RegExp(
          `^(?:(?:containerd|docker-pullable|docker)://)?(?:${escapedRepo}@)?(sha256:[a-f0-9]{64})$`,
        ).exec(runtimeId)?.[1];
        if (!runtime) throw new RuntimeMismatch('runtime_image_id_invalid');
        const parent = await readManifest(part, image.digest);
        if (imageManifest.safeParse(parent).success) {
          if (runtime !== image.digest)
            throw new RuntimeMismatch('runtime_image_mismatch');
          return;
        }
        const index = z
          .object({
            schemaVersion: z.literal(2),
            mediaType: indexType,
            manifests: z
              .array(
                z.object({
                  digest: digestSchema,
                  size: z.number().int().positive(),
                  mediaType: manifestType,
                  platform: z.object({
                    os: z.string(),
                    architecture: z.string(),
                  }),
                }),
              )
              .min(1)
              .max(20),
          })
          .parse(parent);
        // Some runtimes report the pulled index; others report its platform
        // manifest. Attestation/config/layer digests are not executable children.
        if (runtime === image.digest) return;
        const child = index.manifests.filter(
          entry =>
            entry.digest === runtime &&
            entry.platform.os === 'linux' &&
            ['amd64', 'arm64'].includes(entry.platform.architecture),
        );
        if (child.length !== 1)
          throw new RuntimeMismatch('runtime_image_mismatch');
        const raw = await readManifest(part, runtime);
        if (!imageManifest.safeParse(raw).success)
          throw new RuntimeMismatch('runtime_manifest_invalid');
      };
      const checkPart = async (part: 'frontend' | 'backend') => {
        const name = `rizz-${part}`;
        const expected = JSON.parse(
          snapshot.files.find(file =>
            file.path.endsWith(`/${part}-deployment.yaml`),
          )!.content,
        );
        const replicas =
          snapshot.envelope.kind === 'rizz_cloud_runtime_change'
            ? snapshot.envelope.after[`${part}Replicas`]
            : snapshot.envelope.inputs[`${part}Replicas`];
        const namespace = `/namespaces/${encodeURIComponent(target.namespace)}`;
        const selector = `?labelSelector=${encodeURIComponent(
          `app.kubernetes.io/name=${name}`,
        )}&limit=25`;
        const [rawDeployment, rawSets, rawPods] = await Promise.all([
          this.kube(
            connection,
            `/apis/apps/v1${namespace}/deployments/${name}`,
            signal,
          ),
          this.kube(
            connection,
            `/apis/apps/v1${namespace}/replicasets${selector}`,
            signal,
          ),
          this.kube(connection, `/api/v1${namespace}/pods${selector}`, signal),
        ]);
        const deployment = deploymentSchema.parse(rawDeployment);
        const list = <T extends z.ZodTypeAny>(schema: T, raw: unknown) =>
          z
            .object({
              metadata: z.object({
                continue: z.literal('').optional(),
                remainingItemCount: z.literal(0).optional(),
              }),
              items: z.array(schema).max(25),
            })
            .parse(raw).items as Array<z.infer<T>>;
        const sets = list(replicaSetSchema, rawSets);
        const pods = list(podSchema, rawPods);
        if (
          deployment.metadata.name !== name ||
          deployment.metadata.namespace !== target.namespace ||
          !active(deployment.metadata) ||
          deployment.spec.paused === true ||
          !noInjectedContainers(expected.spec.template.spec) ||
          !contains(deployment.spec, expected.spec) ||
          !safePodSpec(
            (deployment.spec.template as { spec: Record<string, unknown> })
              .spec,
            expected.spec.template.spec,
          )
        )
          throw new RuntimeMismatch('deployment_spec_mismatch');
        const status = deployment.status;
        const generation = deployment.metadata.generation;
        if (
          !generation ||
          status.observedGeneration < generation ||
          status.replicas !== replicas ||
          status.updatedReplicas !== replicas ||
          status.availableReplicas !== replicas ||
          status.readyReplicas !== replicas ||
          (status.unavailableReplicas ?? 0) !== 0 ||
          !conditionTrue(status.conditions, 'Available') ||
          !conditionTrue(status.conditions, 'Progressing') ||
          status.conditions.some(
            item => item.type === 'ReplicaFailure' && item.status === 'True',
          )
        )
          throw new RuntimeMismatch('deployment_rollout_incomplete');
        if (
          new Set(sets.map(set => set.metadata.uid)).size !== sets.length ||
          new Set(pods.map(pod => pod.metadata.uid)).size !== pods.length ||
          sets.some(
            set =>
              set.metadata.namespace !== target.namespace ||
              !owner(set.metadata, 'Deployment', name, deployment.metadata.uid),
          )
        )
          throw new RuntimeMismatch('workload_ownership_mismatch');
        const current = sets.filter(
          set => set.spec.replicas > 0 || set.status.replicas > 0,
        );
        if (
          current.length !== 1 ||
          !active(current[0].metadata) ||
          !contains(current[0].spec.template, expected.spec.template) ||
          current[0].spec.replicas !== replicas ||
          current[0].status.replicas !== replicas ||
          current[0].status.readyReplicas !== replicas ||
          current[0].status.availableReplicas !== replicas ||
          !current[0].metadata.generation ||
          current[0].status.observedGeneration <
            current[0].metadata.generation ||
          pods.length !== replicas
        )
          throw new RuntimeMismatch('replicaset_rollout_incomplete');
        const set = current[0];
        for (const pod of pods) {
          if (
            pod.metadata.namespace !== target.namespace ||
            !active(pod.metadata) ||
            !owner(
              pod.metadata,
              'ReplicaSet',
              set.metadata.name,
              set.metadata.uid,
            ) ||
            !safePodSpec(pod.spec, expected.spec.template.spec)
          )
            throw new RuntimeMismatch('pod_spec_or_ownership_mismatch');
          if (
            pod.status.phase !== 'Running' ||
            !conditionTrue(pod.status.conditions, 'Ready') ||
            !conditionTrue(pod.status.conditions, 'ContainersReady') ||
            pod.status.containerStatuses.length !== 1
          )
            throw new RuntimeMismatch('pod_not_ready');
          const container = pod.status.containerStatuses[0];
          if (
            container.name !== part ||
            container.image !==
              expected.spec.template.spec.containers[0].image ||
            !container.ready ||
            container.started !== true ||
            !container.state.running ||
            Object.keys(container.state).some(key => key !== 'running')
          )
            throw new RuntimeMismatch('container_not_ready_or_mismatched');
          await verifyImage(part, container.imageID);
        }
        return {
          summary: {
            desired: replicas,
            updated: status.updatedReplicas,
            available: status.availableReplicas,
            readyPods: pods.length,
            generation,
          },
          identity: {
            deployment: deployment.metadata.uid,
            generation,
            set: set.metadata.uid,
            pods: pods
              .map(pod => ({
                uid: pod.metadata.uid,
                imageID: pod.status.containerStatuses[0].imageID,
              }))
              .sort((a, b) => a.uid.localeCompare(b.uid)),
          },
        };
      };
      const before = await Promise.all([
        checkPart('frontend'),
        checkPart('backend'),
      ]);
      result.workloads = {
        state: 'verified',
        frontend: before[0].summary,
        backend: before[1].summary,
      };
      result.smoke = { state: 'unavailable' };
      try {
        const pem = await this.options.readers.readSmokeCertificate(
          target,
          signal,
        );
        validateSmokeCertificate(
          pem,
          target.ingress.hostname,
          target.ingress.certificateSha256,
        );
        const health = await this.smoke(
          new URL(`https://${target.ingress.hostname}/healthz`),
          pem,
          target.ingress.certificateSha256,
          signal,
        );
        z.object({ status: z.literal('alive') })
          .strict()
          .parse(health);
        const ready = await this.smoke(
          new URL(`https://${target.ingress.hostname}/readyz`),
          pem,
          target.ingress.certificateSha256,
          signal,
        );
        z.object({ status: z.literal('ready') })
          .strict()
          .parse(ready);
        result.smoke = {
          state: 'verified',
          health: 'alive',
          readiness: 'ready',
        };
      } catch {
        result.smoke = {
          state: 'unavailable',
          reason: 'https_readiness_or_certificate_failed',
        };
      }
      // Bracket smoke with live workload reads. A rollout during the check must
      // not mix old ready Pods with the readiness response of a different release.
      const after = await Promise.all([
        checkPart('frontend'),
        checkPart('backend'),
      ]);
      await checkWiring();
      if (
        sha256(canonicalize(before as any)) !==
        sha256(canonicalize(after as any))
      )
        throw new RuntimeMismatch('workloads_changed_during_observation');
      await this.options.readers.verifyTarget(target, signal);
      return result;
    } catch (error) {
      const reason =
        error instanceof RuntimeMismatch
          ? error.reason
          : 'cloud_runtime_read_unavailable';
      return {
        workloads: {
          state: error instanceof RuntimeMismatch ? 'not_ready' : 'unavailable',
          reason,
        },
        smoke: { state: 'not_checked' },
      };
    }
  }
}
