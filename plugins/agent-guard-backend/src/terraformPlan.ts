import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v3';
import { canonicalize } from './snapshot';

const sha256 = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const planChange = z
  .object({
    address: z.string().min(1).max(300),
    type: z.string().regex(/^[a-z][a-z0-9_]{1,100}$/),
    change: z.object({
      actions: z
        .array(z.enum(['no-op', 'create', 'read', 'update', 'delete']))
        .min(1)
        .max(2),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  })
  .passthrough();
const planJson = z
  .object({
    format_version: z.string().regex(/^1\.[0-9]+$/),
    terraform_version: z.string().regex(/^1\.15\.[0-9]+$/),
    resource_changes: z.array(planChange).max(500).optional(),
  })
  .passthrough();
const nodeSize = (value: unknown): number | null => {
  const result = z
    .object({
      scaling_config: z.array(
        z.object({ desired_size: z.number().int().min(1).max(2) }),
      ),
    })
    .safeParse(value);
  return result.success && result.data.scaling_config.length === 1
    ? result.data.scaling_config[0].desired_size
    : null;
};

/** Raw Terraform plan JSON may contain secrets. Return only fixed, bounded
 * metadata and the approved node-count field; never forward before/after
 * objects, outputs, state or unknown attributes to browser, MCP or Jev. */
export function sanitizeTerraformPlan(raw: unknown) {
  const plan = planJson.parse(raw);
  const changes = (plan.resource_changes ?? []).map(resource => {
    const actions = resource.change.actions;
    const action =
      actions.includes('create') && actions.includes('delete')
        ? ('replace' as const)
        : actions[0];
    return {
      address: resource.address,
      type: resource.type,
      action,
      ...(resource.address === 'aws_eks_node_group.staging' &&
      resource.type === 'aws_eks_node_group'
        ? {
            workerDesiredSize: {
              before: nodeSize(resource.change.before),
              after: nodeSize(resource.change.after),
            },
          }
        : {}),
    };
  });
  const counts = {
    create: changes.filter(change => change.action === 'create').length,
    update: changes.filter(change => change.action === 'update').length,
    delete: changes.filter(change => change.action === 'delete').length,
    replace: changes.filter(change => change.action === 'replace').length,
    read: changes.filter(change => change.action === 'read').length,
  };
  return {
    terraformVersion: plan.terraform_version,
    counts,
    changes: changes.filter(change => change.action !== 'no-op'),
  };
}

export const terraformPlanBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal('rizz-terraform-v1'),
    requestId: z.string().uuid(),
    operation: z.enum([
      'foundation_setup',
      'capacity_change',
      'drift',
      'foundation_destroy',
    ]),
    root: z.enum(['registry', 'staging']),
    target: z.literal('rizz-ai-eks-staging'),
    accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.literal('us-east-1'),
    requester: z.string().regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/),
    sourceCommit: gitSha,
    providerLockDigest: digest,
    configDigest: digest,
    variablesDigest: digest,
    backendDigest: digest,
    planDigest: digest,
    stateLineage: z.string().uuid().nullable(),
    stateSerial: z.number().int().nonnegative().nullable(),
    terraformVersion: z.string().regex(/^1\.15\.[0-9]+$/),
    runnerId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    binding =>
      (binding.stateLineage === null) === (binding.stateSerial === null) &&
      Date.parse(binding.expiresAt) > Date.parse(binding.createdAt) &&
      Date.parse(binding.expiresAt) - Date.parse(binding.createdAt) <= 3600000,
    'Invalid state identity or plan lifetime',
  );
export type TerraformPlanBinding = z.infer<typeof terraformPlanBindingSchema>;

export function terraformBindingDigest(raw: unknown) {
  const binding = terraformPlanBindingSchema.parse(raw);
  return sha256(canonicalize(binding));
}

export const terraformPlanApprovalSchema = z
  .object({
    binding: terraformPlanBindingSchema,
    bindingDigest: digest,
    reviewer: z.string().regex(/^user:default\/[a-z0-9][a-z0-9_-]*$/),
    reviewedAt: z.string().datetime(),
    decision: z.literal('approve'),
  })
  .strict()
  .refine(
    approval =>
      approval.reviewer !== approval.binding.requester &&
      approval.bindingDigest === terraformBindingDigest(approval.binding) &&
      Date.parse(approval.reviewedAt) >=
        Date.parse(approval.binding.createdAt) &&
      Date.parse(approval.reviewedAt) < Date.parse(approval.binding.expiresAt),
    'Plan approval does not match its live binding',
  );

export type TerraformPlanApproval = z.infer<typeof terraformPlanApprovalSchema>;
export type SanitizedTerraformPlan = ReturnType<typeof sanitizeTerraformPlan>;

export const terraformPlanSummarySchema = z
  .object({
    terraformVersion: z.string().regex(/^1\.15\.[0-9]+$/),
    counts: z
      .object({
        create: z.number().int().nonnegative(),
        update: z.number().int().nonnegative(),
        delete: z.number().int().nonnegative(),
        replace: z.number().int().nonnegative(),
        read: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z
      .array(
        z
          .object({
            address: z.string().min(1).max(300),
            type: z.string().regex(/^[a-z][a-z0-9_]{1,100}$/),
            action: z.enum(['create', 'update', 'delete', 'replace', 'read']),
            workerDesiredSize: z
              .object({
                before: z.number().int().min(1).max(2).nullable(),
                after: z.number().int().min(1).max(2).nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .refine(
    summary =>
      (['create', 'update', 'delete', 'replace', 'read'] as const).every(
        action =>
          summary.counts[action] ===
          summary.changes.filter(change => change.action === action).length,
      ),
    'Terraform plan action counts do not match its changes',
  );

/** This is intentionally narrower than Terraform itself. A capacity request
 * cannot smuggle IAM, network or replacement changes into an approved plan.
 * Foundation setup/destroy still require their own inventory and reviewer
 * checks before a runner is enabled. */
export function assertTerraformPlanScope(
  binding: TerraformPlanBinding,
  summary: SanitizedTerraformPlan,
) {
  if (summary.terraformVersion !== binding.terraformVersion)
    throw new Error('Terraform version differs from the reviewed plan');
  if (binding.operation === 'capacity_change') {
    if (
      binding.root !== 'staging' ||
      summary.changes.length !== 1 ||
      summary.changes[0].address !== 'aws_eks_node_group.staging' ||
      summary.changes[0].type !== 'aws_eks_node_group' ||
      summary.changes[0].action !== 'update' ||
      summary.changes[0].workerDesiredSize?.before === null ||
      summary.changes[0].workerDesiredSize?.after === null ||
      summary.changes[0].workerDesiredSize?.before === undefined ||
      summary.changes[0].workerDesiredSize?.after === undefined ||
      summary.changes[0].workerDesiredSize.before ===
        summary.changes[0].workerDesiredSize.after
    )
      throw new Error('Capacity plan exceeds the reviewed node-count scope');
  } else if (binding.operation === 'foundation_setup') {
    if (
      !summary.changes.some(change => change.action === 'create') ||
      summary.changes.some(change =>
        ['delete', 'replace'].includes(change.action),
      )
    )
      throw new Error(
        'Foundation setup must create resources and cannot delete or replace',
      );
  } else if (binding.operation === 'foundation_destroy') {
    if (
      binding.root !== 'staging' ||
      summary.changes.length === 0 ||
      summary.changes.some(change => change.action !== 'delete')
    )
      throw new Error('Destroy plan may only delete staging resources');
  } else {
    throw new Error('Drift inspection has no executable plan approval');
  }
}

const receiptSchema = z
  .object({
    approval: terraformPlanApprovalSchema,
    signature: digest,
  })
  .strict();
export type TerraformApprovalReceipt = z.infer<typeof receiptSchema>;

/** Only the authenticated review service may issue a receipt. The signing key
 * must not be exposed to the browser, agent, PR job or plan artifact store. */
export function signTerraformApproval(
  approval: TerraformPlanApproval,
  key: Buffer,
): TerraformApprovalReceipt {
  const parsed = terraformPlanApprovalSchema.parse(approval);
  if (key.length < 32) throw new Error('Approval signing key is too short');
  return {
    approval: parsed,
    signature: `sha256:${createHmac('sha256', key)
      .update(canonicalize(parsed))
      .digest('hex')}`,
  };
}

/** Verify the exact receipt and current runner preconditions immediately
 * before execution. A separate durable single-use claim is also required;
 * this function cannot prove a receipt has not already been consumed. */
export function assertTerraformExecutionAuthorized(input: {
  receipt: unknown;
  signingKey: Buffer;
  expectedBinding: unknown;
  planBytes: Buffer;
  /** Output of `terraform show -json` against these exact saved-plan bytes. */
  renderedPlanJson: unknown;
  now: Date;
  reviewerStillPlatformMember: boolean;
  runnerId: string;
  actualAwsAccountId: string;
}) {
  const receipt = receiptSchema.parse(input.receipt);
  if (input.signingKey.length < 32)
    throw new Error('Approval signing key is too short');
  const expected = `sha256:${createHmac('sha256', input.signingKey)
    .update(canonicalize(receipt.approval))
    .digest('hex')}`;
  if (
    !timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(receipt.signature, 'utf8'),
    )
  )
    throw new Error('Approval receipt signature is invalid');
  const liveBinding = terraformPlanBindingSchema.parse(input.expectedBinding);
  const approved = receipt.approval.binding;
  if (terraformBindingDigest(liveBinding) !== receipt.approval.bindingDigest)
    throw new Error('The plan preconditions changed after approval');
  if (sha256(input.planBytes) !== approved.planDigest)
    throw new Error('The saved plan artifact changed after approval');
  assertTerraformPlanScope(
    approved,
    sanitizeTerraformPlan(input.renderedPlanJson),
  );
  if (input.now.getTime() >= Date.parse(approved.expiresAt))
    throw new Error('The plan approval expired');
  if (!input.reviewerStillPlatformMember)
    throw new Error('The reviewer is no longer an authorized platform member');
  if (input.runnerId !== approved.runnerId)
    throw new Error('The plan was approved for another runner');
  if (input.actualAwsAccountId !== approved.accountId)
    throw new Error('AWS account differs from the reviewed target');
  if (approved.operation === 'drift')
    throw new Error('Drift inspection cannot be applied');
  return receipt.approval;
}
