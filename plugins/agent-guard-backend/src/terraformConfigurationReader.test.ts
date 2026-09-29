import { GitHubTerraformConfigurationReader } from './terraformConfigurationReader';

const sha = 'a'.repeat(40);
const url = 'https://github.com/example/backstage-agent-guard/pull/12';
const pull = {
  number: 12,
  html_url: url,
  merged_at: '2026-09-29T10:00:00.000Z',
  merge_commit_sha: sha,
  changed_files: 1,
  user: { id: 1 },
  head: {
    sha: 'b'.repeat(40),
    repo: { id: 100, full_name: 'example/backstage-agent-guard' },
  },
  base: {
    ref: 'main',
    repo: { id: 100, full_name: 'example/backstage-agent-guard' },
  },
};
const review = {
  id: 2,
  user: { id: 2 },
  state: 'APPROVED',
  commit_id: pull.head.sha,
  submitted_at: '2026-09-29T09:00:00.000Z',
};
const files = [
  {
    filename: 'infra/aws/environments/staging/capacity.auto.tfvars.json',
    status: 'modified',
  },
];
function reader(
  override: {
    pull?: object;
    reviews?: object[];
    files?: object[];
    mainSha?: string;
  } = {},
) {
  const fetcher = jest.fn(async (requestUrl: string) => {
    let value: object | object[];
    if (requestUrl.includes('/git/ref/heads/main')) {
      value = {
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: override.mainSha ?? sha },
      };
    } else if (requestUrl.includes('/reviews?')) {
      value = override.reviews ?? [review];
    } else if (requestUrl.includes('/files?')) {
      value = override.files ?? files;
    } else {
      value = override.pull ?? pull;
    }
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return new GitHubTerraformConfigurationReader({
    owner: 'example',
    repo: 'backstage-agent-guard',
    token: 'test-token-not-live',
    fetcher: fetcher as typeof fetch,
  });
}
const check = {
  pullRequest: { url, mergedCommit: sha },
  sourceCommit: sha,
  root: 'staging' as const,
};

describe('GitHub Terraform configuration PR reader', () => {
  it('requires a reviewed in-repository PR merged to the bound commit', async () => {
    await expect(reader().verifyMergedReview(check)).resolves.toBe(true);
    await expect(
      reader({
        pull: { ...pull, merge_commit_sha: 'c'.repeat(40) },
      }).verifyMergedReview(check),
    ).resolves.toBe(false);
    await expect(
      reader({ pull: { ...pull, merged_at: null } }).verifyMergedReview(check),
    ).resolves.toBe(false);
    await expect(
      reader({ mainSha: 'c'.repeat(40) }).verifyMergedReview(check),
    ).resolves.toBe(false);
    await expect(
      reader({
        pull: {
          ...pull,
          head: { ...pull.head, repo: { id: 101, full_name: 'fork/repo' } },
        },
      }).verifyMergedReview(check),
    ).resolves.toBe(false);
  });

  it('rejects stale review, changed review state and out-of-root files', async () => {
    await expect(
      reader({
        reviews: [{ ...review, commit_id: 'c'.repeat(40) }],
      }).verifyMergedReview(check),
    ).resolves.toBe(false);
    await expect(
      reader({
        reviews: [
          review,
          {
            ...review,
            id: 3,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-09-29T09:30:00.000Z',
          },
        ],
      }).verifyMergedReview(check),
    ).resolves.toBe(false);
    await expect(
      reader({
        files: [
          { filename: 'infra/aws/registry/versions.tf', status: 'modified' },
        ],
      }).verifyMergedReview(check),
    ).resolves.toBe(false);
  });
});
