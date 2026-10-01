import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const yaml = createRequire(import.meta.url)('yaml');
export const bootstrapHostname = 'rizz-bootstrap.invalid';
export const owner = 'group:default/platform-team';
const albHostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(?:us-east-1\.elb|elb\.us-east-1)\.amazonaws\.com$/;

export function validateHostname(hostname, stage) {
  if (
    !['bootstrap', 'ready'].includes(stage) ||
    typeof hostname !== 'string' ||
    (stage === 'bootstrap'
      ? hostname !== bootstrapHostname
      : !albHostname.test(hostname))
  )
    throw new Error(
      'Use the bootstrap name or exact observed us-east-1 ALB hostname.',
    );
  return hostname;
}

export function validateAlbConfig(config) {
  const keys = [
    'accountId',
    'certificateArn',
    'certificateSha256',
    'hostname',
    'operatorCidr',
    'stage',
  ];
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !== keys.sort().join(',') ||
    keys.some(k => typeof config[k] !== 'string') ||
    !/^[0-9]{12}$/.test(config.accountId) ||
    !new RegExp(
      `^arn:aws:acm:us-east-1:${config.accountId}:certificate/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`,
    ).test(config.certificateArn) ||
    !/^sha256:[a-f0-9]{64}$/.test(config.certificateSha256)
  )
    throw new Error(
      'Use only reviewed ALB demo configuration with a same-account regional certificate.',
    );
  validateHostname(config.hostname, config.stage);
  const [ip, prefix, extra] = config.operatorCidr.split('/');
  const octets = ip.split('.').map(Number);
  // A single host, never a subnet/open Internet/IPv6 fallback. Documentation
  // addresses remain allowed for offline fixtures, not evidence of a real IP.
  if (
    !isIPv4(ip) ||
    prefix !== '32' ||
    extra !== undefined ||
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] >= 224 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  )
    throw new Error(
      'Use one reviewed public IPv4 address with /32, never a broad CIDR.',
    );
  return config;
}

/** Offline fragment, NOT a deployable release or approval. */
export function renderAlbIngress(config) {
  validateAlbConfig(config);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'rizz-frontend',
      namespace: 'rizz-staging',
      annotations: {
        'alb.ingress.kubernetes.io/group.name': 'rizz-staging-demo',
        'alb.ingress.kubernetes.io/load-balancer-name': 'rizz-staging-demo',
        'alb.ingress.kubernetes.io/scheme': 'internet-facing',
        'alb.ingress.kubernetes.io/ip-address-type': 'ipv4',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443}]',
        'alb.ingress.kubernetes.io/ssl-redirect': '443',
        'alb.ingress.kubernetes.io/inbound-cidrs': config.operatorCidr,
        'alb.ingress.kubernetes.io/certificate-arn': config.certificateArn,
        'alb.ingress.kubernetes.io/ssl-policy':
          'ELBSecurityPolicy-TLS13-1-2-2021-06',
        'alb.ingress.kubernetes.io/backend-protocol': 'HTTP',
        'alb.ingress.kubernetes.io/healthcheck-path': '/healthz',
        'alb.ingress.kubernetes.io/success-codes': '200',
        'agent-guard.backstage.io/certificate-sha256': config.certificateSha256,
        'agent-guard.backstage.io/tls-stage': config.stage,
      },
    },
    spec: {
      ingressClassName: 'alb',
      rules: [
        {
          host: config.hostname,
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [command, argument, hostname] = process.argv.slice(2);
    if (
      command === 'render' &&
      argument &&
      !hostname &&
      process.argv.length === 4
    ) {
      console.log(
        yaml.stringify(
          renderAlbIngress(JSON.parse(readFileSync(argument, 'utf8'))),
        ),
      );
    } else throw new Error('Invalid command.');
  } catch {
    // Do not emit arbitrary input values, key contents or OpenSSL stderr.
    console.error('Offline ALB preparation failed. Usage: render CONFIG.json');
    process.exitCode = 1;
  }
}
