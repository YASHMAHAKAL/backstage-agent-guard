import {
  applicationReviewPolicy,
  legacyReleasePolicy,
  legacyRuntimePolicy,
  reviewerGroupsForPolicy,
} from './cloudReviewPolicy';

it('does not widen historical review eligibility', () => {
  for (const version of [legacyReleasePolicy, legacyRuntimePolicy])
    expect(reviewerGroupsForPolicy(version)).toEqual([
      'group:default/platform-team',
    ]);
  expect(reviewerGroupsForPolicy(applicationReviewPolicy)).toEqual([
    'group:default/rizz-team',
    'group:default/platform-team',
  ]);
  expect(reviewerGroupsForPolicy('unknown')).toEqual([]);
});
