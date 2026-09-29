import { cloudTargetSchema } from '../cloudTarget';
import {
  CloudApprovalEnvelope,
  createCloudFrozenSnapshot,
} from '../cloudSnapshot';
import { ReleaseRecord, releaseDigest } from '../releases';
import { CloudProposalView } from '../services/CloudProposalService';

// Synthetic metadata/images only; never a live deployment or release source.
export function cloudDeliveryFixture(): CloudProposalView {
  const target = cloudTargetSchema.parse({
    id: 'eks-staging',
    accountId: '000000000000',
    region: 'us-east-1',
    clusterName: 'rizz-eks-staging',
    namespace: 'rizz-staging',
    owner: 'group:default/platform-team',
    sourceRepository: 'example/Rizz.AI',
    gitopsRepository: 'https://github.com/example/gitops.git',
    gitopsBranch: 'main',
    gitopsPath: 'clusters/eks-staging/apps/rizz-ai',
    argoApplication: 'rizz-ai-staging',
    ingress: {
      stage: 'ready',
      hostname: 'rizz-staging-demo-1234567890.us-east-1.elb.amazonaws.com',
      operatorCidr: '203.0.113.10/32',
      certificateArn:
        'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
      certificateSha256: `sha256:${'f'.repeat(64)}`,
    },
  });
  const commit = 'a'.repeat(40);
  const record: ReleaseRecord = {
    schemaVersion: 1,
    releaseId: `rizz-${commit}-100-1`,
    source: {
      repository: target.sourceRepository,
      ref: 'refs/heads/master',
      commit,
    },
    workflow: {
      path: '.github/workflows/publish.yml',
      runId: 100,
      runAttempt: 1,
    },
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-08T00:00:00Z',
    checks: {
      tests: 'passed',
      scan: 'passed',
      policyVersion: 'rizz-build-v1-high-critical',
    },
    images: {
      frontend: {
        repository: `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-frontend`,
        digest: `sha256:${'1'.repeat(64)}`,
        sourceCommit: commit,
      },
      backend: {
        repository: `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-backend`,
        digest: `sha256:${'2'.repeat(64)}`,
        sourceCommit: commit,
      },
    },
  };
  const id = '00000000-0000-4000-8000-000000000001';
  const requester = 'user:default/developer';
  const snapshot = createCloudFrozenSnapshot({
    now: Date.parse(record.createdAt),
    target,
    context: { proposalId: id, requester, submissionChannel: 'mcp_action' },
    proposal: {
      declaredIntent:
        'Deploy the paired Rizz.AI staging release, restricted public frontend and private backend.',
      templateId: 'deploy-rizz-ai',
      inputs: {
        targetId: target.id,
        releaseId: record.releaseId,
        releaseRecordDigest: releaseDigest(record),
        frontendReplicas: 1,
        backendReplicas: 2,
      },
    },
    release: { state: 'verified', record, recordDigest: releaseDigest(record) },
    gitopsBase: { revision: 'b'.repeat(40), files: [] },
  });
  return {
    id,
    version: 1,
    requester,
    status: 'pr_open',
    reasonCodes: [],
    semantic: { kind: 'unavailable', reason: 'fixture_only' },
    snapshot,
    currentState: { state: 'absent' },
    createdAt: record.createdAt,
    decision: {
      decision: 'approve',
      reviewer: 'user:default/reviewer',
      digest: snapshot.digest,
      at: record.createdAt,
    },
    execution: {
      state: 'pr_open',
      prNumber: 1,
      prUrl: 'https://github.com/example/gitops/pull/1',
    },
    audit: [],
    viewerPermissions: { canReview: false },
  };
}

export function releaseFixtureEnvelope(
  proposal: CloudProposalView,
): CloudApprovalEnvelope {
  const envelope = proposal.snapshot.envelope;
  if (envelope.kind !== 'rizz_cloud_release')
    throw new Error('Expected a release proposal fixture');
  return envelope;
}
