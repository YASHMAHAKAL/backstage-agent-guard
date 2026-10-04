import { execFile } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import {
  CloudTarget,
  cloudTargetMetadataSchema,
  cloudTargetSchema,
} from './cloudTarget';
import {
  cloudGitopsBaseSchema,
  inspectCloudGitopsFiles,
} from './cloudSnapshot';
import { CloudReaders } from './services/CloudProposalService';
import { sha256 } from './snapshot';
import { readCloudHttpsJson } from './cloudHttps';

const exec = promisify(execFile);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const metadataName = '/rizz/staging/https-target';
type AwsRead = (args: string[], signal: AbortSignal) => Promise<unknown>;
type KubernetesConnection = { endpoint: string; ca: string; token: string };

export class AuthenticatedCloudReaders implements CloudReaders {
  readonly mode = 'authenticated' as const;
  constructor(
    private readonly options: {
      awsProfile: string;
      githubToken: string;
      awsReader?: AwsRead;
      fetcher?: typeof fetch;
      kubernetesRead?: (
        connection: KubernetesConnection,
        path: string,
        signal: AbortSignal,
      ) => Promise<unknown>;
      now?: () => number;
      requireMetadata?: boolean;
    },
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(options.awsProfile) ||
      !options.githubToken.trim()
    )
      throw new Error('Explicit cloud reader credentials required');
  }

  private async aws(args: string[], signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('Cloud read cancelled');
    if (this.options.awsReader) return this.options.awsReader(args, signal);
    // No shell, ambient access keys or endpoint overrides. Profile configuration
    // is an operator-owned trust boundary; use a separate least-privilege reader.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('AWS_ENDPOINT_URL') ||
        [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
        ].includes(key)
      )
        delete env[key];
    }
    env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
    try {
      const result = await exec(
        'aws',
        [
          ...args,
          '--profile',
          this.options.awsProfile,
          '--region',
          'us-east-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '3',
          '--cli-read-timeout',
          '5',
        ],
        { signal, timeout: 8000, maxBuffer: 512 * 1024, env },
      );
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('Cloud AWS read unavailable');
    }
  }

  private async readHttpsMetadata(signal: AbortSignal) {
    const response = z
      .object({
        Parameter: z.object({
          Name: z.literal(metadataName),
          Type: z.literal('String'),
          Value: z.string().min(1).max(2048),
        }),
      })
      .parse(
        await this.aws(
          ['ssm', 'get-parameter', '--name', metadataName],
          signal,
        ),
      );
    return z
      .object({
        schemaVersion: z.literal(1),
        accountId: z.string().regex(/^[0-9]{12}$/),
        clusterName: z.literal('rizz-eks-staging'),
        hostname: z.string(),
        certificateArn: z.string(),
        operatorCidr: z.string(),
      })
      .strict()
      .parse(JSON.parse(response.Parameter.Value));
  }

  async resolveTarget(raw: unknown, signal: AbortSignal): Promise<CloudTarget> {
    if (!this.options.requireMetadata)
      throw new Error('Cloud HTTPS metadata lookup is disabled');
    const base = cloudTargetMetadataSchema.parse(raw);
    const metadata = await this.readHttpsMetadata(signal);
    if (
      metadata.accountId !== base.accountId ||
      metadata.clusterName !== base.clusterName ||
      metadata.operatorCidr !== base.ingress.operatorCidr
    )
      throw new Error('Cloud HTTPS metadata differs from operator target');
    const targetWithoutFingerprint = {
      ...base,
      ingress: {
        stage: 'ready' as const,
        hostname: metadata.hostname,
        operatorCidr: base.ingress.operatorCidr,
        certificateArn: metadata.certificateArn,
      },
    };
    // Validate the untrusted SSM fields before passing an ARN to the AWS API.
    cloudTargetSchema.parse({
      ...targetWithoutFingerprint,
      ingress: {
        ...targetWithoutFingerprint.ingress,
        certificateSha256: `sha256:${'0'.repeat(64)}`,
      },
    });
    const cert = z
      .object({ Certificate: z.string().min(1).max(32768) })
      .parse(
        await this.aws(
          [
            'acm',
            'get-certificate',
            '--certificate-arn',
            metadata.certificateArn,
          ],
          signal,
        ),
      );
    const fingerprint = `sha256:${createHash('sha256')
      .update(new X509Certificate(cert.Certificate).raw)
      .digest('hex')}`;
    return cloudTargetSchema.parse({
      ...targetWithoutFingerprint,
      ingress: {
        ...targetWithoutFingerprint.ingress,
        certificateSha256: fingerprint,
      },
    });
  }

  async readClusterConnection(raw: CloudTarget, signal: AbortSignal) {
    const t = cloudTargetSchema.parse(raw);
    const identity = z
      .object({ Account: z.literal(t.accountId), Arn: z.string() })
      .parse(await this.aws(['sts', 'get-caller-identity'], signal));
    if (
      !new RegExp(
        `^arn:aws:(iam|sts)::${t.accountId}:(user/|assumed-role/)`,
      ).test(identity.Arn)
    )
      throw new Error('Unexpected cloud reader identity');
    const cluster = z
      .object({
        cluster: z.object({
          name: z.literal(t.clusterName),
          status: z.literal('ACTIVE'),
          arn: z.literal(
            `arn:aws:eks:us-east-1:${t.accountId}:cluster/${t.clusterName}`,
          ),
          endpoint: z.string(),
          certificateAuthority: z.object({
            data: z.string().min(1).max(65536),
          }),
        }),
      })
      .parse(
        await this.aws(
          ['eks', 'describe-cluster', '--name', t.clusterName],
          signal,
        ),
      ).cluster;
    const endpoint = new URL(cluster.endpoint);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/' ||
      !/^[a-z0-9.-]+\.us-east-1\.(?:eks\.amazonaws\.com|api\.aws)$/.test(
        endpoint.hostname,
      )
    )
      throw new Error('Unexpected EKS endpoint');
    const ca = Buffer.from(
      cluster.certificateAuthority.data,
      'base64',
    ).toString('utf8');
    const certificate = new X509Certificate(ca);
    if (
      !certificate.ca ||
      Date.parse(certificate.validFrom) >
        (this.options.now?.() ?? Date.now()) ||
      Date.parse(certificate.validTo) <= (this.options.now?.() ?? Date.now())
    )
      throw new Error('Invalid EKS CA');
    const credentials = z
      .object({
        kind: z.literal('ExecCredential'),
        apiVersion: z.enum([
          'client.authentication.k8s.io/v1beta1',
          'client.authentication.k8s.io/v1',
        ]),
        status: z.object({
          token: z
            .string()
            .regex(/^k8s-aws-v1\.[A-Za-z0-9_-]+$/)
            .max(16384),
          expirationTimestamp: z.string().datetime(),
        }),
      })
      .parse(
        await this.aws(
          ['eks', 'get-token', '--cluster-name', t.clusterName],
          signal,
        ),
      );
    if (
      Date.parse(credentials.status.expirationTimestamp) <
      (this.options.now?.() ?? Date.now()) + 60000
    )
      throw new Error('Expired EKS credentials');
    return { endpoint: endpoint.origin, ca, token: credentials.status.token };
  }

  /** Read only the named Argo Application CR through the already authenticated
   * EKS connection. The argocd namespace Role grants no list or write verbs. */
  async readArgoApplication(raw: CloudTarget, signal: AbortSignal) {
    const target = cloudTargetSchema.parse(raw);
    const connection = await this.readClusterConnection(target, signal);
    const path = `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${encodeURIComponent(
      target.argoApplication,
    )}`;
    if (this.options.kubernetesRead)
      return this.options.kubernetesRead(connection, path, signal);
    return readCloudHttpsJson({
      url: new URL(path, connection.endpoint),
      ca: connection.ca,
      token: connection.token,
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
  }

  /** A complete, authenticated absence check before deleting the remaining
   * app resources. Any incomplete inventory fails closed. */
  async readRetirementCleanup(raw: CloudTarget, signal: AbortSignal) {
    const target = cloudTargetSchema.parse(raw);
    const connection = await this.readClusterConnection(target, signal);
    const ingresses = z
      .object({
        kind: z.literal('IngressList'),
        items: z.array(z.unknown()).length(0),
        metadata: z.object({ continue: z.string().optional() }).optional(),
      })
      .parse(
        await readCloudHttpsJson({
          url: new URL(
            `/apis/networking.k8s.io/v1/namespaces/${target.namespace}/ingresses`,
            connection.endpoint,
          ),
          ca: connection.ca,
          token: connection.token,
          signal,
          maxBytes: 65536,
        }),
      );
    if (ingresses.metadata?.continue)
      throw new Error('Incomplete ingress inventory');
    const lbs = z
      .object({
        LoadBalancers: z
          .array(z.object({ LoadBalancerName: z.string() }))
          .max(200),
        NextMarker: z.undefined().optional(),
      })
      .parse(await this.aws(['elbv2', 'describe-load-balancers'], signal));
    if (
      lbs.LoadBalancers.some(lb => lb.LoadBalancerName === 'rizz-staging-demo')
    )
      throw new Error('Rizz.AI ALB still exists');
    const groups = z
      .object({
        TargetGroups: z
          .array(z.object({ TargetGroupArn: z.string().min(1) }))
          .max(200),
        NextMarker: z.undefined().optional(),
      })
      .parse(await this.aws(['elbv2', 'describe-target-groups'], signal));
    for (let index = 0; index < groups.TargetGroups.length; index += 20) {
      const batch = groups.TargetGroups.slice(index, index + 20);
      const tags = z
        .object({
          TagDescriptions: z.array(
            z.object({
              ResourceArn: z.string(),
              Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
            }),
          ),
        })
        .parse(
          await this.aws(
            [
              'elbv2',
              'describe-tags',
              '--resource-arns',
              ...batch.map(group => group.TargetGroupArn),
            ],
            signal,
          ),
        );
      if (
        tags.TagDescriptions.length !== batch.length ||
        tags.TagDescriptions.some(
          item =>
            !batch.some(group => group.TargetGroupArn === item.ResourceArn),
        )
      )
        throw new Error('Incomplete target-group tags');
      if (
        tags.TagDescriptions.some(item =>
          item.Tags.some(
            tag =>
              tag.Key === 'ingress.k8s.aws/stack' &&
              tag.Value === `${target.namespace}/rizz-frontend`,
          ),
        )
      )
        throw new Error('Rizz.AI target group still exists');
    }
    return {
      checkedAt: new Date().toISOString(),
      ingressAbsent: true as const,
      albAbsent: true as const,
      targetGroupsAbsent: true as const,
    };
  }

  async readRetiredAppCleanup(raw: CloudTarget, signal: AbortSignal) {
    const target = cloudTargetSchema.parse(raw);
    await this.readRetirementCleanup(target, signal);
    const connection = await this.readClusterConnection(target, signal);
    const resources = [
      {
        path: 'apis/apps/v1',
        plural: 'deployments',
        names: ['rizz-frontend', 'rizz-backend'],
      },
      {
        path: 'api/v1',
        plural: 'services',
        names: ['rizz-frontend-service', 'rizz-backend-service'],
      },
      { path: 'api/v1', plural: 'configmaps', names: ['rizz-runtime'] },
      {
        path: 'apis/external-secrets.io/v1',
        plural: 'secretstores',
        names: ['rizz-runtime'],
      },
      {
        path: 'apis/external-secrets.io/v1',
        plural: 'externalsecrets',
        names: ['rizz-runtime'],
      },
      { path: 'apis/apps/v1', plural: 'replicasets', names: [] },
      { path: 'api/v1', plural: 'pods', names: [] },
    ];
    for (const resource of resources) {
      const response = z
        .object({
          items: z.array(
            z.object({
              metadata: z.object({
                name: z.string(),
                labels: z.record(z.string()).optional(),
              }),
            }),
          ),
          metadata: z.object({ continue: z.string().optional() }).optional(),
        })
        .parse(
          await readCloudHttpsJson({
            url: new URL(
              `/${resource.path}/namespaces/${target.namespace}/${resource.plural}`,
              connection.endpoint,
            ),
            ca: connection.ca,
            token: connection.token,
            signal,
            maxBytes: 128 * 1024,
          }),
        );
      if (
        response.metadata?.continue ||
        response.items.some(
          item =>
            resource.names.includes(item.metadata.name) ||
            item.metadata.labels?.['app.kubernetes.io/part-of'] === 'rizz-ai',
        )
      )
        throw new Error('Rizz.AI resources remain');
    }
    return {
      checkedAt: new Date().toISOString(),
      appResourcesAbsent: true as const,
    };
  }

  async readSmokeCertificate(raw: CloudTarget, signal: AbortSignal) {
    const t = cloudTargetSchema.parse(raw);
    return z
      .object({ Certificate: z.string().min(1).max(32768) })
      .parse(
        await this.aws(
          [
            'acm',
            'get-certificate',
            '--certificate-arn',
            t.ingress.certificateArn,
          ],
          signal,
        ),
      ).Certificate;
  }

  async readImageManifest(
    raw: CloudTarget,
    part: 'frontend' | 'backend',
    digest: string,
    signal: AbortSignal,
  ) {
    const t = cloudTargetSchema.parse(raw);
    z.enum(['frontend', 'backend']).parse(part);
    z.string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(digest);
    const result = z
      .object({
        failures: z.array(z.unknown()).length(0).optional(),
        images: z
          .array(
            z.object({
              registryId: z.literal(t.accountId),
              repositoryName: z.literal(`rizz-staging-${part}`),
              imageId: z.object({ imageDigest: z.literal(digest) }),
              imageManifest: z.string().max(262144),
            }),
          )
          .length(1),
      })
      .parse(
        await this.aws(
          [
            'ecr',
            'batch-get-image',
            '--registry-id',
            t.accountId,
            '--repository-name',
            `rizz-staging-${part}`,
            '--image-ids',
            `imageDigest=${digest}`,
          ],
          signal,
        ),
      );
    const manifest = result.images[0].imageManifest;
    if (
      `sha256:${createHash('sha256').update(manifest).digest('hex')}` !== digest
    )
      throw new Error('Registry manifest integrity mismatch');
    return JSON.parse(manifest) as unknown;
  }

  async verifyTarget(
    raw: CloudTarget,
    signal: AbortSignal,
    phase: 'initial' | 'deployed' = 'deployed',
  ): Promise<void> {
    const t = cloudTargetSchema.parse(raw);
    if (this.options.requireMetadata) {
      const metadata = await this.readHttpsMetadata(signal);
      if (
        metadata.accountId !== t.accountId ||
        metadata.clusterName !== t.clusterName ||
        metadata.hostname !== t.ingress.hostname ||
        metadata.certificateArn !== t.ingress.certificateArn ||
        metadata.operatorCidr !== t.ingress.operatorCidr
      )
        throw new Error('Cloud HTTPS metadata changed since target resolution');
    }
    const identity = z
      .object({ Account: z.literal(t.accountId), Arn: z.string() })
      .parse(await this.aws(['sts', 'get-caller-identity'], signal));
    if (
      !new RegExp(
        `^arn:aws:(iam|sts)::${t.accountId}:(user/|assumed-role/)`,
      ).test(identity.Arn)
    )
      throw new Error('Root or unexpected AWS identity');
    const cluster = z
      .object({
        cluster: z.object({
          name: z.literal(t.clusterName),
          arn: z.literal(
            `arn:aws:eks:us-east-1:${t.accountId}:cluster/${t.clusterName}`,
          ),
          status: z.literal('ACTIVE'),
          resourcesVpcConfig: z.object({
            vpcId: z.string().regex(/^vpc-[a-f0-9]+$/),
            endpointPrivateAccess: z.literal(true),
            endpointPublicAccess: z.boolean(),
            publicAccessCidrs: z.array(z.string()),
          }),
        }),
      })
      .parse(
        await this.aws(
          ['eks', 'describe-cluster', '--name', t.clusterName],
          signal,
        ),
      ).cluster;
    const vpc = cluster.resourcesVpcConfig;
    if (
      vpc.endpointPublicAccess &&
      (vpc.publicAccessCidrs.length !== 1 ||
        vpc.publicAccessCidrs[0] !== t.ingress.operatorCidr)
    )
      throw new Error('EKS API exposure differs from approved operator');
    const cert = z
      .object({
        Certificate: z.object({
          CertificateArn: z.literal(t.ingress.certificateArn),
          Status: z.literal('ISSUED'),
          Type: z.literal('IMPORTED'),
          SubjectAlternativeNames: z.array(z.string()).length(1),
        }),
      })
      .parse(
        await this.aws(
          [
            'acm',
            'describe-certificate',
            '--certificate-arn',
            t.ingress.certificateArn,
          ],
          signal,
        ),
      ).Certificate;
    if (cert.SubjectAlternativeNames[0] !== t.ingress.hostname)
      throw new Error('Certificate SAN mismatch');
    const pem = z
      .object({ Certificate: z.string().min(1).max(32768) })
      .parse(
        await this.aws(
          [
            'acm',
            'get-certificate',
            '--certificate-arn',
            t.ingress.certificateArn,
          ],
          signal,
        ),
      );
    const x509 = new X509Certificate(pem.Certificate);
    const now = this.options.now?.() ?? Date.now();
    if (
      `sha256:${createHash('sha256').update(x509.raw).digest('hex')}` !==
        t.ingress.certificateSha256 ||
      x509.ca ||
      Date.parse(x509.validFrom) > now ||
      Date.parse(x509.validTo) < now + 3600000 ||
      x509.subjectAltName !== `DNS:${t.ingress.hostname}` ||
      x509.checkHost(t.ingress.hostname, {
        wildcards: false,
        subject: 'never',
      }) !== t.ingress.hostname ||
      x509.issuer !== x509.subject ||
      !x509.verify(x509.publicKey)
    )
      throw new Error('Certificate validity or fingerprint mismatch');

    const lb = z
      .object({
        LoadBalancers: z
          .array(
            z.object({
              LoadBalancerArn: z.string(),
              LoadBalancerName: z.literal('rizz-staging-demo'),
              DNSName: z.literal(t.ingress.hostname),
              Scheme: z.literal('internet-facing'),
              Type: z.literal('application'),
              IpAddressType: z.literal('ipv4'),
              VpcId: z.literal(vpc.vpcId),
              State: z.object({ Code: z.literal('active') }),
              SecurityGroups: z
                .array(z.string().regex(/^sg-[a-f0-9]+$/))
                .min(1)
                .max(5),
            }),
          )
          .length(1),
      })
      .parse(
        await this.aws(
          ['elbv2', 'describe-load-balancers', '--names', 'rizz-staging-demo'],
          signal,
        ),
      ).LoadBalancers[0];
    if (
      !lb.LoadBalancerArn.startsWith(
        `arn:aws:elasticloadbalancing:us-east-1:${t.accountId}:loadbalancer/app/rizz-staging-demo/`,
      )
    )
      throw new Error('ALB account mismatch');
    const tags = z
      .object({
        TagDescriptions: z
          .array(
            z.object({
              ResourceArn: z.literal(lb.LoadBalancerArn),
              Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
            }),
          )
          .length(1),
      })
      .parse(
        await this.aws(
          ['elbv2', 'describe-tags', '--resource-arns', lb.LoadBalancerArn],
          signal,
        ),
      );
    const map = Object.fromEntries(
      tags.TagDescriptions[0].Tags.map(tag => [tag.Key, tag.Value]),
    );
    if (
      map['elbv2.k8s.aws/cluster'] !== t.clusterName ||
      map['ingress.k8s.aws/stack'] !== 'rizz-staging-demo'
    )
      throw new Error('ALB cluster or ingress association mismatch');
    const listeners = z
      .object({
        Listeners: z
          .array(
            z.object({
              ListenerArn: z.string(),
              LoadBalancerArn: z.literal(lb.LoadBalancerArn),
              Port: z.number().int(),
              Protocol: z.enum(['HTTP', 'HTTPS']),
              SslPolicy: z.string().optional(),
              Certificates: z
                .array(z.object({ CertificateArn: z.string() }))
                .optional(),
            }),
          )
          .min(1)
          .max(2),
        NextMarker: z.undefined().optional(),
      })
      .parse(
        await this.aws(
          [
            'elbv2',
            'describe-listeners',
            '--load-balancer-arn',
            lb.LoadBalancerArn,
          ],
          signal,
        ),
      ).Listeners;
    if (
      new Set(listeners.map(item => item.Port)).size !== listeners.length ||
      listeners.some(
        item =>
          (item.Port !== 80 || item.Protocol !== 'HTTP') &&
          (item.Port !== 443 || item.Protocol !== 'HTTPS'),
      )
    )
      throw new Error('Unexpected ALB listener');
    const listener = listeners.find(
      item => item.Port === (phase === 'initial' ? 80 : 443),
    );
    if (!listener) throw new Error('Required ALB listener missing');
    if (
      !listener.ListenerArn.startsWith(
        `arn:aws:elasticloadbalancing:us-east-1:${t.accountId}:listener/app/rizz-staging-demo/`,
      )
    )
      throw new Error('Listener account mismatch');
    if (phase === 'initial') {
      const rules = z
        .object({
          Rules: z
            .array(
              z.object({
                Actions: z
                  .array(
                    z.object({
                      Type: z.string(),
                      FixedResponseConfig: z
                        .object({ StatusCode: z.string() })
                        .optional(),
                    }),
                  )
                  .length(1),
              }),
            )
            .min(1)
            .max(10),
          NextMarker: z.undefined().optional(),
        })
        .parse(
          await this.aws(
            ['elbv2', 'describe-rules', '--listener-arn', listener.ListenerArn],
            signal,
          ),
        ).Rules;
      if (
        rules.some(
          rule =>
            rule.Actions[0].Type !== 'fixed-response' ||
            !['404', '503'].includes(
              rule.Actions[0].FixedResponseConfig?.StatusCode ?? '',
            ),
        ) ||
        !rules.some(
          rule => rule.Actions[0].FixedResponseConfig?.StatusCode === '503',
        )
      )
        throw new Error('Bootstrap ALB listener may route traffic');
    }
    if (phase === 'deployed') {
      if (
        listener.SslPolicy !== 'ELBSecurityPolicy-TLS13-1-2-2021-06' ||
        listener.Certificates?.length !== 1 ||
        listener.Certificates[0].CertificateArn !== t.ingress.certificateArn
      )
        throw new Error('HTTPS listener certificate or policy mismatch');
      z.object({
        Certificates: z
          .array(
            z.object({
              CertificateArn: z.literal(t.ingress.certificateArn),
              IsDefault: z.literal(true),
            }),
          )
          .length(1),
        NextMarker: z.undefined().optional(),
      }).parse(
        await this.aws(
          [
            'elbv2',
            'describe-listener-certificates',
            '--listener-arn',
            listener.ListenerArn,
          ],
          signal,
        ),
      );
    }
    const sgs = z
      .object({
        SecurityGroups: z
          .array(
            z.object({
              GroupId: z.string(),
              VpcId: z.literal(vpc.vpcId),
              OwnerId: z.literal(t.accountId),
              IpPermissions: z
                .array(
                  z.object({
                    IpProtocol: z.literal('tcp'),
                    FromPort: z.number().int(),
                    ToPort: z.number().int(),
                    IpRanges: z
                      .array(
                        z.object({ CidrIp: z.literal(t.ingress.operatorCidr) }),
                      )
                      .length(1),
                    Ipv6Ranges: z.array(z.unknown()).length(0),
                    PrefixListIds: z.array(z.unknown()).length(0),
                    UserIdGroupPairs: z.array(z.unknown()).length(0),
                  }),
                )
                .max(2),
            }),
          )
          .min(1)
          .max(5),
        NextToken: z.undefined().optional(),
      })
      .parse(
        await this.aws(
          [
            'ec2',
            'describe-security-groups',
            '--group-ids',
            ...lb.SecurityGroups,
          ],
          signal,
        ),
      ).SecurityGroups;
    if (
      new Set(sgs.map(sg => sg.GroupId)).size !== lb.SecurityGroups.length ||
      sgs.some(sg => !lb.SecurityGroups.includes(sg.GroupId)) ||
      sgs.some(sg =>
        sg.IpPermissions.some(
          permission =>
            permission.FromPort !== permission.ToPort ||
            ![80, 443].includes(permission.FromPort),
        ),
      ) ||
      !sgs.some(sg =>
        sg.IpPermissions.some(
          permission =>
            permission.FromPort === (phase === 'initial' ? 80 : 443),
        ),
      )
    )
      throw new Error('Incomplete ALB security-group evidence');
  }

  private async github(
    repo: string,
    path: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.github.com/repos/${repo}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.options.githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
        redirect: 'error',
      },
    );
    if (!response.ok || !response.body)
      throw new Error('Cloud GitOps read unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024)
          throw new Error('Cloud GitOps response too large');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async readGitops(raw: CloudTarget, signal: AbortSignal) {
    const t = cloudTargetSchema.parse(raw);
    const repo = t.gitopsRepository.slice('https://github.com/'.length, -4);
    const ref = z
      .object({
        ref: z.literal('refs/heads/main'),
        object: z.object({ type: z.literal('commit'), sha: gitSha }),
      })
      .parse(await this.github(repo, 'git/ref/heads/main', signal));
    const revision = ref.object.sha;
    return this.readGitopsRevision(t, revision, signal);
  }

  async readPullRequest(raw: CloudTarget, number: number, signal: AbortSignal) {
    const t = cloudTargetSchema.parse(raw);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error('Invalid pull request number');
    const repo = t.gitopsRepository.slice('https://github.com/'.length, -4);
    return this.github(repo, `pulls/${number}`, signal);
  }

  async isAncestor(
    raw: CloudTarget,
    ancestor: string,
    revision: string,
    signal: AbortSignal,
  ) {
    const t = cloudTargetSchema.parse(raw);
    gitSha.parse(ancestor);
    gitSha.parse(revision);
    const repo = t.gitopsRepository.slice('https://github.com/'.length, -4);
    const comparison = z
      .object({
        status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
        merge_base_commit: z.object({ sha: gitSha }),
      })
      .parse(
        await this.github(repo, `compare/${ancestor}...${revision}`, signal),
      );
    return (
      ['ahead', 'identical'].includes(comparison.status) &&
      comparison.merge_base_commit.sha === ancestor
    );
  }

  // Immutable revision reads are used for observation, not approval freshness.
  // Verify actual synced bytes; an ancestor check alone is not delivery proof.
  async readGitopsRevision(
    raw: CloudTarget,
    rawRevision: string,
    signal: AbortSignal,
  ) {
    const t = cloudTargetSchema.parse(raw);
    const revision = gitSha.parse(rawRevision);
    const repo = t.gitopsRepository.slice('https://github.com/'.length, -4);
    const commit = z
      .object({ sha: z.literal(revision), tree: z.object({ sha: gitSha }) })
      .parse(await this.github(repo, `git/commits/${revision}`, signal));
    const tree = z
      .object({
        sha: z.literal(commit.tree.sha),
        truncated: z.literal(false),
        tree: z
          .array(
            z.object({
              path: z.string().max(1000),
              type: z.enum(['blob', 'tree', 'commit']),
              mode: z.string(),
              sha: gitSha,
              size: z.number().int().nonnegative().optional(),
            }),
          )
          .max(10000),
      })
      .parse(
        await this.github(
          repo,
          `git/trees/${commit.tree.sha}?recursive=1`,
          signal,
        ),
      );
    const app = tree.tree.filter(
      entry =>
        entry.path === t.gitopsPath ||
        entry.path.startsWith(`${t.gitopsPath}/`),
    );
    if (
      tree.tree.some(
        entry =>
          t.gitopsPath.startsWith(`${entry.path}/`) &&
          (entry.type !== 'tree' || entry.mode !== '040000'),
      )
    )
      throw new Error('Unsafe cloud parent directory');
    const files = app.filter(entry => entry.path !== t.gitopsPath);
    if (
      app.some(
        entry =>
          entry.path === t.gitopsPath &&
          (entry.type !== 'tree' || entry.mode !== '040000'),
      ) ||
      files.length > 9 ||
      files.some(
        entry =>
          entry.type !== 'blob' ||
          entry.mode !== '100644' ||
          entry.size === undefined ||
          entry.size > 65536 ||
          entry.path.slice(t.gitopsPath.length + 1).includes('/'),
      )
    )
      throw new Error('Unsupported cloud GitOps directory');
    const contents: Record<string, string> = {};
    const hashes: Array<{ name: string; sha256: string }> = [];
    for (const entry of files) {
      const blob = z
        .object({
          sha: z.literal(entry.sha),
          encoding: z.literal('base64'),
          size: z.literal(entry.size),
          content: z.string().max(100000),
        })
        .parse(await this.github(repo, `git/blobs/${entry.sha}`, signal));
      const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
      if (
        bytes.length !== entry.size ||
        createHash('sha1')
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest('hex') !== entry.sha
      )
        throw new Error('Git blob integrity mismatch');
      const content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes))
        throw new Error('Invalid GitOps UTF-8');
      const name = entry.path.slice(t.gitopsPath.length + 1);
      if (name in contents) throw new Error('Duplicate GitOps file');
      contents[name] = content;
      hashes.push({ name, sha256: sha256(content) });
    }
    const base = cloudGitopsBaseSchema.parse({
      revision,
      files: hashes.sort((a, b) => a.name.localeCompare(b.name)),
    });
    return {
      base,
      currentState: inspectCloudGitopsFiles(contents, t),
      contents,
    };
  }
}
