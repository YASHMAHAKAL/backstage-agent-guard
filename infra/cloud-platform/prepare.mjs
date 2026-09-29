import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('yaml');
const directory = dirname(fileURLToPath(import.meta.url));
export const lock = JSON.parse(
  readFileSync(resolve(directory, 'charts.lock.json'), 'utf8'),
);
const server = 'https://kubernetes.default.svc';
const resource = (group, kind) => ({ group, kind });
const chartValues = name =>
  yaml.parse(
    readFileSync(resolve(directory, 'values', `${name}.yaml`), 'utf8'),
  );

export function validateConfig(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !==
      'expectedAccountId,gitopsRepoUrl,vpcId' ||
    !['expectedAccountId', 'vpcId', 'gitopsRepoUrl'].every(
      key => typeof config[key] === 'string',
    ) ||
    !/^[0-9]{12}$/.test(config.expectedAccountId) ||
    !/^vpc-[a-f0-9]{17}$/.test(config.vpcId) ||
    !/^https:\/\/github[.]com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+[.]git$/.test(
      config.gitopsRepoUrl,
    )
  ) {
    throw new Error(
      'Use only reviewed account ID, VPC ID and credential-free GitHub GitOps URL.',
    );
  }
  return config;
}

export function prepare(config) {
  validateConfig(config);
  const namespaced = ['ServiceAccount', 'Service', 'ConfigMap', 'Secret'].map(
    kind => resource('', kind),
  );
  const workloads = ['Deployment', 'StatefulSet'].map(kind =>
    resource('apps', kind),
  );
  const projects = [
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'AppProject',
      metadata: { name: 'default', namespace: 'argocd' },
      spec: {
        sourceRepos: [],
        destinations: [],
        clusterResourceWhitelist: [],
        namespaceResourceBlacklist: [resource('*', '*')],
      },
    },
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'AppProject',
      metadata: { name: 'rizz-platform', namespace: 'argocd' },
      spec: {
        sourceRepos: [
          lock.charts['aws-load-balancer-controller'].repo,
          lock.charts['external-secrets'].repo,
        ],
        destinations: ['kube-system', 'external-secrets', 'rizz-staging'].map(
          namespace => ({ server, namespace }),
        ),
        clusterResourceWhitelist: [
          resource('apiextensions.k8s.io', 'CustomResourceDefinition'),
          resource('rbac.authorization.k8s.io', 'ClusterRole'),
          resource('rbac.authorization.k8s.io', 'ClusterRoleBinding'),
          resource(
            'admissionregistration.k8s.io',
            'MutatingWebhookConfiguration',
          ),
          resource(
            'admissionregistration.k8s.io',
            'ValidatingWebhookConfiguration',
          ),
          resource('networking.k8s.io', 'IngressClass'),
          resource('elbv2.k8s.aws', 'IngressClassParams'),
        ],
        namespaceResourceWhitelist: [
          ...namespaced,
          ...workloads,
          resource('rbac.authorization.k8s.io', 'Role'),
          resource('rbac.authorization.k8s.io', 'RoleBinding'),
        ],
      },
    },
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'AppProject',
      metadata: { name: 'rizz-app', namespace: 'argocd' },
      spec: {
        sourceRepos: [config.gitopsRepoUrl],
        destinations: [{ server, namespace: 'rizz-staging' }],
        clusterResourceWhitelist: [],
        namespaceResourceWhitelist: [
          ...namespaced.filter(r => r.kind !== 'Secret'),
          ...workloads,
          resource('networking.k8s.io', 'Ingress'),
          resource('external-secrets.io', 'SecretStore'),
          resource('external-secrets.io', 'ExternalSecret'),
        ],
      },
    },
  ];
  const values = {
    'argo-cd': chartValues('argo-cd'),
    'aws-load-balancer-controller': {
      ...chartValues('aws-load-balancer-controller'),
      vpcId: config.vpcId,
    },
    'external-secrets': chartValues('external-secrets'),
  };
  const applications = ['aws-load-balancer-controller', 'external-secrets'].map(
    name => ({
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name, namespace: 'argocd' },
      spec: {
        project: 'rizz-platform',
        source: {
          repoURL: lock.charts[name].repo,
          chart: name,
          targetRevision: lock.charts[name].version,
          helm: { releaseName: name, valuesObject: values[name] },
        },
        destination: {
          server,
          namespace:
            name === 'external-secrets' ? 'external-secrets' : 'kube-system',
        },
        syncPolicy: {
          syncOptions: [
            'ServerSideApply=true',
            'RespectIgnoreDifferences=true',
          ],
        },
        ...(name === 'aws-load-balancer-controller'
          ? {
              ignoreDifferences: [
                {
                  group: '',
                  kind: 'Secret',
                  name: 'aws-load-balancer-tls',
                  namespace: 'kube-system',
                  jsonPointers: ['/data'],
                },
                ...[
                  'MutatingWebhookConfiguration',
                  'ValidatingWebhookConfiguration',
                ].map(kind => ({
                  group: 'admissionregistration.k8s.io',
                  kind,
                  name: 'aws-load-balancer-webhook',
                  jqPathExpressions: ['.webhooks[].clientConfig.caBundle'],
                })),
              ],
            }
          : {}),
      },
    }),
  );
  applications.push({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name: 'rizz-ai-staging', namespace: 'argocd' },
    spec: {
      project: 'rizz-app',
      source: {
        repoURL: config.gitopsRepoUrl,
        targetRevision: 'main',
        path: 'clusters/eks-staging/apps/rizz-ai',
      },
      destination: { server, namespace: 'rizz-staging' },
      syncPolicy: { syncOptions: ['ServerSideApply=true'] },
    },
  });
  return {
    values,
    bootstrap: [
      ...['external-secrets', 'rizz-staging'].map(name => ({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name },
      })),
      ...projects,
      ...applications,
    ],
  };
}

export function verifyChart(name, bytes) {
  if (
    !lock.charts[name] ||
    createHash('sha256').update(bytes).digest('hex') !==
      lock.charts[name].sha256
  ) {
    throw new Error(
      'Chart archive missing or checksum mismatch; stop and review pins.',
    );
  }
}

// Offline Helm rendering only: cannot install, call kubectl/AWS, or publish Git.
export function renderCharts(config, chartDirectory) {
  const prepared = prepare(config);
  return Object.keys(lock.charts).map(name => {
    const path = resolve(
      chartDirectory,
      `${name}-${lock.charts[name].version}.tgz`,
    );
    verifyChart(name, readFileSync(path));
    const namespace =
      name === 'argo-cd'
        ? 'argocd'
        : name === 'external-secrets'
        ? 'external-secrets'
        : 'kube-system';
    const result = spawnSync(
      'helm',
      [
        'template',
        name === 'argo-cd' ? 'argocd' : name,
        path,
        '--namespace',
        namespace,
        '--kube-version',
        lock.kubernetesVersion,
        '--include-crds',
        '--values',
        '-',
      ],
      {
        input: yaml.stringify(prepared.values[name]),
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(`Offline Helm render failed for ${name}.`);
    const documents = yaml.parseAllDocuments(result.stdout);
    if (documents.some(d => d.errors.length))
      throw new Error(`Invalid rendered YAML: ${name}.`);
    return {
      name,
      resources: documents
        .map(d => d.toJSON())
        .filter(Boolean)
        .flatMap(r => (r.kind === 'List' ? r.items : [r])),
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [configPath, chartsPath] = process.argv.slice(2);
    if (!configPath || process.argv.length > 4)
      throw new Error(
        'Usage: node prepare.mjs CONFIG.json [DOWNLOADED_CHART_DIRECTORY]',
      );
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (chartsPath) {
      const charts = renderCharts(config, chartsPath);
      console.log(
        JSON.stringify(
          {
            mode: 'offline-render-only',
            charts: charts.map(c => ({
              name: c.name,
              resources: c.resources.length,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        prepare(config)
          .bootstrap.map(r => yaml.stringify(r))
          .join('---\n'),
      );
    }
  } catch (error) {
    // Never echo supplied config/credential values or subprocess output.
    console.error(
      error instanceof Error &&
        /^(Use only|Chart archive|Offline Helm|Invalid rendered|Usage:)/.test(
          error.message,
        )
        ? error.message
        : 'Preparation failed; inspect local paths/configuration privately.',
    );
    process.exitCode = 1;
  }
}
