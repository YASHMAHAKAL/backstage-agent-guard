import { basename } from 'node:path';
import { cloudDeliveryFixture } from './testFixtures/cloudDeliveryFixture';
import {
  cloudRuntimeChangeInputSchema,
  previewCloudRuntimeChange,
} from './cloudRuntimeChange';
import { canonicalize, sha256 } from './snapshot';

const intent =
  'Increase only the Rizz.AI backend to two replicas; preserve frontend, images, model and routes.';

function baseline() {
  const snapshot = cloudDeliveryFixture().snapshot;
  const target = snapshot.envelope.target;
  const contents = Object.fromEntries(
    snapshot.files.map(file => [basename(file.path), file.content]),
  );
  // The synthetic fixture was rendered with backend=2. Model an earlier
  // complete and supported GitOps commit at backend=1 for this preview test.
  const deployment = JSON.parse(contents['backend-deployment.yaml']);
  deployment.spec.replicas = 1;
  contents['backend-deployment.yaml'] = `${canonicalize(deployment)}\n`;
  const base = {
    revision: 'b'.repeat(40),
    files: Object.keys(contents).map(name => ({
      name,
      sha256: sha256(contents[name]),
    })),
  };
  const input = {
    operation: 'runtime_change',
    declaredIntent: intent,
    targetId: 'eks-staging',
    patch: { backendReplicas: 2 },
  };
  return { target, contents, base, input };
}

it('changes only backend replicas and preserves every other approved byte', () => {
  const fixture = baseline();
  const preview = previewCloudRuntimeChange(fixture);
  expect(preview.before).toMatchObject({
    frontendReplicas: 1,
    backendReplicas: 1,
  });
  expect(preview.after).toMatchObject({
    frontendReplicas: 1,
    backendReplicas: 2,
    frontendImage: preview.before.frontendImage,
    backendImage: preview.before.backendImage,
    geminiModel: preview.before.geminiModel,
    frontendExposure: preview.before.frontendExposure,
    backendExposure: preview.before.backendExposure,
  });
  expect(preview.changedFields).toEqual(['backendReplicas']);
  for (const file of preview.files) {
    expect(file.sha256).toBe(sha256(file.content));
  }
  for (const file of preview.files.filter(
    item => basename(item.path) !== 'backend-deployment.yaml',
  ))
    expect(file.content).toBe(fixture.contents[basename(file.path)]);
});

it.each([3, 0, 1.5, '2', null])(
  'rejects invalid replica value %p before semantic review',
  value => {
    const fixture = baseline();
    expect(
      cloudRuntimeChangeInputSchema.safeParse({
        ...fixture.input,
        patch: { backendReplicas: value },
      }).success,
    ).toBe(false);
  },
);

it('rejects unsupported fields, spoofed targets and empty patches', () => {
  const fixture = baseline();
  for (const invalid of [
    {
      ...fixture.input,
      patch: { backendReplicas: 2, apiGatewayPathPrefix: '/v2' },
    },
    { ...fixture.input, patch: { image: 'latest' } },
    { ...fixture.input, patch: {} },
    { ...fixture.input, targetId: 'staging' },
    { ...fixture.input, owner: 'group:default/rizz-team' },
  ])
    expect(cloudRuntimeChangeInputSchema.safeParse(invalid).success).toBe(
      false,
    );
});

it('fails closed on missing, extra, changed or unsupported current files', () => {
  const fixture = baseline();
  expect(() =>
    previewCloudRuntimeChange({
      ...fixture,
      contents: { ...fixture.contents, 'extra.yaml': '{}' },
    }),
  ).toThrow('pinned base');
  const missing = { ...fixture.contents };
  delete missing['backend-service.yaml'];
  expect(() =>
    previewCloudRuntimeChange({ ...fixture, contents: missing }),
  ).toThrow('pinned base');
  expect(() =>
    previewCloudRuntimeChange({
      ...fixture,
      contents: { ...fixture.contents, 'frontend-service.yaml': '{}' },
    }),
  ).toThrow('pinned base');
  const unsafe = { ...fixture.contents };
  const service = JSON.parse(unsafe['backend-service.yaml']);
  service.spec.type = 'LoadBalancer';
  unsafe['backend-service.yaml'] = `${canonicalize(service)}\n`;
  const unsafeBase = {
    ...fixture.base,
    files: fixture.base.files.map(file =>
      file.name === 'backend-service.yaml'
        ? { ...file, sha256: sha256(unsafe[file.name]) }
        : file,
    ),
  };
  expect(() =>
    previewCloudRuntimeChange({
      ...fixture,
      base: unsafeBase,
      contents: unsafe,
    }),
  ).toThrow('Unsupported');
});

it('returns an explicit no-op preview without changing file bytes', () => {
  const fixture = baseline();
  const preview = previewCloudRuntimeChange({
    ...fixture,
    input: { ...fixture.input, patch: { backendReplicas: 1 } },
  });
  expect(preview.changedFields).toEqual([]);
  expect(
    preview.files.every(
      file => file.content === fixture.contents[basename(file.path)],
    ),
  ).toBe(true);
});
