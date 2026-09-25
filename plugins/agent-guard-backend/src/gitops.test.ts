import { normalizeGitopsRepoUrl } from './gitops';

it('accepts only the platform-configured demo GitOps repository shape', () => {
  expect(normalizeGitopsRepoUrl(undefined)).toBeUndefined();
  expect(
    normalizeGitopsRepoUrl(
      'github.com?repo=backstage-agent-guard-gitops&owner=yash',
    ),
  ).toBe('github.com?owner=yash&repo=backstage-agent-guard-gitops');
  for (const unsafe of [
    'github.com?owner=yash&repo=other',
    'github.com:443?owner=yash&repo=backstage-agent-guard-gitops',
    'person@github.com?owner=yash&repo=backstage-agent-guard-gitops',
    'github.com?owner=yash&repo=backstage-agent-guard-gitops&extra=yes',
    'example.com?owner=yash&repo=backstage-agent-guard-gitops',
    '%',
  ]) {
    expect(() => normalizeGitopsRepoUrl(unsafe)).toThrow();
  }
});
