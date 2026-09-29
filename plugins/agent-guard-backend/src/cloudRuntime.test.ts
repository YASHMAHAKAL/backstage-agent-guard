import { rmSync } from 'node:fs';
import { CloudRuntimeVerifier } from './cloudRuntime';
import {
  temporaryCertificate,
  runtimeFixture,
} from './testFixtures/cloudRuntimeFixture';
import {
  cloudDeliveryFixture,
  releaseFixtureEnvelope,
} from './testFixtures/cloudDeliveryFixture';
import { createCloudRuntimeSnapshot } from './cloudRuntimeSnapshot';
import { CloudFrozenSnapshot } from './cloudSnapshot';
import { sha256 } from './snapshot';

let certificate: ReturnType<typeof temporaryCertificate>;
beforeAll(() => {
  certificate = temporaryCertificate(
    cloudDeliveryFixture().snapshot.envelope.target.ingress.hostname,
  );
});
afterAll(() => rmSync(certificate.directory, { recursive: true, force: true }));
function setup() {
  const s = runtimeFixture(certificate.pem);
  const readers = {
    verifyTarget: jest.fn().mockResolvedValue(undefined),
    readClusterConnection: jest.fn().mockResolvedValue({
      endpoint: 'https://fixture.us-east-1.eks.amazonaws.com',
      ca: 'fixture-ca',
      token: 'fixture-short-lived-token',
    }),
    readSmokeCertificate: jest.fn().mockResolvedValue(certificate.pem),
    readImageManifest: jest.fn().mockResolvedValue(s.singleManifest),
  };
  const kubeRead = jest
    .fn()
    .mockImplementation(async (_connection, path: string) => {
      const url = new URL(path, 'https://fixture.invalid');
      expect(url.pathname).toContain('/namespaces/rizz-staging/');
      const kind = url.pathname.split('/').at(-2);
      const kinds: Record<string, string> = {
        configmaps: 'ConfigMap',
        ingresses: 'Ingress',
        secretstores: 'SecretStore',
        externalsecrets: 'ExternalSecret',
        services: url.pathname.split('/').at(-1)!,
      };
      if (kind! in kinds) return structuredClone(s.wiring[kinds[kind!]]);
      const part = `${
        url.searchParams.get('labelSelector') ?? url.pathname
      }`.includes('rizz-frontend')
        ? 'frontend'
        : 'backend';
      if (url.pathname.endsWith('/replicasets'))
        return structuredClone(s.objects[part].sets);
      if (url.pathname.endsWith('/pods'))
        return structuredClone(s.objects[part].pods);
      if (url.pathname.endsWith(`/deployments/rizz-${part}`))
        return structuredClone(s.objects[part].deployment);
      throw new Error('Unexpected Kubernetes path');
    });
  const smokeRead = jest.fn().mockImplementation(async (url: URL) => ({
    status: url.pathname === '/healthz' ? 'alive' : 'ready',
  }));
  const options = { readers, kubeRead, smokeRead };
  return {
    ...s,
    readers,
    kubeRead,
    smokeRead,
    options,
    verify: () =>
      new CloudRuntimeVerifier(options).observe(
        s.proposal.snapshot as CloudFrozenSnapshot,
        new AbortController().signal,
      ),
  };
}
it('verifies both exact rollouts, running images and two TLS readiness GETs without inference', async () => {
  const s = setup();
  const result = await s.verify();
  expect(result.workloads).toMatchObject({
    state: 'verified',
    frontend: { desired: 1, readyPods: 1 },
    backend: { desired: 2, readyPods: 2 },
  });
  expect(result.smoke).toEqual({
    state: 'verified',
    health: 'alive',
    readiness: 'ready',
  });
  expect(s.kubeRead).toHaveBeenCalledTimes(24);
  expect(s.smokeRead.mock.calls.map(call => call[0].toString())).toEqual([
    `https://${s.target.ingress.hostname}/healthz`,
    `https://${s.target.ingress.hostname}/readyz`,
  ]);
  expect(s.readers.readImageManifest).toHaveBeenCalledTimes(2); // Per-observation dedup only.
  expect(JSON.stringify(result)).not.toContain('fixture-short-lived-token');
});
it('does not treat the old rollout as verification of an approved runtime replica change', async () => {
  const s = setup();
  const target = s.proposal.snapshot.envelope.target;
  const contents = Object.fromEntries(
    s.proposal.snapshot.files.map(file => [
      file.path.slice(target.gitopsPath.length + 1),
      file.content,
    ]),
  );
  const runtime = createCloudRuntimeSnapshot({
    input: {
      operation: 'runtime_change',
      declaredIntent: 'Increase only frontend replicas to two in EKS staging.',
      targetId: target.id,
      patch: { frontendReplicas: 2 },
    },
    context: {
      proposalId: s.proposal.id,
      requester: s.proposal.requester,
      submissionChannel: 'backstage_rest',
    },
    target,
    gitopsBase: {
      revision: 'b'.repeat(40),
      files: Object.entries(contents).map(([name, content]) => ({
        name,
        sha256: sha256(content),
      })),
    },
    contents,
  });
  const result = await new CloudRuntimeVerifier(s.options).observe(
    runtime,
    new AbortController().signal,
  );
  expect(result.workloads.state).not.toBe('verified');
  expect(result.smoke.state).toBe('not_checked');
});
it.each([
  'generation',
  'updated',
  'available',
  'replicas',
  'paused',
  'wrongImage',
  'sidecar',
  'initContainer',
  'wrongRuntime',
  'rsOwner',
  'podOwner',
  'orphan',
  'terminating',
  'notRunning',
  'notReady',
  'containerNotReady',
  'wrongNamespace',
  'partialList',
  'extraPod',
  'duplicatePod',
  'changedRuntimeConfig',
])('does not verify invalid rollout: %s', async issue => {
  const s = setup();
  const d = s.objects.backend.deployment;
  const p = s.objects.backend.pods.items[0];
  const rs = s.objects.backend.sets.items[0];
  if (issue === 'generation') d.status.observedGeneration = 2;
  if (issue === 'updated') d.status.updatedReplicas = 1;
  if (issue === 'available') d.status.availableReplicas = 1;
  if (issue === 'replicas') d.spec.replicas = 1;
  if (issue === 'paused') d.spec.paused = true;
  if (issue === 'wrongImage')
    d.spec.template.spec.containers[0].image = 'unreviewed:latest';
  if (issue === 'sidecar')
    p.spec.containers.push({ name: 'injected', image: 'other:latest' });
  if (issue === 'initContainer')
    p.spec.initContainers = [{ name: 'injected', image: 'other:latest' }];
  if (issue === 'wrongRuntime')
    p.status.containerStatuses[0].imageID = `containerd://sha256:${'9'.repeat(
      64,
    )}`;
  if (issue === 'rsOwner')
    rs.metadata.ownerReferences[0].uid = 'other-deployment';
  if (issue === 'podOwner')
    p.metadata.ownerReferences[0].uid = 'old-replicaset';
  if (issue === 'orphan') p.metadata.ownerReferences = [];
  if (issue === 'terminating')
    p.metadata.deletionTimestamp = '2026-09-27T12:00:00Z';
  if (issue === 'notRunning') p.status.phase = 'Pending';
  if (issue === 'notReady') p.status.conditions[0].status = 'False';
  if (issue === 'containerNotReady')
    p.status.containerStatuses[0].ready = false;
  if (issue === 'wrongNamespace') p.metadata.namespace = 'staging';
  if (issue === 'partialList')
    s.objects.backend.pods.metadata.continue = 'more';
  if (issue === 'extraPod')
    s.objects.backend.pods.items.push(structuredClone(p));
  if (issue === 'duplicatePod')
    s.objects.backend.pods.items[1].metadata.uid = p.metadata.uid;
  if (issue === 'changedRuntimeConfig')
    p.spec.containers[0].envFrom = [
      { configMapRef: { name: 'other-runtime' } },
    ];
  const result = await s.verify();
  expect(result.workloads.state).not.toBe('verified');
  expect(result.smoke.state).toBe('not_checked');
  expect(s.smokeRead).not.toHaveBeenCalled();
});
it('verifies a platform manifest only through its authenticated expected parent index', async () => {
  const s = setup();
  const child = `sha256:${'9'.repeat(64)}`;
  for (const pod of s.objects.backend.pods.items)
    pod.status.containerStatuses[0].imageID = `containerd://${child}`;
  const parent = releaseFixtureEnvelope(s.proposal).release.record.images
    .backend.digest;
  s.readers.readImageManifest.mockImplementation(
    async (_target, _part, digest) =>
      digest === parent
        ? {
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [
              {
                digest: child,
                size: 100,
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: { os: 'linux', architecture: 'amd64' },
              },
            ],
          }
        : s.singleManifest,
  );
  expect((await s.verify()).workloads.state).toBe('verified');
  expect(s.readers.readImageManifest).toHaveBeenCalledTimes(3);
});
it.each(['unrelatedChild', 'attestation', 'invalidChild'])(
  'rejects invalid parent-child relationship: %s',
  async issue => {
    const s = setup();
    const child = `sha256:${'9'.repeat(64)}`;
    for (const pod of s.objects.backend.pods.items)
      pod.status.containerStatuses[0].imageID = child;
    const parent = releaseFixtureEnvelope(s.proposal).release.record.images
      .backend.digest;
    s.readers.readImageManifest.mockImplementation(
      async (_target, _part, digest) => {
        if (digest === parent)
          return {
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [
              {
                digest:
                  issue === 'unrelatedChild'
                    ? `sha256:${'8'.repeat(64)}`
                    : child,
                size: 100,
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                platform: {
                  os: issue === 'attestation' ? 'unknown' : 'linux',
                  architecture: 'amd64',
                },
              },
            ],
          };
        if (issue === 'invalidChild' && digest === child)
          return { schemaVersion: 2, manifests: [] };
        return s.singleManifest;
      },
    );
    expect((await s.verify()).workloads.state).not.toBe('verified');
  },
);
it('rejects workload changes during the smoke check', async () => {
  const s = setup();
  s.smokeRead.mockImplementation(async (url: URL) => {
    s.objects.backend.pods.items[0].metadata.uid = 'replacement-pod';
    return { status: url.pathname === '/healthz' ? 'alive' : 'ready' };
  });
  const result = await s.verify();
  expect(result.workloads.reason).toBe('workloads_changed_during_observation');
  expect(result.smoke.state).toBe('not_checked');
});
it('invalidates delivery if the ALB/target becomes unsafe during observation', async () => {
  const s = setup();
  s.readers.verifyTarget
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('unsafe target'));
  const result = await s.verify();
  expect(result.workloads.state).toBe('unavailable');
  expect(result.smoke.state).toBe('not_checked');
});
it.each([
  'model',
  'service',
  'ingress',
  'secretSource',
  'secretNotReady',
  'command',
])('rejects live configuration drift: %s', async issue => {
  const s = setup();
  if (issue === 'model')
    s.wiring.ConfigMap.data.GEMINI_MODEL = 'unreviewed-model';
  if (issue === 'service')
    s.wiring['rizz-backend-service'].spec.externalIPs = ['203.0.113.1'];
  if (issue === 'ingress')
    s.wiring.Ingress.metadata.annotations[
      'alb.ingress.kubernetes.io/actions.extra'
    ] = 'unreviewed';
  if (issue === 'secretSource')
    s.wiring.SecretStore.spec.provider.aws.auth = {
      secretRef: { name: 'other' },
    };
  if (issue === 'secretNotReady')
    s.wiring.ExternalSecret.status.conditions[0].status = 'False';
  if (issue === 'command')
    s.objects.backend.pods.items[0].spec.containers[0].command = [
      'other-binary',
    ];
  const result = await s.verify();
  expect(result.workloads.state).not.toBe('verified');
  expect(s.smokeRead).not.toHaveBeenCalled();
});
it.each(['badCertificate', 'backendUnready', 'htmlBody', 'outage'])(
  'does not verify failing smoke evidence: %s',
  async issue => {
    const s = setup();
    if (issue === 'badCertificate')
      s.readers.readSmokeCertificate.mockResolvedValue('invalid certificate');
    if (issue === 'backendUnready')
      s.smokeRead.mockResolvedValue({ status: 'not_ready' });
    if (issue === 'htmlBody')
      s.smokeRead.mockResolvedValue('<html>healthy</html>');
    if (issue === 'outage')
      s.smokeRead.mockRejectedValue(new Error('secret-token-provider-error'));
    const result = await s.verify();
    expect(result.workloads.state).toBe('verified');
    expect(result.smoke.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret-token-provider-error');
  },
);
it.each(['target', 'cluster', 'kube', 'registry'])(
  'fails closed on reader outage: %s',
  async source => {
    const s = setup();
    if (source === 'target')
      s.readers.verifyTarget.mockRejectedValue(new Error('private'));
    if (source === 'cluster')
      s.readers.readClusterConnection.mockRejectedValue(new Error('private'));
    if (source === 'kube') s.kubeRead.mockRejectedValue(new Error('private'));
    if (source === 'registry')
      s.readers.readImageManifest.mockRejectedValue(new Error('private'));
    const result = await s.verify();
    expect(result.workloads.state).toBe('unavailable');
    expect(result.smoke.state).toBe('not_checked');
    expect(JSON.stringify(result)).not.toContain('private');
  },
);
