import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import {
  cloudDeliveryFixture,
  releaseFixtureEnvelope,
} from './cloudDeliveryFixture';
import { createCloudFrozenSnapshot } from '../cloudSnapshot';

export function temporaryCertificate(hostname: string, ca = false) {
  const directory = mkdtempSync(join(tmpdir(), 'rizz-tls-test-'));
  const keyPath = join(directory, 'fixture.key');
  const certPath = join(directory, 'fixture.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname}`,
      '-addext',
      `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}`,
      '-addext',
      ca
        ? 'keyUsage=critical,keyCertSign,cRLSign'
        : 'keyUsage=critical,digitalSignature,keyEncipherment',
      ...(ca ? [] : ['-addext', 'extendedKeyUsage=serverAuth']),
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  const pem = readFileSync(certPath, 'utf8');
  return {
    directory,
    pem,
    key: readFileSync(keyPath, 'utf8'),
    fingerprint: `sha256:${createHash('sha256')
      .update(new X509Certificate(pem).raw)
      .digest('hex')}`,
  };
}

export function runtimeFixture(pem: string) {
  const proposal = cloudDeliveryFixture();
  const envelope = releaseFixtureEnvelope(proposal);
  const target = structuredClone(envelope.target);
  target.ingress.certificateSha256 = `sha256:${createHash('sha256')
    .update(new X509Certificate(pem).raw)
    .digest('hex')}`;
  proposal.snapshot = createCloudFrozenSnapshot({
    now: Date.parse(envelope.release.record.createdAt),
    target,
    context: {
      proposalId: proposal.id,
      requester: proposal.requester,
      submissionChannel: envelope.submissionChannel,
    },
    proposal: {
      templateId: 'deploy-rizz-ai',
      declaredIntent: envelope.declaredIntent,
      inputs: envelope.inputs,
    },
    release: { state: 'verified', ...envelope.release },
    gitopsBase: envelope.gitopsBase,
  });
  proposal.decision!.digest = proposal.snapshot.digest;
  const objects: Record<
    'frontend' | 'backend',
    { deployment: any; sets: any; pods: any }
  > = {} as any;
  for (const part of ['frontend', 'backend'] as const) {
    const name = `rizz-${part}`;
    const deployment = JSON.parse(
      proposal.snapshot.files.find(file =>
        file.path.endsWith(`/${part}-deployment.yaml`),
      )!.content,
    );
    const replicas = envelope.inputs[`${part}Replicas`];
    deployment.metadata = {
      ...deployment.metadata,
      uid: `${part}-deployment-uid`,
      generation: 3,
    };
    deployment.status = {
      observedGeneration: 3,
      replicas,
      updatedReplicas: replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      conditions: [
        { type: 'Progressing', status: 'True' },
        { type: 'Available', status: 'True' },
      ],
    };
    const parent = {
      apiVersion: 'apps/v1',
      controller: true,
      kind: 'Deployment',
      name,
      uid: deployment.metadata.uid,
    };
    const set = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        namespace: target.namespace,
        name: `${name}-hash`,
        uid: `${part}-rs-uid`,
        generation: 2,
        ownerReferences: [parent],
      },
      spec: { replicas, template: structuredClone(deployment.spec.template) },
      status: {
        observedGeneration: 2,
        replicas,
        readyReplicas: replicas,
        availableReplicas: replicas,
      },
    };
    const pods = Array.from({ length: replicas }, (_, index) => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        namespace: target.namespace,
        name: `${name}-pod-${index}`,
        uid: `${part}-pod-${index}-uid`,
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            controller: true,
            kind: 'ReplicaSet',
            name: set.metadata.name,
            uid: set.metadata.uid,
          },
        ],
      },
      spec: structuredClone(deployment.spec.template.spec),
      status: {
        phase: 'Running',
        conditions: [
          { type: 'Ready', status: 'True' },
          { type: 'ContainersReady', status: 'True' },
        ],
        containerStatuses: [
          {
            name: part,
            image: deployment.spec.template.spec.containers[0].image,
            imageID: `containerd://${envelope.release.record.images[part].digest}`,
            ready: true,
            started: true,
            state: { running: { startedAt: '2026-09-27T00:00:00Z' } },
          },
        ],
      },
    }));
    objects[part] = {
      deployment,
      sets: { metadata: {}, items: [set] },
      pods: { metadata: {}, items: pods },
    };
  }
  const singleManifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      digest: `sha256:${'0'.repeat(64)}`,
      size: 123,
      mediaType: 'application/vnd.oci.image.config.v1+json',
    },
    layers: [],
  };
  const wiring = Object.fromEntries(
    proposal.snapshot.files
      .filter(
        file =>
          !file.path.includes('-deployment.yaml') &&
          !file.path.endsWith('/kustomization.yaml'),
      )
      .map(file => {
        const value = JSON.parse(file.content);
        if (['ExternalSecret', 'SecretStore'].includes(value.kind))
          value.status = { conditions: [{ type: 'Ready', status: 'True' }] };
        return [value.kind, value.kind === 'Service' ? null : value];
      })
      .filter(([, value]) => value !== null),
  );
  wiring['rizz-frontend-service'] = JSON.parse(
    proposal.snapshot.files.find(file =>
      file.path.endsWith('/frontend-service.yaml'),
    )!.content,
  );
  wiring['rizz-backend-service'] = JSON.parse(
    proposal.snapshot.files.find(file =>
      file.path.endsWith('/backend-service.yaml'),
    )!.content,
  );
  return { proposal, target, objects, singleManifest, wiring };
}
