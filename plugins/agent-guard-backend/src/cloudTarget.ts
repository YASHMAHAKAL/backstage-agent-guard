import { isIPv4 } from 'node:net';
import { z } from 'zod/v3';

const singleHost = z.string().refine(value => {
  const [ip, prefix, extra] = value.split('/');
  if (!isIPv4(ip) || prefix !== '32' || extra !== undefined) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}, 'One public IPv4 /32 is required');

// Backend-owned configuration, NOT agent input. Parsing checks shape, not live
// AWS state, authenticated identity, certificate ownership or reviewer rights.
export const cloudTargetSchema = z
  .object({
    id: z.literal('eks-staging'),
    accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.literal('us-east-1'),
    clusterName: z.literal('rizz-eks-staging'),
    namespace: z.literal('rizz-staging'),
    owner: z.literal('group:default/platform-team'),
    sourceRepository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/),
    gitopsRepository: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/),
    gitopsBranch: z.literal('main'),
    gitopsPath: z.literal('clusters/eks-staging/apps/rizz-ai'),
    argoApplication: z.literal('rizz-ai-staging'),
    ingress: z
      .object({
        // Bootstrap belongs to the explicit operator procedure, not an app release.
        stage: z.literal('ready'),
        hostname: z
          .string()
          .regex(
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:us-east-1\.elb|elb\.us-east-1)\.amazonaws\.com$/,
          ),
        operatorCidr: singleHost,
        certificateArn: z
          .string()
          .regex(
            /^arn:aws:acm:us-east-1:[0-9]{12}:certificate\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
          ),
        certificateSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .refine(
    target => target.ingress.certificateArn.split(':')[4] === target.accountId,
    'Certificate account must match target account',
  );

export type CloudTarget = z.infer<typeof cloudTargetSchema>;

// Kept equivalent to the offline ALB helper; conformance is regression-tested.
export function renderCloudIngress(target: CloudTarget) {
  const t = cloudTargetSchema.parse(target);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'rizz-frontend',
      namespace: t.namespace,
      annotations: {
        'alb.ingress.kubernetes.io/group.name': 'rizz-staging-demo',
        'alb.ingress.kubernetes.io/load-balancer-name': 'rizz-staging-demo',
        'alb.ingress.kubernetes.io/scheme': 'internet-facing',
        'alb.ingress.kubernetes.io/ip-address-type': 'ipv4',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
        'alb.ingress.kubernetes.io/ssl-redirect': '443',
        'alb.ingress.kubernetes.io/inbound-cidrs': t.ingress.operatorCidr,
        'alb.ingress.kubernetes.io/certificate-arn': t.ingress.certificateArn,
        'alb.ingress.kubernetes.io/ssl-policy':
          'ELBSecurityPolicy-TLS13-1-2-2021-06',
        'alb.ingress.kubernetes.io/backend-protocol': 'HTTP',
        'alb.ingress.kubernetes.io/healthcheck-path': '/healthz',
        'alb.ingress.kubernetes.io/success-codes': '200',
        'agent-guard.backstage.io/certificate-sha256':
          t.ingress.certificateSha256,
        'agent-guard.backstage.io/tls-stage': t.ingress.stage,
      },
    },
    spec: {
      ingressClassName: 'alb',
      rules: [
        {
          host: t.ingress.hostname,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name: 'rizz-frontend-service',
                    port: { number: 80 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
}
