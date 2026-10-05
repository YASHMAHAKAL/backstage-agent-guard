import { ConfigReader } from '@backstage/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { createCloudConfiguration } from './cloudConfiguration';
import { cloudTemplateMatches, cloudTemplateSpec } from './cloudTemplate';
import { ReleaseCatalog } from './releases';

const example = parse(
  readFileSync(resolve(__dirname, '../../../app-config.cloud.yaml'), 'utf8'),
);
function configured() {
  const data = structuredClone(example);
  data.agentGuard.rizzCloud.enabled = true;
  data.agentGuard.rizzCloud.githubToken = 'fixture-read-token-not-live';
  data.agentGuard.rizzReleases = {
    enabled: true,
    repository: 'example-owner/Rizz.AI',
    frontendRepository:
      '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-frontend',
    backendRepository:
      '000000000000.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend',
  };
  return data;
}
it('is disabled without any credentials; the committed overlay is off', () => {
  expect(example.agentGuard.rizzCloud.enabled).toBe(false);
  expect(
    createCloudConfiguration(new ConfigReader({}), new ReleaseCatalog()),
  ).toBeUndefined();
  expect(
    createCloudConfiguration(
      new ConfigReader({ agentGuard: { rizzCloud: { enabled: false } } }),
      new ReleaseCatalog(),
    ),
  ).toBeUndefined();
});
it('constructs only real reader adapters from matching explicit configuration, without a provider call', () => {
  const releases = new ReleaseCatalog();
  const result = createCloudConfiguration(
    new ConfigReader(configured()),
    releases,
  )!;
  expect(result.target).toEqual(example.agentGuard.rizzCloud.target);
  expect(result.releases).toBe(releases);
  expect(result.readers.mode).toBe('authenticated');
  expect(result.submitterGroups).toEqual([
    'group:default/rizz-team',
    'group:default/platform-team',
  ]);
  expect(result.delivery).toBeUndefined();
});
it('requires explicit separate cloud observation configuration and constructs it without provider calls', () => {
  const data = configured();
  data.agentGuard.rizzCloud.delivery = {
    enabled: true,
    destinationServer: 'https://kubernetes.default.svc',
  };
  expect(
    createCloudConfiguration(new ConfigReader(data), new ReleaseCatalog())!
      .delivery,
  ).toBeDefined();
  delete data.agentGuard.rizzCloud.delivery.destinationServer;
  expect(() =>
    createCloudConfiguration(new ConfigReader(data), new ReleaseCatalog()),
  ).toThrow();
});
it.each([
  'disabledRelease',
  'differentSource',
  'differentRegistry',
  'unsupportedTarget',
  'missingToken',
])(
  'fails configuration rather than silently using a different target: %s',
  issue => {
    const data = configured();
    if (issue === 'disabledRelease')
      data.agentGuard.rizzReleases.enabled = false;
    if (issue === 'differentSource')
      data.agentGuard.rizzReleases.repository = 'another/app';
    if (issue === 'differentRegistry')
      data.agentGuard.rizzReleases.backendRepository =
        '111111111111.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend';
    if (issue === 'unsupportedTarget')
      data.agentGuard.rizzCloud.target.id = 'kind-staging';
    if (issue === 'missingToken') delete data.agentGuard.rizzCloud.githubToken;
    expect(() =>
      createCloudConfiguration(new ConfigReader(data), new ReleaseCatalog()),
    ).toThrow();
  },
);
it('catalog template is exactly the guarded no-parameter executor; changed steps/version cannot execute', () => {
  const entity = parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../catalog/templates/deploy-rizz-ai/template.yaml',
      ),
      'utf8',
    ),
  );
  expect(entity.spec).toEqual(cloudTemplateSpec);
  expect(cloudTemplateMatches(entity)).toBe(true);
  expect(cloudTemplateMatches(undefined)).toBe(false);
  const changed = structuredClone(entity);
  changed.spec.steps.push({
    id: 'unsafe',
    name: 'Unsafe publish',
    action: 'publish:github',
  });
  expect(cloudTemplateMatches(changed)).toBe(false);
  delete entity.metadata.annotations;
  expect(cloudTemplateMatches(entity)).toBe(false);
});
