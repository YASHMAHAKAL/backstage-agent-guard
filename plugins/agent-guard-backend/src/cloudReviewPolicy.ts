import { z } from 'zod/v3';

export const legacyReleasePolicy = 'rizz-staging-v1-distinct-platform-review';
export const legacyRuntimePolicy = 'rizz-runtime-v1-distinct-platform-review';
export const applicationReviewPolicy =
  'rizz-app-v2-distinct-app-or-platform-review';
export const retirementPolicyVersion =
  'rizz-retirement-v1-distinct-platform-review';
export const applicationReviewerGroups = [
  'group:default/rizz-team',
  'group:default/platform-team',
] as const;

export const cloudReviewerGroupsSchema = z
  .tuple([
    z.literal(applicationReviewerGroups[0]),
    z.literal(applicationReviewerGroups[1]),
  ])
  .optional();

export function reviewerGroupsForPolicy(policyVersion: string): string[] {
  if (policyVersion === applicationReviewPolicy)
    return [...applicationReviewerGroups];
  if (
    policyVersion === legacyReleasePolicy ||
    policyVersion === legacyRuntimePolicy ||
    policyVersion === retirementPolicyVersion
  )
    return [applicationReviewerGroups[1]];
  return [];
}

export function reviewPolicyFieldsValid(value: {
  policyVersion: string;
  reviewerGroups?: readonly string[];
}) {
  return value.policyVersion === applicationReviewPolicy
    ? JSON.stringify(value.reviewerGroups) ===
        JSON.stringify(applicationReviewerGroups)
    : value.reviewerGroups === undefined;
}
