import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('yaml');
const lock = JSON.parse(
  readFileSync(new URL('./charts.lock.json', import.meta.url), 'utf8'),
);
const values = name =>
  yaml.parse(
    readFileSync(new URL(`./values/${name}.yaml`, import.meta.url), 'utf8'),
  );

test('pinned chart archives require exact SHA-256 digests', () => {
  for (const chart of Object.values(lock.charts)) {
    assert.match(chart.version, /^\d+\.\d+\.\d+$/);
    assert.match(chart.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(lock.kubernetesVersion, '1.35.0');
});

test('controller values keep fixed cluster, namespace, and Pod Identity boundaries', () => {
  const alb = values('aws-load-balancer-controller');
  assert.equal(alb.clusterName, 'rizz-eks-staging');
  assert.equal(alb.region, 'us-east-1');
  assert.equal(alb.serviceAccount.name, 'aws-load-balancer-controller');
  assert.equal(alb.serviceAccount.annotations, undefined);
  assert.equal(alb.enableServiceMutatorWebhook, false);
  assert.equal(alb.enableWafv2, false);

  const eso = values('external-secrets');
  assert.equal(eso.serviceAccount.name, 'external-secrets');
  assert.equal(eso.scopedNamespace, 'rizz-staging');
  assert.equal(eso.scopedRBAC, true);
  for (const key of [
    'processPushSecret',
    'processClusterPushSecret',
    'processClusterStore',
    'processClusterExternalSecret',
    'processClusterGenerator',
  ])
    assert.equal(eso[key], false);
});

// Opt-in local Helm smoke rendering. This never contacts AWS or Kubernetes.
test(
  'pinned controller charts render the reviewed service accounts and CRDs',
  { skip: !process.env.RIZZ_CHART_TEST_DIRECTORY },
  () => {
    for (const name of ['aws-load-balancer-controller', 'external-secrets']) {
      const chart = lock.charts[name];
      const archive = resolve(
        process.env.RIZZ_CHART_TEST_DIRECTORY,
        `${name}-${chart.version}.tgz`,
      );
      const digest = createHash('sha256')
        .update(readFileSync(archive))
        .digest('hex');
      assert.equal(digest, chart.sha256, `${name} chart checksum`);
      const chartValues = values(name);
      if (name === 'aws-load-balancer-controller')
        chartValues.vpcId = 'vpc-00000000000000000';
      const rendered = spawnSync(
        'helm',
        [
          'template',
          name,
          archive,
          '--namespace',
          name === 'external-secrets' ? 'external-secrets' : 'kube-system',
          '--kube-version',
          lock.kubernetesVersion,
          '--include-crds',
          '--values',
          '-',
        ],
        {
          input: yaml.stringify(chartValues),
          encoding: 'utf8',
          timeout: 60000,
        },
      );
      assert.equal(rendered.status, 0, `Helm render failed for ${name}`);
      const documents = yaml
        .parseAllDocuments(rendered.stdout)
        .map(doc => doc.toJSON())
        .filter(Boolean);
      assert.ok(documents.length > 0);
      assert.ok(!documents.some(doc => doc.kind === 'Ingress'));
      assert.ok(
        documents.some(
          doc => doc.kind === 'ServiceAccount' && doc.metadata.name === name,
        ),
      );
      if (name === 'external-secrets') {
        assert.ok(
          documents.some(
            doc =>
              doc.kind === 'CustomResourceDefinition' &&
              doc.spec.names.kind === 'ExternalSecret',
          ),
        );
      }
    }
  },
);
