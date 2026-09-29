import { basename } from 'node:path';
import { cloudDeliveryFixture } from './testFixtures/cloudDeliveryFixture';
import { rollbackPreservesProtectedConfiguration } from './cloudRollback';

it('permits only image and replica restoration from a compatible recipe', () => {
  const snapshot = cloudDeliveryFixture().snapshot;
  const restored = snapshot.files;
  const gitopsPath = snapshot.envelope.target.gitopsPath;
  const current = Object.fromEntries(
    restored.map(file => [basename(file.path), file.content]),
  );
  const deployment = JSON.parse(current['backend-deployment.yaml']);
  deployment.spec.replicas = 1;
  deployment.spec.template.spec.containers[0].image =
    deployment.spec.template.spec.containers[0].image.replace(/.$/, 'f');
  current['backend-deployment.yaml'] = JSON.stringify(deployment);
  expect(
    rollbackPreservesProtectedConfiguration({ current, restored, gitopsPath }),
  ).toBe(true);
  const changedIngress = { ...current, 'ingress.yaml': '{}' };
  expect(
    rollbackPreservesProtectedConfiguration({
      current: changedIngress,
      restored,
      gitopsPath,
    }),
  ).toBe(false);
  const changedSecret = { ...current, 'external-secret.yaml': '{}' };
  expect(
    rollbackPreservesProtectedConfiguration({
      current: changedSecret,
      restored,
      gitopsPath,
    }),
  ).toBe(false);
  deployment.spec.template.spec.containers[0].env = [];
  expect(
    rollbackPreservesProtectedConfiguration({
      current: {
        ...current,
        'backend-deployment.yaml': JSON.stringify(deployment),
      },
      restored,
      gitopsPath,
    }),
  ).toBe(false);
});
