import { z } from 'zod/v3';

const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);

export const proposalActionSchema = z
  .object({
    declaredIntent: z.string().trim().min(12).max(1000),
    templateId: z.enum(['nodejs-api', 'fastapi-api', 'scheduled-worker']),
    inputs: z
      .object({
        serviceName: slug,
        requestedOwner: z
          .string()
          .regex(/^group:default\/[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
        environment: z.literal('staging'),
        description: z.string().trim().min(3).max(500),
        // APIs may request a small, reviewable replica count. This is a hard
        // platform limit, not an advisory Jev decision.
        replicas: z.number().int().min(1).max(2).optional(),
        schedule: z.string().trim().min(9).max(100).optional(),
      })
      .strict(),
  })
  .strict();

export const proposalInputSchema = proposalActionSchema.superRefine(
  (value, context) => {
    const hasSchedule = value.inputs.schedule !== undefined;
    if (value.templateId === 'scheduled-worker' && !hasSchedule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputs', 'schedule'],
        message: 'A scheduled worker requires a schedule',
      });
    }
    if (value.templateId !== 'scheduled-worker' && hasSchedule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputs', 'schedule'],
        message: 'API templates do not accept a schedule',
      });
    }
    if (
      value.templateId === 'scheduled-worker' &&
      value.inputs.replicas !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputs', 'replicas'],
        message: 'A scheduled worker does not accept Deployment replicas',
      });
    }
    if (
      hasSchedule &&
      !/^([*0-9,/\-]+\s+){4}[*0-9,/\-]+$/.test(value.inputs.schedule!)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputs', 'schedule'],
        message: 'Use a five-field cron schedule',
      });
    }
  })
  .transform(value =>
    value.templateId === 'scheduled-worker'
      ? value
      : {
          ...value,
          inputs: { ...value.inputs, replicas: value.inputs.replicas ?? 1 },
        },
  );

export type ProposalInput = z.infer<typeof proposalInputSchema>;

export const semanticChoices = [
  'aligned',
  'wrong_template',
  'scope_expansion',
  'contradiction',
  'insufficient_context',
] as const;

export type SemanticChoice = (typeof semanticChoices)[number];

export type SemanticResult =
  | {
      kind: 'evaluated';
      model: string;
      choice: SemanticChoice;
      choiceConfidence: number;
      choiceProbabilities: Record<string, number>;
      noul: number;
      score: number;
      scoreProbabilities: Record<string, number>;
      scoreLegend: Record<string, string>;
    }
  | { kind: 'unavailable'; reason: string };

export type ProposalStatus =
  | 'needs_clarification'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'scaffolding'
  | 'render_complete'
  | 'publishing'
  | 'pr_open'
  | 'publish_failed'
  | 'execution_failed';
// requester_confirmation is retained only to recognize legacy stored records;
// newly submitted proposals always need a distinct owner-group reviewer.
export type ReviewLane = 'requester_confirmation' | 'owner_review' | null;

export const proposalDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    comment: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ProposalDecisionInput = z.infer<typeof proposalDecisionSchema>;

export function decideReview(input: {
  semantic: SemanticResult;
  owner: string;
  ownershipEntityRefs: string[];
}): {
  status: ProposalStatus;
  reviewLane: ReviewLane;
  reasonCodes: string[];
} {
  if (input.semantic.kind === 'unavailable') {
    return {
      status: 'needs_clarification',
      reviewLane: null,
      reasonCodes: ['semantic_check_unavailable'],
    };
  }
  if (input.semantic.choice !== 'aligned') {
    return {
      status: 'needs_clarification',
      reviewLane: null,
      reasonCodes: [`semantic_${input.semantic.choice}`],
    };
  }
  if (
    input.semantic.choiceConfidence < 0.65 ||
    input.semantic.noul < 0.5 ||
    input.semantic.score > 1.5
  ) {
    return {
      status: 'needs_clarification',
      reviewLane: null,
      reasonCodes: ['semantic_signals_conflict_or_uncertain'],
    };
  }
  return {
    status: 'pending_approval',
    reviewLane: 'owner_review',
    reasonCodes: [
      'staging_write_requires_human_review',
      'distinct_owner_reviewer_required',
    ],
  };
}
