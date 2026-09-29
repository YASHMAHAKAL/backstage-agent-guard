import {
  verifiedCloudDeployment,
  verifiedDeploymentSummary,
} from './cloudHistory';
import {
  cloudDeliveryFixture,
  releaseFixtureEnvelope,
} from './testFixtures/cloudDeliveryFixture';

function verifiedObservation() {
  return {
    checkedAt: '2026-09-28T10:00:00.000Z',
    github: { state: 'merged_files_match', revision: 'c'.repeat(40) },
    argoCd: { state: 'synced_files_match', revision: 'd'.repeat(40) },
    workloads: { state: 'verified' as const },
    smoke: { state: 'verified' as const },
    deployed: true,
  };
}

it('records only fully verified delivery with an exact approved snapshot', () => {
  const proposal = cloudDeliveryFixture();
  const record = verifiedCloudDeployment(proposal, verifiedObservation());
  expect(record).toMatchObject({
    proposalId: proposal.id,
    operation: 'rizz_cloud_release',
    snapshotDigest: proposal.snapshot.digest,
    mergeRevision: 'c'.repeat(40),
    frontendReplicas: 1,
    backendReplicas: 2,
    sourceRelease: {
      releaseId: releaseFixtureEnvelope(proposal).release.record.releaseId,
    },
  });
  expect(verifiedDeploymentSummary(record!)).not.toHaveProperty('snapshot');
  expect(proposal.snapshot.files).toHaveLength(9);
});

it('refuses open PRs, weak observations, changed approval and tampered files', () => {
  const base = cloudDeliveryFixture();
  const observation = verifiedObservation();
  for (const change of [
    (proposal: typeof base) => {
      proposal.status = 'pending_approval';
    },
    (proposal: typeof base) => {
      proposal.decision!.digest = `sha256:${'0'.repeat(64)}`;
    },
    (proposal: typeof base) => {
      proposal.snapshot.files[0].content += ' ';
    },
  ]) {
    const altered = structuredClone(base);
    change(altered);
    expect(verifiedCloudDeployment(altered, observation)).toBeUndefined();
  }
  expect(
    verifiedCloudDeployment(base, {
      ...observation,
      smoke: { state: 'unavailable' },
    }),
  ).toBeUndefined();
  expect(
    verifiedCloudDeployment(base, {
      ...observation,
      argoCd: { state: 'not_ready', revision: 'd'.repeat(40) },
    }),
  ).toBeUndefined();
});
