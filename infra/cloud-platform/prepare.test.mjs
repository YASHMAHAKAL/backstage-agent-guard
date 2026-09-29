import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  lock,
  prepare,
  renderCharts,
  validateConfig,
  verifyChart,
} from './prepare.mjs';
const yaml = createRequire(import.meta.url)('yaml');
const config = JSON.parse(
  readFileSync(new URL('./config.example.json', import.meta.url), 'utf8'),
);
const get = (resources, kind, name) =>
  resources.find(r => r.kind === kind && r.metadata.name === name);

test('namespace observer RBAC excludes Secrets, nodes and every mutation', () => {
  const [role, binding] = yaml
    .parseAllDocuments(
      readFileSync(new URL('./observer/rbac.yaml', import.meta.url), 'utf8'),
    )
    .map(doc => doc.toJSON());
  assert.equal(role.metadata.namespace, 'rizz-staging');
  assert.equal(binding.metadata.namespace, 'rizz-staging');
  assert.equal(binding.roleRef.kind, 'Role');
  assert.equal(binding.roleRef.name, role.metadata.name);
  for (const rule of role.rules) {
    assert.ok(rule.verbs.every(verb => ['get', 'list'].includes(verb)));
    assert.ok(
      rule.resources.every(
        resource => !['secrets', 'nodes', '*'].includes(resource),
      ),
    );
    assert.ok(rule.apiGroups.every(group => group !== '*'));
  }
  assert.deepEqual(binding.subjects, [
    {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Group',
      name: 'rizz-cloud-observers',
    },
  ]);
});

test('cloud observer account can only read the dedicated app; no broad default role', () => {
  const values = yaml.parse(
    readFileSync(new URL('./values/argo-cd.yaml', import.meta.url), 'utf8'),
  );
  assert.equal(values.configs.cm['accounts.rizz-observer'], 'apiKey');
  assert.equal(values.configs.rbac['policy.default'], '');
  assert.deepEqual(values.configs.rbac['policy.csv'].trim().split('\n'), [
    'p, role:rizz-observer, applications, get, rizz-app/rizz-ai-staging, allow',
    'g, rizz-observer, role:rizz-observer',
  ]);
});

test('strict operator inputs reject secrets, arbitrary targets and wrong types', () => {
  assert.equal(validateConfig(config), config);
  for (const input of [
    null,
    [],
    { ...config, token: 'never-accepted' },
    { ...config, cluster: 'kind' },
    { ...config, expectedAccountId: 123456789012 },
    {
      ...config,
      gitopsRepoUrl: 'https://user:credential@github.com/example/repo.git',
    },
    { ...config, gitopsRepoUrl: 'https://attacker.invalid/repo.git' },
    { ...config, vpcId: 'wrong' },
  ]) {
    assert.throws(() => prepare(input));
  }
});
test('exact checksum is mandatory, with no download or latest fallback', () => {
  assert.throws(() => verifyChart('argo-cd', Buffer.from('tampered')));
  assert.throws(() => verifyChart('unknown-chart', Buffer.from('anything')));
  for (const c of Object.values(lock.charts)) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/);
    assert.match(c.sha256, /^[a-f0-9]{64}$/);
  }
});
test('separate projects close default and exclude app cluster RBAC authority', () => {
  const { bootstrap } = prepare(config);
  const closed = get(bootstrap, 'AppProject', 'default').spec;
  assert.deepEqual(closed.sourceRepos, []);
  assert.deepEqual(closed.destinations, []);
  const app = get(bootstrap, 'AppProject', 'rizz-app').spec;
  assert.deepEqual(app.clusterResourceWhitelist, []);
  assert.deepEqual(app.destinations, [
    { server: 'https://kubernetes.default.svc', namespace: 'rizz-staging' },
  ]);
  assert.ok(
    !app.namespaceResourceWhitelist.some(r =>
      ['Secret', 'Role', 'RoleBinding', 'Application'].includes(r.kind),
    ),
  );
  assert.deepEqual(app.sourceRepos, [config.gitopsRepoUrl]);
});
test('bootstrap cannot self-manage Argo, deploy to Kind or auto-sync prematurely', () => {
  const { bootstrap } = prepare(config);
  const apps = bootstrap.filter(r => r.kind === 'Application');
  assert.equal(apps.length, 3);
  assert.ok(
    apps.every(
      a =>
        a.spec.destination.namespace !== 'argocd' &&
        !a.spec.syncPolicy.automated &&
        !a.metadata.finalizers,
    ),
  );
  const app = get(bootstrap, 'Application', 'rizz-ai-staging');
  assert.equal(app.spec.source.path, 'clusters/eks-staging/apps/rizz-ai');
  assert.equal(app.spec.source.targetRevision, 'main');
  assert.ok(!JSON.stringify(bootstrap).includes('apps/staging/'));
});
test('load-balancer config has explicit VPC and Pod Identity SA, not IMDS/static auth', () => {
  const values = prepare(config).values['aws-load-balancer-controller'];
  assert.equal(values.vpcId, config.vpcId);
  assert.equal(values.region, 'us-east-1');
  assert.equal(values.clusterName, 'rizz-eks-staging');
  assert.equal(values.serviceAccount.name, 'aws-load-balancer-controller');
  assert.equal(values.serviceAccount.annotations, undefined);
  assert.equal(values.enableServiceMutatorWebhook, false);
  assert.equal(values.enableWafv2, false);
});
test('only generated load-balancer TLS fields are ignored during Argo sync', () => {
  const app = get(
    prepare(config).bootstrap,
    'Application',
    'aws-load-balancer-controller',
  );
  assert.equal(app.spec.ignoreDifferences.length, 3);
  assert.deepEqual(app.spec.ignoreDifferences[0].jsonPointers, ['/data']);
  assert.ok(
    app.spec.syncPolicy.syncOptions.includes('RespectIgnoreDifferences=true'),
  );
  assert.ok(
    app.spec.ignoreDifferences
      .slice(1)
      .every(
        r => r.jqPathExpressions[0] === '.webhooks[].clientConfig.caBundle',
      ),
  );
});
test('ESO is namespaced and has no push or cluster-store controllers', () => {
  const values = prepare(config).values['external-secrets'];
  assert.equal(values.serviceAccount.name, 'external-secrets');
  assert.equal(values.scopedNamespace, 'rizz-staging');
  assert.equal(values.scopedRBAC, true);
  for (const key of [
    'processPushSecret',
    'processClusterPushSecret',
    'processClusterStore',
    'processClusterExternalSecret',
    'processClusterGenerator',
  ])
    assert.equal(values[key], false);
});
test('runtime secret fragment matches actual app keys, no AWS credential impersonation', () => {
  const docs = yaml
    .parseAllDocuments(
      readFileSync(new URL('./secrets/runtime.yaml', import.meta.url), 'utf8'),
    )
    .map(d => d.toJSON());
  const store = get(docs, 'SecretStore', 'rizz-runtime');
  assert.equal(store.spec.provider.aws.auth, undefined);
  assert.equal(store.spec.provider.aws.role, undefined);
  const secret = get(docs, 'ExternalSecret', 'rizz-runtime');
  assert.equal(secret.spec.target.name, 'rizz-runtime-secrets');
  assert.deepEqual(
    secret.spec.data.map(d => d.secretKey),
    ['gen-ai-key', 'demo-username', 'demo-password'],
  );
  assert.ok(
    secret.spec.data.every(
      d =>
        d.remoteRef.key === 'rizz/staging/runtime' &&
        d.remoteRef.property === d.secretKey,
    ),
  );
});

// Opt-in: requires downloaded hash-verified public chart archives and Helm.
// Still local template rendering; never install or contact Kubernetes/AWS.
test(
  'pinned charts render and preserve workload/namespace/identity boundaries',
  { skip: !process.env.RIZZ_CHART_TEST_DIRECTORY },
  () => {
    const charts = renderCharts(config, process.env.RIZZ_CHART_TEST_DIRECTORY);
    const ajv = new (createRequire(import.meta.url)('ajv'))({
      strict: false,
      validateFormats: false,
    });
    const custom = [
      ...prepare(config).bootstrap.filter(r =>
        ['Application', 'AppProject'].includes(r.kind),
      ),
      ...yaml
        .parseAllDocuments(
          readFileSync(
            new URL('./secrets/runtime.yaml', import.meta.url),
            'utf8',
          ),
        )
        .map(d => d.toJSON()),
    ];
    const crds = charts
      .flatMap(c => c.resources)
      .filter(r => r.kind === 'CustomResourceDefinition');
    for (const instance of custom) {
      const [group, version] = instance.apiVersion.split('/');
      const crd = crds.find(
        r => r.spec.group === group && r.spec.names.kind === instance.kind,
      );
      const served = crd?.spec.versions.find(
        v => v.name === version && v.served,
      );
      assert.ok(served, `Missing served CRD for ${instance.kind}`);
      const validate = ajv.compile(served.schema.openAPIV3Schema);
      assert.ok(
        validate(instance),
        `${instance.kind}: ${ajv.errorsText(validate.errors)}`,
      );
    }
    const platformProject = get(
      prepare(config).bootstrap,
      'AppProject',
      'rizz-platform',
    ).spec;
    for (const { name, resources } of charts) {
      assert.ok(resources.length > 0);
      assert.ok(
        !resources.some(
          r =>
            r.kind === 'Ingress' ||
            r.kind === 'Application' ||
            r.kind === 'ApplicationSet',
        ),
      );
      if (name !== 'argo-cd') {
        for (const r of resources) {
          const group = r.apiVersion.includes('/')
            ? r.apiVersion.split('/')[0]
            : '';
          const cluster = [
            'CustomResourceDefinition',
            'ClusterRole',
            'ClusterRoleBinding',
            'MutatingWebhookConfiguration',
            'ValidatingWebhookConfiguration',
            'IngressClass',
            'IngressClassParams',
          ].includes(r.kind);
          const allowlist = cluster
            ? platformProject.clusterResourceWhitelist
            : platformProject.namespaceResourceWhitelist;
          assert.ok(
            allowlist.some(
              rule => rule.group === group && rule.kind === r.kind,
            ),
            `${name}/${r.kind} forbidden by project`,
          );
          if (!cluster)
            assert.ok(
              platformProject.destinations.some(
                d =>
                  d.namespace ===
                  (r.metadata.namespace ??
                    (name === 'external-secrets'
                      ? 'external-secrets'
                      : 'kube-system')),
              ),
            );
        }
      }
      assert.ok(
        resources
          .filter(r => r.kind === 'Service')
          .every(r => !r.spec.type || r.spec.type === 'ClusterIP'),
      );
      const workloads = resources.filter(r =>
        ['Deployment', 'StatefulSet'].includes(r.kind),
      );
      assert.ok(workloads.length);
      for (const workload of workloads) {
        assert.equal(
          workload.spec.replicas ?? 1,
          name === 'argo-cd' &&
            workload.metadata.name.includes('applicationset')
            ? 0
            : 1,
        );
        for (const container of workload.spec.template.spec.containers) {
          assert.ok(
            container.resources?.requests?.memory,
            `${name}/${container.name} lacks requests`,
          );
          assert.ok(
            !container.env?.some(e => /ACCESS_KEY|SECRET_ACCESS/.test(e.name)),
          );
        }
      }
      if (name === 'aws-load-balancer-controller') {
        const workload = get(
          resources,
          'Deployment',
          'aws-load-balancer-controller',
        );
        assert.equal(
          workload.spec.template.spec.serviceAccountName,
          'aws-load-balancer-controller',
        );
        assert.ok(
          workload.spec.template.spec.containers[0].args.includes(
            `--aws-vpc-id=${config.vpcId}`,
          ),
        );
      }
      if (name === 'external-secrets') {
        const workload = get(resources, 'Deployment', 'external-secrets');
        assert.equal(
          workload.spec.template.spec.serviceAccountName,
          'external-secrets',
        );
        const bindings = resources.filter(r => r.kind === 'RoleBinding');
        assert.ok(
          bindings.some(
            r =>
              r.metadata.namespace === 'rizz-staging' &&
              r.subjects.some(
                s =>
                  s.namespace === 'external-secrets' &&
                  s.name === 'external-secrets',
              ),
          ),
        );
      }
    }
  },
);
