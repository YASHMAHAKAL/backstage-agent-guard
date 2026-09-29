import { CloudDeliveryObservation } from './cloudDelivery';
import { cloudSnapshotHasIntegrity } from './cloudSnapshot';
import { cloudRuntimeSnapshotHasIntegrity } from './cloudRuntimeSnapshot';
import { CloudProposalView } from './services/CloudProposalService';

const commit = /^[a-f0-9]{40}$/;

/** An immutable first-success record. A CI release alone is not deployment
 * history; all independent merge, Argo, rollout and smoke checks must pass. */
export function verifiedCloudDeployment(
  proposal: CloudProposalView,
  observed: CloudDeliveryObservation,
) {
  const snapshot = proposal.snapshot;
  if (
    proposal.status !== 'pr_open' ||
    !(
      cloudRuntimeSnapshotHasIntegrity(snapshot) ||
      cloudSnapshotHasIntegrity(snapshot)
    ) ||
    snapshot.envelope.proposalId !== proposal.id ||
    snapshot.envelope.requester !== proposal.requester ||
    proposal.decision?.decision !== 'approve' ||
    proposal.decision.reviewer === proposal.requester ||
    proposal.decision.digest !== snapshot.digest ||
    !proposal.execution?.prUrl ||
    !observed.deployed ||
    observed.github.state !== 'merged_files_match' ||
    !observed.github.revision ||
    !commit.test(observed.github.revision) ||
    observed.argoCd.state !== 'synced_files_match' ||
    !observed.argoCd.revision ||
    !commit.test(observed.argoCd.revision) ||
    observed.workloads.state !== 'verified' ||
    observed.smoke.state !== 'verified' ||
    !Number.isFinite(Date.parse(observed.checkedAt))
  )
    return undefined;

  const state =
    snapshot.envelope.kind === 'rizz_cloud_runtime_change'
      ? snapshot.envelope.after
      : {
          frontendImage: `${snapshot.envelope.release.record.images.frontend.repository}@${snapshot.envelope.release.record.images.frontend.digest}`,
          backendImage: `${snapshot.envelope.release.record.images.backend.repository}@${snapshot.envelope.release.record.images.backend.digest}`,
          frontendReplicas: snapshot.envelope.inputs.frontendReplicas,
          backendReplicas: snapshot.envelope.inputs.backendReplicas,
        };
  return {
    proposalId: proposal.id,
    operation: snapshot.envelope.kind,
    targetId: snapshot.envelope.target.id,
    snapshotDigest: snapshot.digest,
    requester: proposal.requester,
    reviewer: proposal.decision.reviewer,
    verifiedAt: observed.checkedAt,
    mergeRevision: observed.github.revision,
    argoRevision: observed.argoCd.revision,
    prUrl: proposal.execution.prUrl,
    frontendImage: state.frontendImage,
    backendImage: state.backendImage,
    frontendReplicas: state.frontendReplicas,
    backendReplicas: state.backendReplicas,
    sourceRelease:
      snapshot.envelope.kind !== 'rizz_cloud_runtime_change'
        ? {
            releaseId: snapshot.envelope.inputs.releaseId,
            recordDigest: snapshot.envelope.release.recordDigest,
          }
        : undefined,
    snapshot,
  };
}

export type CloudVerifiedDeployment = NonNullable<
  ReturnType<typeof verifiedCloudDeployment>
>;
export type CloudVerifiedDeploymentSummary = Omit<
  CloudVerifiedDeployment,
  'snapshot'
>;

export function verifiedDeploymentSummary(
  record: CloudVerifiedDeployment,
): CloudVerifiedDeploymentSummary {
  const { snapshot: _snapshot, ...summary } = record;
  return summary;
}
