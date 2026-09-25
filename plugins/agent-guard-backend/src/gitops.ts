import { InputError } from '@backstage/errors';

// The repository is platform configuration, never an agent-supplied input.
export function normalizeGitopsRepoUrl(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!value.startsWith('github.com?')) {
    throw new InputError(
      'AGENT_GUARD_GITOPS_REPO_URL must use github.com?owner=<GitHub-owner>&repo=backstage-agent-guard-gitops',
    );
  }
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new InputError('Invalid AGENT_GUARD_GITOPS_REPO_URL');
  }
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');
  if (
    url.hostname !== 'github.com' ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash ||
    url.searchParams.size !== 2 ||
    !owner ||
    !/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
    repo !== 'backstage-agent-guard-gitops'
  ) {
    throw new InputError(
      'AGENT_GUARD_GITOPS_REPO_URL must be github.com?owner=<GitHub-owner>&repo=backstage-agent-guard-gitops',
    );
  }
  return `github.com?owner=${owner}&repo=${repo}`;
}
