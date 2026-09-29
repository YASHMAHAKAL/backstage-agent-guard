import { z } from 'zod/v3';
import { releaseIdSchema } from './releases';

// A separate contract preserves historical local inputs and snapshot hashes.
// This is not registered with MCP, REST or Scaffolder until the cloud governance
// path is complete. Parsing does not authorize a target or verify a release.
export const cloudProposalInputSchema = z
  .object({
    declaredIntent: z.string().trim().min(12).max(1000),
    templateId: z.literal('deploy-rizz-ai'),
    inputs: z
      .object({
        releaseId: releaseIdSchema,
        // Pin the exact record selected in the release browser; no latest tag.
        releaseRecordDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        targetId: z.literal('eks-staging'),
        frontendReplicas: z.number().int().min(1).max(2),
        backendReplicas: z.number().int().min(1).max(2),
      })
      .strict(),
  })
  .strict();

export type CloudProposalInput = z.infer<typeof cloudProposalInputSchema>;
