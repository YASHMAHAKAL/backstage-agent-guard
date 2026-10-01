import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  bootstrapHostname,
  owner,
  renderAlbIngress,
  validateAlbConfig,
} from './alb-demo.mjs';

const yaml = createRequire(import.meta.url)('yaml');
const config = JSON.parse(
  readFileSync(
    new URL('./alb-demo.config.example.json', import.meta.url),
    'utf8',
  ),
);
const hostname = 'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com';

test('offline fragment is HTTPS-only, one-host restricted and frontend-only', () => {
  const ingress = renderAlbIngress(config);
  const annotations = ingress.metadata.annotations;
  assert.equal(owner, 'group:default/platform-team');
  assert.equal(ingress.spec.ingressClassName, 'alb');
  assert.deepEqual(
    JSON.parse(annotations['alb.ingress.kubernetes.io/listen-ports']),
    [{ HTTPS: 443 }],
  );
  assert.equal(
    annotations['alb.ingress.kubernetes.io/inbound-cidrs'],
    config.operatorCidr,
  );
  assert.equal(
    annotations['alb.ingress.kubernetes.io/ip-address-type'],
    'ipv4',
  );
  assert.equal(annotations['alb.ingress.kubernetes.io/target-type'], 'ip');
  assert.equal(
    annotations['alb.ingress.kubernetes.io/group.name'],
    'rizz-staging-demo',
  );
  assert.equal(annotations['alb.ingress.kubernetes.io/ssl-redirect'], '443');
  assert.equal(
    ingress.spec.rules[0].http.paths[0].backend.service.name,
    'rizz-frontend-service',
  );
  assert.equal(ingress.spec.rules[0].host, bootstrapHostname);
  assert.ok(!Object.keys(annotations).some(k => /security-groups/.test(k)));
  assert.equal(JSON.stringify(ingress).includes('rizz-backend-service'), false);
  assert.deepEqual(yaml.parse(yaml.stringify(ingress)), ingress);
});

test('rejects broad, multiple, malformed, private and alternate-family CIDRs', () => {
  for (const operatorCidr of [
    '0.0.0.0/0',
    '203.0.113.10/24',
    '203.0.113.10/32,198.51.100.10/32',
    '::/0',
    '10.0.0.1/32',
    '127.0.0.1/32',
    '172.16.0.1/32',
    '192.168.1.1/32',
    '169.254.1.1/32',
    '100.64.0.1/32',
    '224.0.0.1/32',
    '999.0.0.1/32',
    '203.0.113.10/32/extra',
  ]) {
    assert.throws(() => renderAlbIngress({ ...config, operatorCidr }));
  }
});

test('rejects spoofed owner, annotations, certificates and arbitrary connection details', () => {
  for (const value of [
    {
      ...config,
      certificateArn: config.certificateArn.replace('us-east-1', 'us-west-2'),
    },
    {
      ...config,
      certificateArn: config.certificateArn.replace(
        '000000000000:',
        '111111111111:',
      ),
    },
    { ...config, certificateSha256: 'not-a-fingerprint' },
    ...[
      'owner',
      'privateKey',
      'annotations',
      'backendIngress',
      'securityGroups',
      'repoUrl',
    ].map(k => ({ ...config, [k]: 'untrusted' })),
  ])
    assert.throws(() => validateAlbConfig(value));
});

test('ready stage requires a matching-region observed-hostname shape, not a guessed URL', () => {
  assert.equal(
    renderAlbIngress({ ...config, stage: 'ready', hostname }).spec.rules[0]
      .host,
    hostname,
  );
  assert.equal(
    renderAlbIngress({
      ...config,
      stage: 'ready',
      hostname: 'rizz-staging-demo-123.elb.us-east-1.amazonaws.com',
    }).spec.rules[0].host,
    'rizz-staging-demo-123.elb.us-east-1.amazonaws.com',
  );
  for (const bad of [
    'example.com',
    bootstrapHostname,
    `https://${hostname}`,
    hostname.replace('us-east-1', 'us-west-2'),
    `${hostname}.attacker.invalid`,
    '*.' + hostname,
  ]) {
    assert.throws(() =>
      renderAlbIngress({ ...config, stage: 'ready', hostname: bad }),
    );
  }
});
