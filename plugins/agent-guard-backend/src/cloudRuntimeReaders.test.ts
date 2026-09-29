import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { AuthenticatedCloudReaders } from './cloudReaders';
import { cloudDeliveryFixture } from './testFixtures/cloudDeliveryFixture';
import { temporaryCertificate } from './testFixtures/cloudRuntimeFixture';

let ca: ReturnType<typeof temporaryCertificate>;
beforeAll(() => {
  ca = temporaryCertificate('fixture-ca', true);
});
afterAll(() => rmSync(ca.directory, { recursive: true, force: true }));
function setup() {
  const target = cloudDeliveryFixture().snapshot.envelope.target;
  const cluster = {
    cluster: {
      name: String(target.clusterName),
      arn: `arn:aws:eks:us-east-1:${target.accountId}:cluster/${target.clusterName}`,
      status: 'ACTIVE',
      endpoint: 'https://fixture.gr1.us-east-1.eks.amazonaws.com',
      certificateAuthority: { data: Buffer.from(ca.pem).toString('base64') },
    },
  };
  const identity = {
    Account: target.accountId,
    Arn: `arn:aws:iam::${target.accountId}:user/fixture-reader`,
  };
  const credentials = {
    kind: 'ExecCredential',
    apiVersion: 'client.authentication.k8s.io/v1beta1',
    status: {
      token: 'k8s-aws-v1.fixture',
      expirationTimestamp: new Date(Date.now() + 300000).toISOString(),
    },
  };
  const awsReader = jest.fn().mockImplementation(async args => {
    if (args[0] === 'sts') return identity;
    if (args[1] === 'describe-cluster') return cluster;
    if (args[1] === 'get-token') return credentials;
    throw new Error('Unexpected reader operation');
  });
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'fixture-not-live',
    awsReader,
  });
  return { reader, target, awsReader, identity, cluster, credentials };
}
it('resolves short-lived credentials and the verified EKS endpoint/CA, with no kubeconfig fallback', async () => {
  const s = setup();
  expect(
    await s.reader.readClusterConnection(
      s.target,
      new AbortController().signal,
    ),
  ).toMatchObject({
    endpoint: s.cluster.cluster.endpoint,
    ca: ca.pem,
    token: s.credentials.status.token,
  });
  expect(s.awsReader.mock.calls.map(call => call[0])).toEqual([
    ['sts', 'get-caller-identity'],
    ['eks', 'describe-cluster', '--name', 'rizz-eks-staging'],
    ['eks', 'get-token', '--cluster-name', 'rizz-eks-staging'],
  ]);
});
it.each([
  'root',
  'account',
  'cluster',
  'endpoint',
  'expired',
  'invalidToken',
  'invalidCa',
])('rejects untrusted cluster/credential evidence: %s', async issue => {
  const s = setup();
  if (issue === 'root')
    s.identity.Arn = `arn:aws:iam::${s.target.accountId}:root`;
  if (issue === 'account') s.identity.Account = '111111111111';
  if (issue === 'cluster') s.cluster.cluster.name = 'kind';
  if (issue === 'endpoint')
    s.cluster.cluster.endpoint = 'https://attacker.invalid';
  if (issue === 'expired')
    s.credentials.status.expirationTimestamp = new Date(
      Date.now() - 1,
    ).toISOString();
  if (issue === 'invalidToken')
    s.credentials.status.token = 'long-lived-kind-token';
  if (issue === 'invalidCa')
    s.cluster.cluster.certificateAuthority.data =
      Buffer.from('invalid').toString('base64');
  await expect(
    s.reader.readClusterConnection(s.target, new AbortController().signal),
  ).rejects.toThrow();
});
it('verifies exact registry/repository/digest and raw manifest hash before returning JSON', async () => {
  const s = setup();
  const manifest = '{"schemaVersion":2}';
  const digest = `sha256:${createHash('sha256')
    .update(manifest)
    .digest('hex')}`;
  const evidence = {
    failures: [],
    images: [
      {
        registryId: s.target.accountId,
        repositoryName: 'rizz-staging-backend',
        imageId: { imageDigest: digest },
        imageManifest: manifest,
      },
    ],
  };
  s.awsReader.mockResolvedValue(evidence);
  expect(
    await s.reader.readImageManifest(
      s.target,
      'backend',
      digest,
      new AbortController().signal,
    ),
  ).toEqual({ schemaVersion: 2 });
  evidence.images[0].imageManifest = '{"schemaVersion":1}';
  await expect(
    s.reader.readImageManifest(
      s.target,
      'backend',
      digest,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('rejects manifest evidence from another registry/repository', async () => {
  const s = setup();
  s.awsReader.mockResolvedValue({
    failures: [],
    images: [
      {
        registryId: '111111111111',
        repositoryName: 'another-image',
        imageId: { imageDigest: `sha256:${'1'.repeat(64)}` },
        imageManifest: '{}',
      },
    ],
  });
  await expect(
    s.reader.readImageManifest(
      s.target,
      'frontend',
      `sha256:${'1'.repeat(64)}`,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
