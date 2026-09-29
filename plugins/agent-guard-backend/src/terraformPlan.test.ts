import { createHash } from 'node:crypto';
import {
  assertTerraformExecutionAuthorized,
  assertTerraformPlanScope,
  signTerraformApproval,
  terraformBindingDigest,
} from './terraformPlan';

const planBytes = Buffer.from('private Terraform saved plan');
const planDigest = `sha256:${createHash('sha256')
  .update(planBytes)
  .digest('hex')}`;
const key = Buffer.alloc(32, 8);
const renderedPlanJson = {
  format_version: '1.2',
  terraform_version: '1.15.8',
  resource_changes: [
    {
      address: 'aws_ecr_repository.app["backend"]',
      type: 'aws_ecr_repository',
      change: {
        actions: ['create'],
        before: null,
        after: { secret: 'private' },
      },
    },
  ],
};
const binding = {
  schemaVersion: 1 as const,
  policyVersion: 'rizz-terraform-v1' as const,
  requestId: '8fdf4b5b-911d-4c2d-a2e7-92d164759f1c',
  operation: 'foundation_setup' as const,
  root: 'registry' as const,
  target: 'rizz-ai-eks-staging' as const,
  accountId: '000000000000',
  region: 'us-east-1' as const,
  requester: 'user:default/requester',
  sourceCommit: 'a'.repeat(40),
  providerLockDigest: `sha256:${'1'.repeat(64)}`,
  configDigest: `sha256:${'2'.repeat(64)}`,
  variablesDigest: `sha256:${'3'.repeat(64)}`,
  backendDigest: `sha256:${'4'.repeat(64)}`,
  planDigest,
  stateLineage: null,
  stateSerial: null,
  terraformVersion: '1.15.8',
  runnerId: 'terraform-runner-staging',
  createdAt: '2026-09-29T10:00:00.000Z',
  expiresAt: '2026-09-29T10:30:00.000Z',
};
const receipt = signTerraformApproval(
  {
    binding,
    bindingDigest: terraformBindingDigest(binding),
    reviewer: 'user:default/reviewer',
    reviewedAt: '2026-09-29T10:05:00.000Z',
    decision: 'approve',
  },
  key,
);
const input = {
  receipt,
  signingKey: key,
  expectedBinding: binding,
  planBytes,
  renderedPlanJson,
  now: new Date('2026-09-29T10:10:00.000Z'),
  reviewerStillPlatformMember: true,
  runnerId: 'terraform-runner-staging',
  actualAwsAccountId: '000000000000',
};

describe('exact Terraform saved-plan execution gate', () => {
  it('accepts the exact signed first-state plan and never exposes raw values', () => {
    expect(assertTerraformExecutionAuthorized(input).bindingDigest).toBe(
      terraformBindingDigest(binding),
    );
  });

  it.each([
    [{ planBytes: Buffer.from('swapped') }, 'artifact changed'],
    [
      {
        expectedBinding: {
          ...binding,
          stateSerial: 1,
          stateLineage: binding.requestId,
        },
      },
      'preconditions changed',
    ],
    [
      {
        expectedBinding: {
          ...binding,
          configDigest: `sha256:${'9'.repeat(64)}`,
        },
      },
      'preconditions changed',
    ],
    [{ reviewerStillPlatformMember: false }, 'reviewer is no longer'],
    [{ runnerId: 'different-runner' }, 'another runner'],
    [{ actualAwsAccountId: '999999999999' }, 'AWS account differs'],
    [{ now: new Date('2026-09-29T10:30:00.000Z') }, 'expired'],
  ])('rejects a changed execution precondition', (change, reason) => {
    expect(() =>
      assertTerraformExecutionAuthorized({ ...input, ...change }),
    ).toThrow(reason);
  });

  it('rejects deletes or replacements in foundation setup', () => {
    expect(() =>
      assertTerraformPlanScope(binding, {
        terraformVersion: '1.15.8',
        counts: { create: 0, update: 0, delete: 1, replace: 0, read: 0 },
        changes: [
          {
            address: 'aws_ecr_repository.app["backend"]',
            type: 'aws_ecr_repository',
            action: 'delete',
          },
        ],
      }),
    ).toThrow('cannot delete or replace');
  });

  it('does not call an update-only plan a foundation setup', () => {
    expect(() =>
      assertTerraformPlanScope(binding, {
        terraformVersion: '1.15.8',
        counts: { create: 0, update: 1, delete: 0, replace: 0, read: 0 },
        changes: [
          {
            address: 'aws_ecr_repository.app["backend"]',
            type: 'aws_ecr_repository',
            action: 'update',
          },
        ],
      }),
    ).toThrow('must create resources');
  });
});
