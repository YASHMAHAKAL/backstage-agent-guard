import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthenticatedCloudReaders } from './cloudReaders';
import { CloudTarget } from './cloudTarget';

const target: CloudTarget = {
  id: 'eks-staging',
  accountId: '000000000000',
  region: 'us-east-1',
  clusterName: 'rizz-eks-staging',
  namespace: 'rizz-staging',
  owner: 'group:default/platform-team',
  sourceRepository: 'example/Rizz.AI',
  gitopsRepository: 'https://github.com/example/gitops.git',
  gitopsBranch: 'main',
  gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
  argoApplication: 'rizz-ai-staging',
  ingress: {
    stage: 'ready',
    hostname: 'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com',
    operatorCidr: '203.0.113.10/32',
    certificateArn:
      'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
    certificateSha256: `sha256:${'a'.repeat(64)}`,
  },
};
let pem: string;
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-reader-test-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=fixture',
        '-addext',
        `subjectAltName=DNS:${target.ingress.hostname}`,
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-keyout',
        join(directory, 'temporary.key'),
        '-out',
        join(directory, 'temporary.crt'),
      ],
      { stdio: 'ignore' },
    );
    pem = readFileSync(join(directory, 'temporary.crt'), 'utf8');
    target.ingress.certificateSha256 = `sha256:${createHash('sha256')
      .update(new X509Certificate(pem).raw)
      .digest('hex')}`;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const signal = () => AbortSignal.timeout(5000);
function awsFixture() {
  const lb =
    'arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/rizz-staging-demo/abc';
  const listener =
    'arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/rizz-staging-demo/abc/def';
  const evidence: Record<string, any> = {
    'sts get-caller-identity': {
      Account: target.accountId,
      Arn: 'arn:aws:sts::000000000000:assumed-role/cloud-reader/session',
    },
    'eks describe-cluster': {
      cluster: {
        name: target.clusterName,
        arn: `arn:aws:eks:us-east-1:${target.accountId}:cluster/${target.clusterName}`,
        status: 'ACTIVE',
        resourcesVpcConfig: {
          vpcId: 'vpc-123abc',
          endpointPrivateAccess: true,
          endpointPublicAccess: true,
          publicAccessCidrs: [target.ingress.operatorCidr],
        },
      },
    },
    'acm describe-certificate': {
      Certificate: {
        CertificateArn: target.ingress.certificateArn,
        Status: 'ISSUED',
        Type: 'IMPORTED',
        SubjectAlternativeNames: [target.ingress.hostname],
      },
    },
    'acm get-certificate': { Certificate: pem },
    'elbv2 describe-load-balancers': {
      LoadBalancers: [
        {
          LoadBalancerArn: lb,
          LoadBalancerName: 'rizz-staging-demo',
          DNSName: target.ingress.hostname,
          Scheme: 'internet-facing',
          Type: 'application',
          IpAddressType: 'ipv4',
          VpcId: 'vpc-123abc',
          State: { Code: 'active' },
          SecurityGroups: ['sg-123abc'],
        },
      ],
    },
    'elbv2 describe-tags': {
      TagDescriptions: [
        {
          ResourceArn: lb,
          Tags: [
            { Key: 'elbv2.k8s.aws/cluster', Value: target.clusterName },
            {
              Key: 'ingress.k8s.aws/stack',
              Value: 'rizz-staging-demo',
            },
          ],
        },
      ],
    },
    'elbv2 describe-listeners': {
      Listeners: [
        {
          ListenerArn: listener,
          LoadBalancerArn: lb,
          Port: 443,
          Protocol: 'HTTPS',
          SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
          Certificates: [{ CertificateArn: target.ingress.certificateArn }],
        },
      ],
    },
    'elbv2 describe-listener-certificates': {
      Certificates: [
        { CertificateArn: target.ingress.certificateArn, IsDefault: true },
      ],
    },
    'elbv2 describe-rules': {
      Rules: [
        {
          Actions: [
            {
              Type: 'fixed-response',
              FixedResponseConfig: { StatusCode: '503' },
            },
          ],
        },
        {
          Actions: [
            {
              Type: 'fixed-response',
              FixedResponseConfig: { StatusCode: '404' },
            },
          ],
        },
      ],
    },
    'ec2 describe-security-groups': {
      SecurityGroups: [
        {
          GroupId: 'sg-123abc',
          VpcId: 'vpc-123abc',
          OwnerId: target.accountId,
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
              IpRanges: [{ CidrIp: target.ingress.operatorCidr }],
              Ipv6Ranges: [],
              PrefixListIds: [],
              UserIdGroupPairs: [],
            },
          ],
        },
      ],
    },
  };
  const awsReader = jest.fn().mockImplementation(async (args: string[]) => {
    const result = evidence[args.slice(0, 2).join(' ')];
    if (!result) throw new Error('Unknown synthetic AWS operation');
    return structuredClone(result);
  });
  return {
    evidence,
    awsReader,
    reader: new AuthenticatedCloudReaders({
      awsProfile: 'fixture-reader',
      githubToken: 'not-live',
      awsReader,
    }),
  };
}
it('reads only the pinned Argo Application CR through the EKS connection', async () => {
  const connection = {
    endpoint: 'https://cluster.us-east-1.eks.amazonaws.com',
    ca: 'fixture-ca',
    token: 'synthetic-authentication',
  };
  const kubernetesRead = jest.fn().mockResolvedValue({
    metadata: { name: 'rizz-ai-staging', namespace: 'argocd' },
  });
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'not-live',
    kubernetesRead,
  });
  const cluster = jest
    .spyOn(reader, 'readClusterConnection')
    .mockResolvedValue(connection);
  const abort = signal();
  await reader.readArgoApplication(target, abort);
  expect(cluster).toHaveBeenCalledWith(target, abort);
  expect(kubernetesRead).toHaveBeenCalledWith(
    connection,
    '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/rizz-ai-staging',
    abort,
  );
  await expect(
    reader.readArgoApplication(
      { ...target, argoApplication: 'another-app' } as unknown as CloudTarget,
      abort,
    ),
  ).rejects.toThrow();
  expect(kubernetesRead).toHaveBeenCalledTimes(1);
});
it('verifies actual X509 bytes against synthetic AWS target evidence, using read operations only', async () => {
  const h = awsFixture();
  await expect(
    h.reader.verifyTarget(target, signal()),
  ).resolves.toBeUndefined();
  expect(h.awsReader.mock.calls).toHaveLength(9);
  expect(
    h.awsReader.mock.calls.every(([args]) =>
      [
        'get-caller-identity',
        'describe-cluster',
        'describe-certificate',
        'get-certificate',
        'describe-load-balancers',
        'describe-tags',
        'describe-listeners',
        'describe-listener-certificates',
        'describe-security-groups',
      ].includes(args[1]),
    ),
  ).toBe(true);
});
it('resolves Terraform HTTPS metadata and rejects forged or changed SSM handoff', async () => {
  const h = awsFixture();
  const parameter = {
    schemaVersion: 1,
    accountId: target.accountId,
    clusterName: target.clusterName,
    hostname: target.ingress.hostname,
    certificateArn: target.ingress.certificateArn,
    operatorCidr: target.ingress.operatorCidr,
  };
  h.evidence['ssm get-parameter'] = {
    Parameter: {
      Name: '/rizz/staging/https-target',
      Type: 'String',
      Value: JSON.stringify(parameter),
    },
  };
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'not-live',
    awsReader: h.awsReader,
    requireMetadata: true,
  });
  const { ingress: _ingress, ...base } = target;
  const configured = {
    ...base,
    ingress: { operatorCidr: target.ingress.operatorCidr },
  };
  const resolved = await reader.resolveTarget(configured, signal());
  expect(resolved).toEqual(target);
  await expect(
    reader.verifyTarget(resolved, signal()),
  ).resolves.toBeUndefined();

  parameter.hostname = 'other-1234567890.us-east-1.elb.amazonaws.com';
  h.evidence['ssm get-parameter'].Parameter.Value = JSON.stringify(parameter);
  await expect(reader.verifyTarget(resolved, signal())).rejects.toThrow(
    /metadata changed/,
  );
  await expect(reader.resolveTarget(configured, signal())).resolves.not.toEqual(
    target,
  );
  parameter.accountId = '111111111111';
  h.evidence['ssm get-parameter'].Parameter.Value = JSON.stringify(parameter);
  await expect(reader.resolveTarget(configured, signal())).rejects.toThrow(
    /metadata differs/,
  );
});
it('accepts the operator-only fixed-response ALB before the first GitOps release', async () => {
  const h = awsFixture();
  h.evidence['elbv2 describe-listeners'].Listeners = [
    {
      ListenerArn:
        'arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/rizz-staging-demo/abc/http',
      LoadBalancerArn:
        'arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/rizz-staging-demo/abc',
      Port: 80,
      Protocol: 'HTTP',
    },
  ];
  const permission =
    h.evidence['ec2 describe-security-groups'].SecurityGroups[0]
      .IpPermissions[0];
  permission.FromPort = 80;
  permission.ToPort = 80;
  await expect(
    h.reader.verifyTarget(target, signal(), 'initial'),
  ).resolves.toBeUndefined();
  expect(h.awsReader.mock.calls.map(([args]) => args[1])).toContain(
    'describe-rules',
  );
  expect(h.awsReader.mock.calls.map(([args]) => args[1])).not.toContain(
    'describe-listener-certificates',
  );
  permission.IpRanges[0].CidrIp = '0.0.0.0/0';
  await expect(
    h.reader.verifyTarget(target, signal(), 'initial'),
  ).rejects.toThrow();
  permission.IpRanges[0].CidrIp = target.ingress.operatorCidr;
  h.evidence['elbv2 describe-rules'].Rules[0].Actions[0].Type = 'forward';
  await expect(
    h.reader.verifyTarget(target, signal(), 'initial'),
  ).rejects.toThrow();
});
it('accepts a later HTTPS listener alongside the restricted bootstrap HTTP listener', async () => {
  const h = awsFixture();
  const https = h.evidence['elbv2 describe-listeners'].Listeners[0];
  h.evidence['elbv2 describe-listeners'].Listeners.unshift({
    ListenerArn:
      'arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/rizz-staging-demo/abc/http',
    LoadBalancerArn: https.LoadBalancerArn,
    Port: 80,
    Protocol: 'HTTP',
  });
  const permissions =
    h.evidence['ec2 describe-security-groups'].SecurityGroups[0].IpPermissions;
  permissions.push({
    ...structuredClone(permissions[0]),
    FromPort: 80,
    ToPort: 80,
  });
  await expect(
    h.reader.verifyTarget(target, signal()),
  ).resolves.toBeUndefined();
  permissions[1].IpRanges[0].CidrIp = '0.0.0.0/0';
  await expect(h.reader.verifyTarget(target, signal())).rejects.toThrow();
});
it.each([
  'root',
  'account',
  'cluster',
  'certificate',
  'expired',
  'wideIngress',
  'ipv6',
  'http',
  'extraCertificate',
  'association',
])('fails closed for mismatched target evidence: %s', async change => {
  const h = awsFixture();
  const t = structuredClone(target);
  if (change === 'root')
    h.evidence['sts get-caller-identity'].Arn =
      'arn:aws:iam::000000000000:root';
  if (change === 'account')
    h.evidence['sts get-caller-identity'].Account = '111111111111';
  if (change === 'cluster')
    h.evidence['eks describe-cluster'].cluster.name = 'other-cluster';
  if (change === 'certificate')
    t.ingress.certificateSha256 = `sha256:${'f'.repeat(64)}`;
  if (change === 'expired')
    h.reader = new AuthenticatedCloudReaders({
      awsProfile: 'fixture-reader',
      githubToken: 'not-live',
      awsReader: h.awsReader,
      now: () => Date.now() + 864000000,
    });
  if (change === 'wideIngress')
    h.evidence[
      'ec2 describe-security-groups'
    ].SecurityGroups[0].IpPermissions[0].IpRanges[0].CidrIp = '0.0.0.0/0';
  if (change === 'ipv6')
    h.evidence[
      'ec2 describe-security-groups'
    ].SecurityGroups[0].IpPermissions[0].Ipv6Ranges = [{ CidrIpv6: '::/0' }];
  if (change === 'http')
    h.evidence['elbv2 describe-listeners'].Listeners[0].Port = 80;
  if (change === 'extraCertificate')
    h.evidence['elbv2 describe-listener-certificates'].Certificates.push({
      CertificateArn: target.ingress.certificateArn,
      IsDefault: false,
    });
  if (change === 'association')
    h.evidence['elbv2 describe-tags'].TagDescriptions[0].Tags[0].Value = 'kind';
  await expect(h.reader.verifyTarget(t, signal())).rejects.toThrow();
});
it('never calls the AWS transport on an already-aborted request', async () => {
  const h = awsFixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    h.reader.verifyTarget(target, controller.signal),
  ).rejects.toThrow();
  expect(h.awsReader).not.toHaveBeenCalled();
});
it('binds absent GitOps state to one exact commit, rather than mutable contents URLs', async () => {
  const calls: string[] = [];
  const fetcher = jest.fn().mockImplementation(async (url: string) => {
    calls.push(url);
    if (url.endsWith('git/ref/heads/main'))
      return Response.json({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: 'a'.repeat(40) },
      });
    if (url.includes('git/commits/'))
      return Response.json({
        sha: 'a'.repeat(40),
        tree: { sha: 'b'.repeat(40) },
      });
    return Response.json({ sha: 'b'.repeat(40), truncated: false, tree: [] });
  });
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'not-live',
    fetcher: fetcher as typeof fetch,
  });
  await expect(reader.readGitops(target, signal())).resolves.toEqual({
    base: { revision: 'a'.repeat(40), files: [] },
    currentState: { state: 'absent' },
    contents: {},
  });
  expect(calls).toHaveLength(3);
  expect(calls[2]).toContain(`${'b'.repeat(40)}?recursive=1`);
});
it.each([
  'truncated',
  'symlink',
  'submodule',
  'blobParent',
  'nested',
  'badBlob',
  'partial',
])('rejects unsafe or unverifiable GitOps evidence: %s', async problem => {
  const content = '{}\n';
  const blobSha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest('hex');
  const entry = {
    path: `${target.gitopsPath}/runtime.yaml`,
    type: 'blob',
    mode: '100644',
    sha: blobSha,
    size: Buffer.byteLength(content),
  };
  if (problem === 'symlink') entry.mode = '120000';
  if (problem === 'submodule') {
    entry.mode = '160000';
    entry.type = 'commit';
  }
  if (problem === 'blobParent') entry.path = 'clusters';
  if (problem === 'nested')
    entry.path = `${target.gitopsPath}/nested/runtime.yaml`;
  const fetcher = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('git/ref/heads/main'))
      return Response.json({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: 'a'.repeat(40) },
      });
    if (url.includes('git/commits/'))
      return Response.json({
        sha: 'a'.repeat(40),
        tree: { sha: 'b'.repeat(40) },
      });
    if (url.includes('git/trees/'))
      return Response.json({
        sha: 'b'.repeat(40),
        truncated: problem === 'truncated',
        tree: [entry],
      });
    return Response.json({
      sha: blobSha,
      encoding: 'base64',
      size: entry.size,
      content: Buffer.from(problem === 'badBlob' ? 'bad' : content).toString(
        'base64',
      ),
    });
  });
  const reader = new AuthenticatedCloudReaders({
    awsProfile: 'fixture-reader',
    githubToken: 'not-live',
    fetcher: fetcher as typeof fetch,
  });
  await expect(reader.readGitops(target, signal())).rejects.toThrow();
});
