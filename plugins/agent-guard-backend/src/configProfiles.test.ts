import { ConfigSources } from '@backstage/config-loader';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCloudConfiguration } from './cloudConfiguration';
import { createReleaseCatalog } from './releaseSource';
import { ReleaseCatalog } from './releases';

const root = resolve(__dirname, '../../..');
const scripts = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).scripts;
const originalEnvironment = process.env.BACKSTAGE_ENV;
let fixture: string;
const privateProfile = {
  agentGuard: {
    rizzReleases: { enabled: true },
    rizzCloud: { enabled: true, delivery: { enabled: true } },
  },
};
const credentials: Record<string, string> = {
  AUTH_GITHUB_CLIENT_ID: 'fixture-client-id',
  AUTH_GITHUB_CLIENT_SECRET: 'fixture-client-secret',
  RIZZ_RELEASE_GITHUB_TOKEN: 'fixture-release-reader',
  RIZZ_GITOPS_READ_TOKEN: 'fixture-gitops-reader',
  AGENT_GUARD_K8S_URL: 'https://kind.example.test',
  AGENT_GUARD_K8S_TOKEN: 'fixture-kind-reader',
  AGENT_GUARD_K8S_CA_DATA: 'fixture-kind-ca',
  POSTGRES_HOST: 'database.example.test',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'fixture-user',
  POSTGRES_PASSWORD: 'fixture-password',
};

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'backstage-config-profiles-'));
  for (const profile of [
    'app-config.yaml',
    'app-config.portal.yaml',
    'app-config.kind.yaml',
    'app-config.cloud.yaml',
    'app-config.production.yaml',
  ]) {
    copyFileSync(join(root, profile), join(fixture, profile));
  }
  writeFileSync(
    join(fixture, 'app-config.cloud.local.yaml'),
    JSON.stringify(privateProfile),
  );
});
afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
  if (originalEnvironment === undefined) delete process.env.BACKSTAGE_ENV;
  else process.env.BACKSTAGE_ENV = originalEnvironment;
});

async function load(
  command: string,
  values: Record<string, string> = credentials,
) {
  const script = scripts[command];
  process.env.BACKSTAGE_ENV = script.match(/BACKSTAGE_ENV=([^\s]+)/)?.[1] ?? '';
  const overrides = Object.fromEntries(
    [...script.matchAll(/(APP_CONFIG_[^=\s]+)=([^\s]+)/g)].map(
      (match: RegExpMatchArray) => [match[1], match[2]],
    ),
  );
  const config = await ConfigSources.toConfig(
    ConfigSources.default({
      argv: [],
      rootDir: fixture,
      watch: false,
      env: overrides,
      substitutionFunc: async name => values[name],
    }),
  );
  config.close();
  return config;
}

function catalogTargets(config: Awaited<ReturnType<typeof load>>) {
  return config
    .getConfigArray('catalog.locations')
    .map(location => location.getString('target'));
}

it('keeps the guest demo independent of private cloud configuration and credentials', async () => {
  const config = await load('start', {});
  expect(config.getString('auth.environment')).toBe('guest-demo');
  expect(config.getOptionalConfig('auth.providers.github')).toBeUndefined();
  expect(catalogTargets(config)).toHaveLength(7);
  expect(
    createCloudConfiguration(config, new ReleaseCatalog()),
  ).toBeUndefined();
  expect(
    config.getOptionalConfig('backend.auth.externalAccess'),
  ).toBeUndefined();
});

it.each(['start:github', 'start:portal'])(
  'keeps %s signed in without GitOps or AWS credentials',
  async command => {
    const config = await load(command, {
      AUTH_GITHUB_CLIENT_ID: credentials.AUTH_GITHUB_CLIENT_ID,
      AUTH_GITHUB_CLIENT_SECRET: credentials.AUTH_GITHUB_CLIENT_SECRET,
    });
    expect(config.getString('auth.environment')).toBe('github');
    expect(config.getOptionalConfig('auth.providers.guest')).toBeUndefined();
    expect(
      config
        .getConfigArray('integrations.github')[0]
        .getOptionalString('token'),
    ).toBeUndefined();
    const targets = catalogTargets(config);
    expect(targets).toHaveLength(10);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toContain(
      '../../catalog/templates/deploy-rizz-ai/template.yaml',
    );
    expect(
      createCloudConfiguration(config, new ReleaseCatalog()),
    ).toBeUndefined();
  },
);

it('loads only the Kind connection for Kind startup', async () => {
  const config = await load('start:portal:kind');
  const clusters = config
    .getConfigArray('kubernetes.clusterLocatorMethods')[0]
    .getConfigArray('clusters');
  expect(clusters).toHaveLength(1);
  expect(clusters[0].getString('name')).toBe('agent-guard-kind');
  expect(clusters[0].getBoolean('skipTLSVerify')).toBe(false);
  expect(
    createCloudConfiguration(config, new ReleaseCatalog()),
  ).toBeUndefined();
});

it('forces cloud and delivery off for releases even when the private file enables an invalid EKS target', async () => {
  writeFileSync(
    join(fixture, 'app-config.cloud.local.yaml'),
    JSON.stringify({
      agentGuard: {
        rizzReleases: { enabled: true },
        rizzCloud: {
          enabled: true,
          delivery: { enabled: true },
          target: { accountId: 'invalid' },
        },
      },
    }),
  );
  const releaseOnlyCredentials = { ...credentials };
  delete releaseOnlyCredentials.RIZZ_GITOPS_READ_TOKEN;
  const config = await load('start:portal:releases', releaseOnlyCredentials);
  expect(config.getBoolean('agentGuard.rizzReleases.enabled')).toBe(true);
  expect(config.getBoolean('agentGuard.rizzCloud.enabled')).toBe(false);
  expect(config.getBoolean('agentGuard.rizzCloud.delivery.enabled')).toBe(
    false,
  );
  expect(createReleaseCatalog(config)).toBeInstanceOf(ReleaseCatalog);
  expect(
    createCloudConfiguration(config, new ReleaseCatalog()),
  ).toBeUndefined();
  expect(
    config.getOptionalConfig('kubernetes.clusterLocatorMethods'),
  ).toBeUndefined();
});

it.each(['start:portal:cloud', 'start:portal:cloud:kind'])(
  'loads %s without changing the shared Catalog or activating the Terraform runner',
  async command => {
    const config = await load(command);
    const cloud = createCloudConfiguration(config, new ReleaseCatalog())!;
    expect(cloud.target).toMatchObject({
      clusterName: 'rizz-eks-staging',
      namespace: 'rizz-staging',
    });
    expect(cloud.delivery).toBeDefined();
    const targets = catalogTargets(config);
    expect(targets).toHaveLength(10);
    expect(new Set(targets).size).toBe(targets.length);
    expect(
      config.getOptionalConfig('backend.auth.externalAccess'),
    ).toBeUndefined();
    const clusters =
      config
        .getOptionalConfigArray('kubernetes.clusterLocatorMethods')?.[0]
        .getConfigArray('clusters')
        .map(cluster => ({
          name: cluster.getString('name'),
          url: cluster.getString('url'),
        })) ?? [];
    expect(clusters).toEqual(
      command.endsWith(':kind')
        ? [
            {
              name: 'agent-guard-kind',
              url: credentials.AGENT_GUARD_K8S_URL,
            },
          ]
        : [],
    );
  },
);

it('reuses portal authentication in production through the standard include', async () => {
  process.env.BACKSTAGE_ENV = 'production';
  const config = await ConfigSources.toConfig(
    ConfigSources.default({
      argv: [],
      rootDir: fixture,
      watch: false,
      env: {},
      substitutionFunc: async name => credentials[name],
    }),
  );
  config.close();
  expect(config.getString('auth.environment')).toBe('github');
  expect(config.getOptionalConfig('auth.providers.guest')).toBeUndefined();
  expect(config.getString('auth.providers.github.github.clientId')).toBe(
    credentials.AUTH_GITHUB_CLIENT_ID,
  );
  expect(config.getString('backend.database.client')).toBe('pg');
  expect(
    createCloudConfiguration(config, new ReleaseCatalog()),
  ).toBeUndefined();
});

it('stops an explicit release/cloud startup when its private override is missing', () => {
  rmSync(join(fixture, 'app-config.cloud.local.yaml'));
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/require-local-config.mjs'),
      'app-config.cloud.local.yaml',
    ],
    {
      cwd: fixture,
      encoding: 'utf8',
      env: {},
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'Missing private Backstage config: app-config.cloud.local.yaml',
  );
});
